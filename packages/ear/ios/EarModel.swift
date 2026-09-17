// The model handle. One instance owns one loaded Core ML program, so an app
// creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `EarModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// EarModule.swift.

import DesertAnt
import Ear
import ExpoModulesCore
import Foundation

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the
// Swift SDK invokes from its own tasks -- can capture `self`. What it touches is
// a `let` and a lock-guarded gate, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("EarModel")
final class EarModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Whether this build can run Ear at all.
  ///
  /// Reads the catalog rather than answering `true`: `EarModel.files` is the
  /// upstream statement of which platforms have an artifact, and on Apple it
  /// does. Unlike Clips there is no second, OS-level check to make -- Ear
  /// declares no `osFloor` above the package's and `Sources/Ear` carries no
  /// `@available`, so `ear.mlmodelc` loads anywhere the pod's own deployment
  /// target already allows.
  static var isSupported: Bool { EarModel.supports(.current) }

  private let ear: Ear
  private let progressGate = ProgressGate()

  /// The model's language list, cached once `loadLanguages` has run.
  ///
  /// It exists so the list can be *read* synchronously. See `languages()` for the
  /// reason that matters, which is not caching.
  private let languagesLock = NSLock()
  private var cachedLanguages: [String] = []

  /// Emitted while the model downloads and loads, and at no other time.
  /// Identification reports nothing: upstream's `identify` takes no handler.
  @Event
  var onProgress: (EarProgressEvent) -> Void

  init(directory: String?) {
    // Construction does no work and starts no download; the model loads on the
    // first `load` or `identify`, off the calling thread.
    self.ear = Ear(directory: directory)
    super.init()
  }

  /// Whether the weights are on the device, so an identification needs no
  /// network. Synchronous: it is a filesystem check, and a UI wants it during
  /// render.
  @JS
  func isDownloaded() -> Bool {
    ear.isDownloaded()
  }

  // MARK: - Work (driven by EarModule)

  /// Download the weights and build the session.
  ///
  /// One call rather than two, because upstream fuses them: `Ear.download` runs
  /// the whole loader -- resolve the files, then build the Core ML session --
  /// reporting a fraction across the download. There is no download-only entry
  /// point to expose, so `warm()` and `download()` in TypeScript both land here.
  /// `reportProgress` is false where no caller asked for it. Emitting an event
  /// into a JavaScript object nobody subscribed to is not free and not safe: the
  /// hop to the JavaScript actor outlives the call that queued it, and the record
  /// is encoded against whatever the runtime holds by then. `supportedLanguages`
  /// loads for its own reasons and has no progress bar behind it, so it does not
  /// arm one.
  func load(jobId: String, reportProgress: Bool = true) async throws {
    do {
      try await ear.download { [weak self] fraction in
        guard reportProgress else { return }
        self?.report(jobId, fraction: fraction)
      }
    } catch {
      throw Self.mapped(error, fallback: { ModelUnavailableException($0) })
    }
  }

  /// Name the language of the audio (or video) file at `path`.
  ///
  /// Decoded by upstream's `AudioIO` -- anything AVFoundation reads, including
  /// the audio track of a video -- and downmixed and resampled to the model's own
  /// rate on the way in, so an `.m4a` straight out of expo-audio needs no
  /// conversion here.
  ///
  /// `load` is called explicitly first even though `Ear.identify` would load
  /// lazily anyway, and it is not belt-and-braces. Upstream's lazy load happens
  /// *inside* `identify`, so a failed download would come back out of the same
  /// call as an inference failure and be reported as `ERR_INFERENCE_FAILED` -- a
  /// caller offering "retry the download" would never see the case it exists for.
  /// Loading first gives the two failures their own codes. It costs nothing once
  /// loaded: the loader single-flights and returns its cached value.
  func identifyFile(
    path: String,
    options: EarIdentifyOptions,
    jobId: String
  ) async throws -> EarDetection {
    guard FileManager.default.fileExists(atPath: path) else {
      throw AudioDecodeFailedException("no file at \(path)")
    }
    let windows = try options.resolvedWindows()
    try await load(jobId: jobId)
    return try await measured {
      try await ear.identify(path: path, windows: windows)
    }
  }

  /// Name the language of mono samples the caller already holds.
  ///
  /// `samples` is read off the JavaScript typed array by `EarModule` *before* the
  /// first suspension and handed over as `[Float]`; see the note there.
  func identifySamples(
    _ samples: [Float],
    sampleRate: Double,
    options: EarIdentifyOptions,
    jobId: String
  ) async throws -> EarDetection {
    guard !samples.isEmpty else {
      throw InvalidSamplesException("the sample buffer is empty")
    }
    guard sampleRate > 0 else {
      throw InvalidSamplesException("'\(sampleRate)' is not a sample rate")
    }
    let windows = try options.resolvedWindows()
    try await load(jobId: jobId)
    return try await measured {
      // The rate-taking overload resamples to the model's own 16 kHz when they
      // differ, so a caller never has to know what that rate is.
      try await ear.identify(samples: samples, sampleRate: sampleRate, windows: windows)
    }
  }

  /// Fetch the model's language list and hold it, returning nothing.
  ///
  /// Split into a load that returns `Void` and a synchronous `languages()` that
  /// returns the array, which is not a caching decision -- it is the fix for a
  /// crash, and the fourth Expo Modules 2.0 limit this repo has had to design
  /// around.
  ///
  /// A `@JS async` function returning `[String]` encodes its result **off the
  /// JavaScript thread**. The crash is a segfault inside
  /// `Array<String>.encode(_:in:)` on `com.apple.root.user-initiated-qos.cooperative`
  /// rather than on `com.facebook.react.runtime.JavaScript`, and `@JavaScriptActor`
  /// on the function does not prevent it -- the return value is encoded after the
  /// actor hop the annotation governs. It is a race, so it survives a first call
  /// and a second and then takes the process down; worse, the damage it does to
  /// the Hermes runtime surfaces later and elsewhere, which is why the first
  /// symptom seen here was a crash inside an unrelated progress event.
  ///
  /// Returning `Void` from the async half removes the encode entirely, and a
  /// synchronous `@JS` member runs on the JavaScript thread by construction, so
  /// the array is encoded where it must be. Every other asynchronous call in this
  /// package -- `identifyFile`, `identifySamples` -- now has the same shape, with
  /// `takeDetection` as its synchronous half: "records encode through `toObject`
  /// instead" was exposure rather than immunity, and Clear's crash reports name
  /// `Record.encode` and `ClearMetrics.toObject` directly.
  ///
  /// It is also only half the defect. The same generated closure destroys the
  /// call's *arguments* on the same wrong thread, which no return type can help
  /// with; `onJavaScriptThread` in EarModule.swift is the other half. See
  /// docs/architecture.md, limit 4.
  ///
  /// Loads first for the same reason the identify paths do: the list is a sidecar
  /// that comes down with the weights, so asking for it on a cold model is a
  /// download, and a download that fails should say so with its own code.
  func loadLanguages(jobId: String) async throws {
    try await load(jobId: jobId, reportProgress: false)
    do {
      store(languages: try await ear.supportedLanguages())
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an async one, and the alternative -- holding it across the
  /// `await` above -- is what that rule exists to prevent.
  private func store(languages: [String]) {
    languagesLock.lock()
    defer { languagesLock.unlock() }
    cachedLanguages = languages
  }

  /// The language list fetched by `loadLanguages`, or empty before it has run.
  ///
  /// Synchronous so the `[String]` is encoded on the JavaScript thread. See
  /// `loadLanguages` for why that is load-bearing rather than incidental.
  @JS
  func languages() -> [String] {
    languagesLock.lock()
    defer { languagesLock.unlock() }
    return cachedLanguages
  }

  /// Time one identification and shape its result.
  ///
  /// Wall clock rather than anything upstream reports, because upstream reports
  /// nothing: `Detection` carries candidates and a window count and no timing at
  /// all. The number therefore includes the decode on the file path, and on a
  /// first call it also includes the download and session build that `load` just
  /// did -- which is the cost a caller is usually trying to see.
  private func measured(
    _ work: () async throws -> Detection
  ) async throws -> EarDetection {
    let started = ContinuousClock.now
    do {
      let detection = try await work()
      let components = started.duration(to: .now).components
      let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
      return earDetection(from: detection, processingSec: seconds)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  ///
  /// `EarError` is the only typed one upstream throws from this path; anything
  /// else (a URLSession failure inside the download, a Core ML load failure)
  /// falls through to the caller's own default, which is why `fallback` is a
  /// parameter rather than a fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let earError = error as? EarError {
      switch earError {
      case .modelNotFound:
        return ModelUnavailableException("an Ear model resource was not found")
      case .invalidModel(let detail):
        return ModelLoadFailedException(detail)
      case .invalidAudio(let detail):
        // Upstream raises this both for a file it could not decode and for a
        // buffer the caller should not have sent. The decode case is the one a
        // caller can act on differently, and it is the one that names a path.
        return detail.contains("decoded to no audio")
          ? AudioDecodeFailedException(detail)
          : InvalidSamplesException(detail)
      case .predictionFailed:
        return InferenceFailedException("on-device language identification failed")
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
        EarProgressEvent(jobId: jobId, phase: "loadingModel", fraction: fraction))
    }
  }

  // MARK: - Results waiting to be collected

  /// Results waiting to be handed over, keyed by the job that produced them.
  ///
  /// Keyed rather than a single slot so two concurrent calls on one model cannot
  /// take each other's answer -- the same reason every entry point in this family
  /// carries a job id. Entries are removed on read, so nothing accumulates; a job
  /// whose caller threw before reading leaves one behind, which dies with the
  /// model.
  private let resultsLock = NSLock()
  private var detections: [String: EarDetection] = [:]

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an asynchronous one, and holding it across an `await` is
  /// what that rule exists to prevent.
  func stash(_ value: EarDetection, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    detections[jobId] = value
  }

  /// Hand over the result computed for `jobId`, and forget it.
  ///
  /// Synchronous, and that is the point rather than an optimization: a
  /// synchronous `@JS` member's return value is encoded inside the host call, on
  /// the JavaScript thread, by construction. The asynchronous half returns
  /// `Void` so that nothing is encoded on the cooperative pool. See the note on
  /// `takeDetection` in the module.
  @JS
  func takeDetection(_ jobId: String) throws -> EarDetection {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let value = detections.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no result is waiting for job \(jobId)")
    }
    return value
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per chunk. The terminal `1.0` always passes.
///
/// Simpler than Uhm's gate of the same name because there is only ever one phase
/// to be in: an Ear emits `loadingModel` and nothing else.
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
