// The model handle. One instance owns one loaded Core ML session pool, so an app
// creates it once and reuses it: the first-ever load pays the ANE compile
// (~3.4 s on an iPhone 16 Pro), every later one is ~62 ms from cache.

import ExpoModulesCore
import Clear
import Foundation

// `@unchecked Sendable` so the model's progress handler -- a `@Sendable` closure
// the Swift SDK invokes from its own task group -- can capture `self`. What it
// touches is a `let` and a lock-guarded gate, so the guarantee is real; the
// compiler just cannot see it through `SharedObject`.
@SharedObject("ClearModel")
final class ClearModelObject: SharedObject, @unchecked Sendable {
  private let clear: Clear
  private let progressGate = ProgressGate()

  /// Emitted while `download`, `enhanceFile` and `enhanceBuffer` run. Throttled
  /// to ~20 Hz -- the model reports per chunk, which is far more often than a
  /// progress bar can use.
  @Event
  var onProgress: (ClearProgressEvent) -> Void

  @JS
  init(options: ClearLoadOptions) throws {
    guard let variant = ModelVariant(rawValue: options.variant) else {
      throw InvalidVariantException(options.variant)
    }
    self.clear = Clear(directory: options.directory, variant: variant)
    super.init()
  }

  /// Whether the weights are on the device, so `enhance` needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    clear.isDownloaded()
  }

  /// Fetch the weights ahead of time so the first enhance is not also a download.
  /// A no-op once available.
  @JS
  @JavaScriptActor
  func download(_ jobId: String) async throws {
    do {
      try await clear.download { [weak self] fraction in
        self?.report(jobId, phase: "loadingModel", fraction: fraction)
      }
    } catch {
      throw ModelUnavailableException(String(describing: error))
    }
  }

  /// Build the session now, downloading first if needed, so the first enhance
  /// pays neither. On the first-ever launch this is where the Core ML compile
  /// happens; call it behind a splash screen or on a background screen.
  @JS
  @JavaScriptActor
  func load(_ jobId: String) async throws {
    do {
      try await clear.load { [weak self] progress in
        self?.report(jobId, phase: "loadingModel", fraction: progress.fraction)
      }
    } catch {
      throw ModelLoadFailedException(String(describing: error))
    }
  }

  /// Decode `inputPath`, enhance it, and write the result to `outputPath`.
  ///
  /// This is the primary API. It runs the Swift SDK's streaming path, so peak
  /// memory stays flat instead of growing with the file, and no audio crosses the
  /// JS boundary at all. The output encoding follows `outputPath`'s extension:
  /// `.wav` is 16-bit PCM, `.m4a`/`.mp4`/`.aac` is AAC, `.caf`/`.aiff` is PCM,
  /// anything else is WAV.
  ///
  /// The returned metrics carry no samples -- the audio is the file.
  @JS
  @JavaScriptActor
  func enhanceFile(
    _ inputPath: String,
    _ outputPath: String,
    _ options: ClearEnhanceOptions,
    _ jobId: String
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
      return clearMetrics(from: result)
    } catch {
      throw InferenceFailedException(String(describing: error))
    }
  }

  /// Enhance samples already in memory, returning a new buffer to drain.
  ///
  /// Second-class next to `enhanceFile`: it exists for audio an app synthesized
  /// or already holds, and it pays a copy in each direction. See ClearAudio.swift.
  @JS
  @JavaScriptActor
  func enhanceBuffer(
    _ input: ClearAudioObject,
    _ options: ClearEnhanceOptions,
    _ jobId: String
  ) async throws -> ClearAudioObject {
    let resolved = try options.resolved()
    let channels = input.channels
    guard let first = channels.first, !first.isEmpty else {
      throw AudioDecodeFailedException("the input buffer is empty")
    }
    do {
      let result = try await clear.enhance(
        channels: channels,
        sampleRate: input.sampleRate,
        options: resolved,
        progress: { [weak self] progress in
          self?.report(jobId, phase: Self.name(of: progress.phase), fraction: progress.fraction)
        }
      )
      return ClearAudioObject(result: result)
    } catch {
      throw InferenceFailedException(String(describing: error))
    }
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
