// The model handle. One instance owns one loaded Core ML program plus the tiny
// SoundAnalysis labeller head beside it, so an app creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `UhmModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// UhmModule.swift.

import DesertAnt
import ExpoModulesCore
import Foundation
import Uhm

// `@unchecked Sendable` so the progress handlers -- `@Sendable` closures the Swift
// SDK invokes from its own tasks -- can capture `self`. What they touch is a
// `let` and a lock-guarded gate, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("UhmModel")
final class UhmModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Whether this build can run Uhm at all.
  ///
  /// Reads the catalog rather than answering `true`: `UhmModel.files` is the
  /// upstream statement of which platforms have an artifact, and on Apple it does
  /// have one. Unlike Clips there is no second, OS-level check to make -- Uhm
  /// declares no `osFloor` above the package's, and `uhm.mlmodelc` is an ordinary
  /// Core ML package rather than a multifunction one, so nothing can load on a
  /// device the pod's own deployment target already allows.
  static var isSupported: Bool { UhmModel.supports(.current) }

  private let uhm: Uhm
  private let progressGate = ProgressGate()

  /// Emitted while the model loads and while a detection runs. Throttled to
  /// ~20 Hz -- the detector reports per window, which on a long recording is far
  /// more often than a progress bar can use.
  @Event
  var onProgress: (UhmProgressEvent) -> Void

  init(directory: String?, computeUnits: ComputeUnits) {
    // Construction does no work and starts no download; the model loads on the
    // first `load` or `analyze`, off the calling thread.
    self.uhm = Uhm(directory: directory, computeUnits: computeUnits)
    super.init()
  }

  /// Whether the weights are on the device, so an analysis needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    uhm.isDownloaded()
  }

  // MARK: - Work (driven by UhmModule)

  /// Download the weights and build the session.
  ///
  /// One call rather than two, because upstream fuses them: `Uhm.download` runs
  /// the whole loader -- resolve the files, then build the Core ML session --
  /// reporting a fraction across the download and 1 while it prepares. There is
  /// no download-only entry point to expose, so `warm()` and `download()` in
  /// TypeScript both land here.
  func load(jobId: String) async throws {
    do {
      try await uhm.download { [weak self] fraction in
        self?.report(jobId, phase: "loadingModel", fraction: fraction)
      }
    } catch {
      throw Self.mapped(error, fallback: { ModelUnavailableException($0) })
    }
  }

  /// Find the fillers in a file.
  ///
  /// The file is decoded by upstream's `AudioIO` to mono 16 kHz -- anything
  /// AVFoundation reads, including the audio track of a video -- so an `.m4a`
  /// straight out of expo-audio needs no conversion here.
  ///
  /// `load` is called explicitly first even though `Uhm.analyze` would load
  /// lazily anyway, and it is not belt-and-braces. Upstream's lazy load happens
  /// *inside* `analyze`, so a failed download would come back out of the same
  /// call as an inference failure and be reported as `ERR_INFERENCE_FAILED` --
  /// a caller offering "retry the download" would never see the case it exists
  /// for. Loading first gives the two failures their own codes. It costs nothing
  /// once loaded: the loader single-flights and returns its cached value.
  func analyzeFile(
    path: String,
    options: UhmAnalyzeOptions,
    jobId: String
  ) async throws -> UhmResult {
    guard FileManager.default.fileExists(atPath: path) else {
      throw AudioDecodeFailedException("no file at \(path)")
    }
    let resolved = try options.resolved()
    try await load(jobId: jobId)
    return try await measured {
      try await uhm.analyze(audioPath: path, options: resolved) { [weak self] fraction in
        self?.report(jobId, phase: "detecting", fraction: fraction)
      }
    }
  }

  /// Find the fillers in mono samples the caller already holds.
  ///
  /// `samples` is read off the JavaScript typed array by `UhmModule` *before* the
  /// first suspension and handed over as `[Float]`; see the note there.
  func analyzeSamples(
    _ samples: [Float],
    sampleRate: Double,
    options: UhmAnalyzeOptions,
    jobId: String
  ) async throws -> UhmResult {
    guard !samples.isEmpty else {
      throw InvalidSamplesException("the sample buffer is empty")
    }
    guard sampleRate > 0 else {
      throw InvalidSamplesException("'\(sampleRate)' is not a sample rate")
    }
    let resolved = try options.resolved()
    try await load(jobId: jobId)
    return try await measured {
      // The rate-taking overload resamples to the model's own 16 kHz when they
      // differ, so a caller never has to know what that rate is.
      try await uhm.analyze(
        samples: samples, sampleRate: Int(sampleRate.rounded()), options: resolved
      ) { [weak self] fraction in
        self?.report(jobId, phase: "detecting", fraction: fraction)
      }
    }
  }

  /// Time one analysis and shape its result.
  ///
  /// Wall clock rather than the sum of `phaseTimings`, deliberately: the phases
  /// account for the work, and the difference between them and this is the
  /// download or session build that a first call pays and a second does not.
  /// Reporting the sum would hide exactly the cost a caller is trying to see.
  private func measured(
    _ work: () async throws -> Uhm.Result
  ) async throws -> UhmResult {
    let started = ContinuousClock.now
    do {
      let result = try await work()
      let components = started.duration(to: .now).components
      let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
      return uhmResult(from: result, processingSec: seconds)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  ///
  /// `UhmError` is the only typed one upstream throws from this path; anything
  /// else (a URLSession failure inside the download, a Core ML load failure, an
  /// `AudioIO` decode error) falls through to the caller's own default, which is
  /// why `fallback` is a parameter rather than a fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let uhmError = error as? UhmError {
      switch uhmError {
      case .modelMissing(let name):
        return ModelUnavailableException(name)
      case .inferenceFailed(let detail):
        return InferenceFailedException(detail)
      }
    }
    if error is CancellationError {
      return InferenceFailedException("cancelled")
    }
    return fallback(String(describing: error))
  }

  // MARK: - Progress

  /// Called from whatever context the work is on, so it hops to the JavaScript
  /// actor before touching the event.
  private func report(_ jobId: String, phase: String, fraction: Double) {
    guard progressGate.shouldEmit(phase: phase, fraction: fraction) else {
      return
    }
    Task { @JavaScriptActor [weak self] in
      self?.onProgress(UhmProgressEvent(jobId: jobId, phase: phase, fraction: fraction))
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
  private var results: [String: UhmResult] = [:]

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an asynchronous one, and holding it across an `await` is
  /// what that rule exists to prevent.
  func stash(_ value: UhmResult, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    results[jobId] = value
  }

  /// Hand over the result computed for `jobId`, and forget it.
  ///
  /// Synchronous, and that is the point rather than an optimization: a
  /// synchronous `@JS` member's return value is encoded inside the host call, on
  /// the JavaScript thread, by construction. The asynchronous half returns
  /// `Void` so that nothing is encoded on the cooperative pool. See the note on
  /// `takeResult` in the module.
  @JS
  func takeResult(_ jobId: String) throws -> UhmResult {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let value = results.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no result is waiting for job \(jobId)")
    }
    return value
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per window. Phase changes and the terminal `1.0` always
/// pass.
private final class ProgressGate: @unchecked Sendable {
  private let lock = NSLock()
  private var lastPhase = ""
  private var lastEmit = Date.distantPast

  private static let interval: TimeInterval = 0.05

  func shouldEmit(phase: String, fraction: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let now = Date()
    let changedPhase = phase != lastPhase
    if changedPhase || fraction >= 1 || now.timeIntervalSince(lastEmit) >= Self.interval {
      lastPhase = phase
      lastEmit = now
      return true
    }
    return false
  }
}
