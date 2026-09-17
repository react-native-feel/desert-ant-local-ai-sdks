// The model handle. One instance owns one loaded Core ML program, so an app
// creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `RedactModule`
// exposes these as module-level `@JS async` functions; see the note at the top
// of RedactModule.swift.

import DesertAnt
import ExpoModulesCore
import Foundation
import Redact

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the
// Swift SDK invokes from its own tasks -- can capture `self`. What it touches is
// a `let` and lock-guarded state, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("RedactModel")
final class RedactModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Whether this build can run Redact at all.
  ///
  /// Reads the catalog rather than answering `true`: `RedactModel.files` is the
  /// upstream statement of which platforms have an artifact, and on Apple it
  /// does. Like Ear and Gist and unlike Clips there is no second, OS-level check
  /// to make -- Redact declares no `osFloor` above the package's and
  /// `Sources/Redact` carries no `@available`, so `redact.mlmodelc` loads
  /// anywhere the pod's own deployment target already allows.
  static var isSupported: Bool { RedactModel.supports(.current) }

  private let redact: Redact
  private let progressGate = ProgressGate()

  /// Results waiting to be handed over, keyed by the job that produced them.
  ///
  /// Keyed rather than a single slot so two concurrent `redaction` calls on one
  /// model cannot take each other's answer -- the same reason every entry point
  /// in this family carries a job id. Entries are removed on read, so nothing
  /// accumulates.
  ///
  /// Worth one extra sentence for this model: what is sitting in this dictionary
  /// is the caller's personal data, in the clear. It is removed the moment it is
  /// read, and the whole dictionary dies with the model, which `release()`
  /// makes immediate rather than eventual.
  private let resultsLock = NSLock()
  private var redactions: [String: RedactRedaction] = [:]

  /// Emitted while the model downloads and loads, and at no other time.
  /// Redaction reports nothing: upstream's `redaction(of:)` takes no handler.
  @Event
  var onProgress: (RedactProgressEvent) -> Void

  init(directory: String?) {
    // Construction does no work and starts no download; the model loads on the
    // first `load` or `redaction`, off the calling thread.
    self.redact = Redact(directory: directory)
    super.init()
  }

  /// Whether the weights are on the device, so redaction needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    redact.isDownloaded()
  }

  // MARK: - Work (driven by RedactModule)

  /// Download the weights and build the session.
  ///
  /// One call rather than two, because upstream fuses them: `Redact.download`
  /// runs the whole loader -- resolve the files, then build the Core ML session
  /// -- reporting a fraction across the download. There is no download-only
  /// entry point to expose, so `warm()` and `download()` in TypeScript both land
  /// here.
  ///
  /// The failure is classified rather than assumed, because both stages throw
  /// out of the same call and they are different problems for a caller: a
  /// download that failed is worth a retry button, a session that refused to
  /// build is not. The files being on disk afterwards is what separates them.
  func load(jobId: String) async throws {
    do {
      try await redact.download { [weak self] fraction in
        self?.report(jobId, fraction: fraction)
      }
    } catch {
      let downloaded = redact.isDownloaded()
      throw Self.mapped(
        error,
        fallback: { downloaded ? ModelLoadFailedException($0) : ModelUnavailableException($0) })
    }
  }

  /// Redact `text`, and store the result for `jobId` rather than returning it.
  ///
  /// Returning nothing is the point, and it is the fourth Expo Modules 2.0 limit
  /// this repo has had to design around rather than a caching decision.
  ///
  /// **A `@JS async` function's return value can be encoded off the JavaScript
  /// thread.** The crash is a segfault on
  /// `com.apple.root.user-initiated-qos.cooperative` rather than on
  /// `com.facebook.react.runtime.JavaScript`, and `@JavaScriptActor` on the
  /// function does not prevent it -- the return value is encoded after the actor
  /// hop the annotation governs. Ear hit it returning `[String]`, Clear through
  /// `Record.encode`, Emo through `JavaScriptValuesBuffer.deinit` on an array of
  /// records; the downstream symptom is `HadesGC::youngGenCollection` killing the
  /// process later and blaming nothing. Four sites, so "small values are safe" is
  /// not a reading anyone should still be holding.
  ///
  /// A redaction is three strings and three numbers per detection, and a
  /// paragraph of contact details carries a dozen detections, so this is on the
  /// large end of what this family returns. The general rule the architecture
  /// doc draws from those crashes applies without any judgement about how many
  /// records is too many: split "do the work" from "hand the result over". The
  /// async half returns `Void`; `takeRedaction` is synchronous and so runs on the
  /// JavaScript thread by construction.
  ///
  /// `load` is called explicitly first even though `Redact.redaction` would load
  /// lazily anyway, and it is not belt-and-braces. Upstream's lazy load happens
  /// *inside* the call, so a failed download would come back out of the same call
  /// as an inference failure and be reported as `ERR_INFERENCE_FAILED` -- a
  /// caller offering "retry the download" would never see the case it exists for.
  /// It costs nothing once loaded: the loader single-flights and returns its
  /// cached value.
  func redaction(text: String, options: RedactRedactionOptions, jobId: String) async throws {
    let resolved = Options(
      minimumConfidence: try options.resolvedConfidence(),
      labels: try options.resolvedLabels())

    // Blank text is an answer, not an error, and not a download.
    //
    // Neither upstream SDK guards this -- unlike Gist, where Kotlin does and
    // Swift does not, there is no disagreement to settle here, so this is
    // straightforwardly a decision of this package's. It is a safe one: the
    // deterministic recognizers match nothing in whitespace and the tagger has no
    // token to label, so the answer is provably the text itself with no items.
    // What it buys is that a text field wired straight to `redaction` costs
    // nothing while it is empty, including on a device that has never downloaded
    // the weights -- which for this model is the ordinary way to use it, since
    // the interesting case is redacting as someone types.
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      store(redactPassthrough(text), for: jobId)
      return
    }

    try await load(jobId: jobId)
    let started = ContinuousClock.now
    do {
      let result = try await redact.redaction(of: text, options: resolved)
      store(
        redactRedaction(from: result, in: text, processingSec: Self.elapsed(since: started)),
        for: jobId)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  // MARK: - Handing results over

  /// The redaction computed for `jobId`, removed as it is read.
  ///
  /// Synchronous so the record is encoded on the JavaScript thread. See
  /// `redaction` for why that is load-bearing rather than incidental.
  @JS
  func takeRedaction(_ jobId: String) throws -> RedactRedaction {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let redaction = redactions.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no redaction is waiting for job \(jobId)")
    }
    return redaction
  }

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an async one, and holding it across an `await` is what that
  /// rule exists to prevent.
  private func store(_ redaction: RedactRedaction, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    redactions[jobId] = redaction
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
  /// `RedactError` is the only typed one upstream throws from this path, and it
  /// has exactly two cases; anything else (a URLSession failure inside the
  /// download, a Core ML load failure) falls through to the caller's own default,
  /// which is why `fallback` is a parameter rather than a fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let redactError = error as? RedactError {
      switch redactError {
      case .resourceMissing:
        return ModelUnavailableException("a Redact model resource was not found")
      case .predictionFailed:
        return InferenceFailedException("on-device PII detection failed")
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
        RedactProgressEvent(jobId: jobId, phase: "loadingModel", fraction: fraction))
    }
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per chunk. The terminal `1.0` always passes.
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
