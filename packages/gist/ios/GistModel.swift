// The model handle. One instance owns one loaded Core ML program and one chosen
// variant, so an app creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `GistModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// GistModule.swift.

import DesertAnt
import Gist
import ExpoModulesCore
import Foundation

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the
// Swift SDK invokes from its own tasks -- can capture `self`. What it touches is
// a `let` and lock-guarded state, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("GistModel")
final class GistModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Whether this build can run Gist at all.
  ///
  /// Reads the catalog rather than answering `true`: `GistModel.files` is the
  /// upstream statement of which platforms have an artifact, and on Apple it
  /// does. Like Ear and unlike Clips there is no second, OS-level check to make
  /// -- Gist declares no `osFloor` above the package's and `Sources/Gist` carries
  /// no `@available`, so `gist.mlmodelc` loads anywhere the pod's own deployment
  /// target already allows.
  static var isSupported: Bool { GistModel.supports(.current) }

  let variant: GistVariant

  private let gist: Gist
  private let progressGate = ProgressGate()

  /// Results waiting to be handed over, keyed by the job that produced them.
  ///
  /// Keyed rather than a single slot so two concurrent `classify` calls on one
  /// model cannot take each other's answer -- the same reason every entry point
  /// in this family carries a job id. Entries are removed on read, so nothing
  /// accumulates; a job whose caller threw before reading leaves one behind,
  /// which is a record of a few hundred bytes and dies with the model.
  private let resultsLock = NSLock()
  private var taggings: [String: GistTagging] = [:]
  private var distributions: [String: GistDistribution] = [:]

  /// Emitted while the model downloads and loads, and at no other time. Tagging
  /// reports nothing: upstream's `classify` and `scores` take no handler.
  @Event
  var onProgress: (GistProgressEvent) -> Void

  init(variant: GistVariant, directory: String?) {
    // Construction does no work and starts no download; the model loads on the
    // first `load`, `classify` or `scores`, off the calling thread.
    self.variant = variant
    self.gist = Gist(variant: variant, directory: directory)
    super.init()
  }

  /// Whether the weights are on the device, so tagging needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render --
  /// which matters more here than for the small models, because the answer
  /// decides whether to offer a ~74 MB download.
  @JS
  func isDownloaded() -> Bool {
    gist.isDownloaded()
  }

  // MARK: - Work (driven by GistModule)

  /// Download the weights and build the session.
  ///
  /// One call rather than two, because upstream fuses them: `Gist.download` runs
  /// the whole loader -- resolve the files, then build the Core ML session --
  /// reporting a fraction across the download. There is no download-only entry
  /// point to expose, so `warm()` and `download()` in TypeScript both land here.
  ///
  /// The failure is classified rather than assumed, because both stages throw out
  /// of the same call and they are different problems for a caller: a download
  /// that failed is worth a retry button, a session that refused to build is not.
  /// The files being on disk afterwards is what separates them.
  func load(jobId: String) async throws {
    do {
      try await gist.download { [weak self] fraction in
        self?.report(jobId, fraction: fraction)
      }
    } catch {
      let downloaded = gist.isDownloaded()
      throw Self.mapped(
        error,
        fallback: { downloaded ? ModelLoadFailedException($0) : ModelUnavailableException($0) })
    }
  }

  /// Tag `text`, and store the result for `jobId` rather than returning it.
  ///
  /// Returning nothing is the point, and it is the fourth Expo Modules 2.0 limit
  /// this repo has had to design around rather than a caching decision.
  ///
  /// **A `@JS async` function's return value can be encoded off the JavaScript
  /// thread.** The crash is a segfault on
  /// `com.apple.root.user-initiated-qos.cooperative` rather than on
  /// `com.facebook.react.runtime.JavaScript`, and `@JavaScriptActor` on the
  /// function does not prevent it -- the return value is encoded after the actor
  /// hop the annotation governs. Ear hit it returning `[String]`; the same run
  /// found Clear hitting it through `Record.encode`, so "arrays of primitives
  /// only" is the wrong reading. It is a race, so it survives a first call and a
  /// second and then takes the process down, and the damage it does to the Hermes
  /// runtime surfaces later and elsewhere.
  ///
  /// Gist returns the largest results in this family -- `scores` is the whole
  /// 36-topic taxonomy -- so the general rule the architecture doc draws from
  /// those two crashes applies here without any judgement about how many records
  /// is too many: split "do the work" from "hand the result over". The async half
  /// returns `Void`; `takeTagging` is synchronous and so runs on the JavaScript
  /// thread by construction.
  ///
  /// `load` is called explicitly first even though `Gist.classify` would load
  /// lazily anyway, and it is not belt-and-braces. Upstream's lazy load happens
  /// *inside* `classify`, so a failed download would come back out of the same
  /// call as an inference failure and be reported as `ERR_INFERENCE_FAILED` -- a
  /// caller offering "retry the download" would never see the case it exists for.
  /// It costs nothing once loaded: the loader single-flights and returns its
  /// cached value.
  func classify(text: String, options: GistClassifyOptions, jobId: String) async throws {
    let topK = try options.resolvedTopK()
    let threshold = try options.resolvedThreshold()

    // Blank text is an answer, not an error, and not a download.
    //
    // This is the one place the two upstream SDKs disagree and this package picks
    // a side. `ai.desertant:gist` returns an empty list for blank input before it
    // touches the model; `Sources/Gist` has no such guard, so a blank string runs
    // the head over an all-zero feature vector and -- because `classify` always
    // returns its top topic -- comes back naming a topic with nothing behind it.
    // Kotlin's behaviour is the honest one, so it is the one both platforms get
    // here. Returning early also means a text field wired straight to `classify`
    // costs nothing while it is empty, including on a device that has never
    // downloaded the weights.
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      store(tagging: gistTagging(from: [], threshold: threshold, variant: variant, processingSec: 0),
            for: jobId)
      return
    }

    try await load(jobId: jobId)
    let started = ContinuousClock.now
    do {
      let topics = try await gist.classify(text, topK: topK, threshold: threshold)
      // The override is echoed back and nothing is invented when there is none:
      // upstream keeps the tuned value behind an `internal` property on both
      // platforms. See `GistTagging.threshold`.
      store(
        tagging: gistTagging(
          from: topics, threshold: threshold, variant: variant,
          processingSec: Self.elapsed(since: started)),
        for: jobId)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  /// The full 36-topic distribution for `text`, stored for `jobId`.
  ///
  /// Same split, same reason -- and this is the call that made the split
  /// unarguable rather than merely prudent: what it hands over is every topic in
  /// the taxonomy.
  func scores(text: String, jobId: String) async throws {
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      store(distribution: gistDistribution(from: [:], variant: variant, processingSec: 0),
            for: jobId)
      return
    }
    try await load(jobId: jobId)
    let started = ContinuousClock.now
    do {
      let scores = try await gist.scores(of: text)
      store(
        distribution: gistDistribution(
          from: scores, variant: variant, processingSec: Self.elapsed(since: started)),
        for: jobId)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  // MARK: - Handing results over

  /// The tagging `classify` computed for `jobId`, removed as it is read.
  ///
  /// Synchronous so the record is encoded on the JavaScript thread. See
  /// `classify` for why that is load-bearing rather than incidental.
  @JS
  func takeTagging(_ jobId: String) throws -> GistTagging {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let tagging = taggings.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no tagging is waiting for job \(jobId)")
    }
    return tagging
  }

  /// The distribution `scores` computed for `jobId`, removed as it is read.
  @JS
  func takeDistribution(_ jobId: String) throws -> GistDistribution {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let distribution = distributions.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no distribution is waiting for job \(jobId)")
    }
    return distribution
  }

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an async one, and holding it across an `await` is what that
  /// rule exists to prevent.
  private func store(tagging: GistTagging, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    taggings[jobId] = tagging
  }

  private func store(distribution: GistDistribution, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    distributions[jobId] = distribution
  }

  // MARK: - Helpers

  private static func elapsed(since started: ContinuousClock.Instant) -> Double {
    let components = started.duration(to: .now).components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  ///
  /// `GistError` is the only typed one upstream throws from this path, and it has
  /// exactly two cases; anything else (a URLSession failure inside the download,
  /// a Core ML load failure) falls through to the caller's own default, which is
  /// why `fallback` is a parameter rather than a fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let gistError = error as? GistError {
      switch gistError {
      case .modelNotFound:
        return ModelUnavailableException("a Gist model resource was not found")
      case .predictionFailed:
        return InferenceFailedException("on-device topic tagging failed")
      }
    }
    if error is CancellationError {
      return InferenceFailedException("cancelled")
    }
    return fallback(String(describing: error))
  }

  // MARK: - Progress

  /// Called from whatever context the download is on, so it hops to the
  /// JavaScript actor before touching the event.
  private func report(_ jobId: String, fraction: Double) {
    guard progressGate.shouldEmit(fraction: fraction) else {
      return
    }
    Task { @JavaScriptActor [weak self] in
      self?.onProgress(
        GistProgressEvent(jobId: jobId, phase: "loadingModel", fraction: fraction))
    }
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per chunk. The terminal `1.0` always passes.
///
/// It earns its keep here more than in Ear or Emo: the default build is ~74 MB,
/// so there are a great many fractions on the way to it.
private final class ProgressGate: @unchecked Sendable {
  private let lock = NSLock()
  private var lastEmit = Date.distantPast

  private static let interval: TimeInterval = 0.05

  func shouldEmit(fraction: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let now = Date()
    if fraction >= 1 || now.timeIntervalSince(lastEmit) >= Self.interval {
      lastEmit = now
      return true
    }
    return false
  }
}
