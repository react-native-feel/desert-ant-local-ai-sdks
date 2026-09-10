// The model handle. One instance owns one loaded Core ML session pool, so an app
// creates it once and reuses it: the first-ever load pays the ANE compile
// (~3.4 s on an iPhone 16 Pro), every later one is ~62 ms from cache.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `ClearModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// ClearModule.swift.

import ExpoModulesCore
import Clear
import Foundation

// `@unchecked Sendable` so the model's progress handler -- a `@Sendable` closure
// the Swift SDK invokes from its own task group -- can capture `self`. What it
// touches is a `let` and a lock-guarded gate, so the guarantee is real; the
// compiler just cannot see it through `SharedObject`.
@SharedObject("ClearModel")
final class ClearModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  private let clear: Clear
  let variant: ModelVariant
  private let progressGate = ProgressGate()
  private let pending = PendingOutputs()

  /// Emitted while `download`, `enhanceFile` and `enhanceBuffer` run. Throttled
  /// to ~20 Hz -- the model reports per chunk, which is far more often than a
  /// progress bar can use.
  @Event
  var onProgress: (ClearProgressEvent) -> Void

  init(directory: String?, variant: ModelVariant) {
    self.clear = Clear(directory: directory, variant: variant)
    self.variant = variant
    super.init()
  }

  /// Whether the weights are on the device, so `enhance` needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    clear.isDownloaded()
  }

  // MARK: - Work (driven by ClearModule)

  func download(jobId: String) async throws {
    do {
      try await clear.download { [weak self] fraction in
        self?.report(jobId, phase: "loadingModel", fraction: fraction)
      }
    } catch {
      throw ModelUnavailableException(String(describing: error))
    }
  }

  func load(jobId: String) async throws {
    do {
      try await clear.load { [weak self] progress in
        self?.report(jobId, phase: "loadingModel", fraction: progress.fraction)
      }
    } catch {
      throw ModelLoadFailedException(String(describing: error))
    }
  }

  func enhanceFile(
    inputPath: String,
    outputPath: String,
    options: ClearEnhanceOptions,
    jobId: String
  ) async throws -> ClearMetrics {
    let resolved = try options.resolved()
    guard FileManager.default.fileExists(atPath: inputPath) else {
      throw AudioDecodeFailedException("no file at \(inputPath)")
    }
    do {
      let result = try await clear.enhance(
        path: inputPath,
        to: outputPath,
        options: resolved,
        progress: { [weak self] progress in
          self?.report(jobId, phase: Self.name(of: progress.phase), fraction: progress.fraction)
        }
      )
      return clearMetrics(from: result, variant: variant)
    } catch {
      throw InferenceFailedException(String(describing: error))
    }
  }

  /// Returns a plain value type, not a `ClearAudioObject`.
  ///
  /// Returning a `SharedObject` from a `@JS async` function segfaults the app on
  /// device (expo-modules-core 57): the same object returned from a *synchronous*
  /// `@JS` function -- `createAudio` -- converts fine, so the async return path
  /// is the difference. `Clear.Result` is `Sendable`, so `ClearModule` builds and
  /// stashes the shared object on the JavaScript actor and JS picks it up with a
  /// second, synchronous call.
  func enhance(
    channels: [[Float]],
    sampleRate: Double,
    options: ClearEnhanceOptions,
    jobId: String
  ) async throws -> Clear.Result {
    let resolved = try options.resolved()
    guard let first = channels.first, !first.isEmpty else {
      throw AudioDecodeFailedException("the input buffer is empty")
    }
    do {
      return try await clear.enhance(
        channels: channels,
        sampleRate: sampleRate,
        options: resolved,
        progress: { [weak self] progress in
          self?.report(jobId, phase: Self.name(of: progress.phase), fraction: progress.fraction)
        }
      )
    } catch {
      throw InferenceFailedException(String(describing: error))
    }
  }

  /// Hold an enhanced buffer until JavaScript collects it, keyed by the job that
  /// produced it so concurrent calls cannot take each other's output.
  func stash(_ audio: ClearAudioObject, for jobId: String) {
    pending.put(audio, for: jobId)
  }

  func takeStashed(_ jobId: String) throws -> ClearAudioObject {
    guard let audio = pending.take(jobId) else {
      throw MissingOutputException(jobId)
    }
    return audio
  }

  // MARK: - Progress

  private static func name(of phase: Clear.Phase) -> String {
    switch phase {
    case .loadingModel: return "loadingModel"
    case .analyzing: return "analyzing"
    case .enhancing: return "enhancing"
    }
  }

  /// Called from whatever context the model's work is on -- chunks run across a
  /// task group -- so it hops to the JavaScript actor before touching the event.
  private func report(_ jobId: String, phase: String, fraction: Double) {
    guard progressGate.shouldEmit(phase: phase, fraction: fraction) else {
      return
    }
    Task { @JavaScriptActor [weak self] in
      self?.onProgress(ClearProgressEvent(jobId: jobId, phase: phase, fraction: fraction))
    }
  }
}

/// Enhanced buffers waiting to be collected. Lock-guarded rather than actor
/// isolated so a synchronous `@JS` function can drain it without hopping.
private final class PendingOutputs: @unchecked Sendable {
  private let lock = NSLock()
  private var outputs: [String: ClearAudioObject] = [:]

  func put(_ audio: ClearAudioObject, for jobId: String) {
    lock.lock()
    defer { lock.unlock() }
    outputs[jobId] = audio
  }

  func take(_ jobId: String) -> ClearAudioObject? {
    lock.lock()
    defer { lock.unlock() }
    return outputs.removeValue(forKey: jobId)
  }
}

/// Rate-limits progress so a per-chunk callback does not become a per-chunk hop
/// onto the JavaScript thread. Phase changes and the terminal `1.0` always pass.
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
