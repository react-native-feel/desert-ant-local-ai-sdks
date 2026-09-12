// The model handle. One instance owns one loaded set of Core ML programs, so an
// app creates it once and reuses it: the first load after a download specializes
// the graph for the Neural Engine (~20 s, once per install), and every load after
// that reads that cache in ~0.2 s.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `VozModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// VozModule.swift.

import ExpoModulesCore
import DesertAnt
import Foundation
import Voz

// `@unchecked Sendable` so the progress handlers -- `@Sendable` closures the Swift
// SDK invokes from its own tasks -- can capture `self`. What they touch is a
// `let` and a lock-guarded gate, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("VozModel")
final class VozModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  private let directory: String?
  private let loader: VozLoader
  private let progressGate = ProgressGate()

  /// Emitted while `download`, `load` and the two transcribe calls run. Throttled
  /// to ~20 Hz -- the model reports far more often than a progress bar can use.
  @Event
  var onProgress: (VozProgressEvent) -> Void

  init(directory: String?) {
    self.directory = directory
    self.loader = VozLoader(directory: directory)
    super.init()
  }

  /// Whether the weights are on the device, so a transcribe needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    Voz.isDownloaded(directory: directory)
  }

  // MARK: - Work (driven by VozModule)

  /// Fetch the weights without loading them.
  ///
  /// Kept separate from `load` because the two costs are separate and an app
  /// wants to show them differently: this is ~490 MB over the network, and `load`
  /// is the ~20 s Neural Engine specialization that follows it.
  func download(jobId: String) async throws {
    do {
      _ = try await Voz.download(directory: directory) { [weak self] progress in
        self?.report(jobId, phase: "loadingModel", fraction: progress.fraction)
      }
    } catch {
      throw Self.mapped(error, fallback: { ModelUnavailableException($0) })
    }
  }

  /// Download if needed, then build the Core ML session.
  func load(jobId: String) async throws {
    _ = try await voz(jobId: jobId)
  }

  /// Transcribe a file.
  ///
  /// The primary API, and unlike Clear's equivalent there is no container to be
  /// careful about: upstream reads this through `FileAudioStream` (an
  /// `AVAudioFile` plus a stateful `AVAudioConverter`, in Sources/Voz), not
  /// through the `Sources/Clear/Streaming.swift` pass that SIGSEGVs on AAC. An
  /// `.m4a` straight out of expo-audio goes through the same code path a WAV
  /// does, a chunk at a time, so peak memory does not grow with the recording.
  func transcribeFile(path: String, jobId: String) async throws -> VozTranscript {
    guard FileManager.default.fileExists(atPath: path) else {
      throw AudioDecodeFailedException("no file at \(path)")
    }
    let model = try await voz(jobId: jobId)
    do {
      let result = try await model.transcribe(path: path) { [weak self] progress in
        self?.report(jobId, phase: "transcribing", fraction: progress.fractionCompleted)
      }
      return vozTranscript(from: result)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  /// Transcribe mono samples the caller already holds.
  ///
  /// `samples` is read off the JavaScript typed array by `VozModule` *before* the
  /// first suspension and handed over as `[Float]`; see the note there.
  func transcribeSamples(
    _ samples: [Float],
    sampleRate: Double,
    jobId: String
  ) async throws -> VozTranscript {
    guard !samples.isEmpty else {
      throw InvalidSamplesException("the sample buffer is empty")
    }
    guard sampleRate > 0 else {
      throw InvalidSamplesException("'\(sampleRate)' is not a sample rate")
    }
    let model = try await voz(jobId: jobId)
    do {
      // The rate-taking overload resamples to the model's own rate when they
      // differ, so a caller never has to know what that rate is.
      let result = try await model.transcribe(samples: samples, sampleRate: sampleRate) {
        [weak self] progress in
        self?.report(jobId, phase: "transcribing", fraction: progress.fractionCompleted)
      }
      return vozTranscript(from: result)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  // MARK: - Loading

  /// The loaded model, loading it (and downloading first, if needed) on the way.
  private func voz(jobId: String) async throws -> Voz {
    do {
      return try await loader.voz { [weak self] progress in
        self?.report(jobId, phase: "loadingModel", fraction: progress.fraction)
      }
    } catch {
      throw Self.mapped(error, fallback: { ModelLoadFailedException($0) })
    }
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  ///
  /// `VozError` is the only typed one upstream throws; anything else (a URLSession
  /// failure inside the download, a Core ML load failure) falls through to the
  /// caller's own default, which is why `fallback` is a parameter rather than a
  /// fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let vozError = error as? VozError {
      switch vozError {
      case .unsupportedPlatform:
        return UnsupportedPlatformException(vozError.description)
      case .invalidModel(let detail):
        return ModelLoadFailedException(detail)
      case .invalidAudio(let detail):
        return AudioDecodeFailedException(detail)
      }
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
      self?.onProgress(VozProgressEvent(jobId: jobId, phase: phase, fraction: fraction))
    }
  }
}

/// Owns the one loaded `Voz` and makes sure only one load is ever in flight.
///
/// An actor rather than a lock because the thing being guarded is asynchronous:
/// `Voz.init` downloads ~490 MB and then specializes the graph, and two
/// transcribe calls arriving together must not both start it. The second caller
/// awaits the first's `Task` and gets the same model.
///
/// The cost of sharing that task is that the second caller's `progress` closure
/// never fires -- the work is already running under the first one's. It still
/// waits for the same completion, so a progress bar stalls at whatever it last
/// showed rather than reporting wrong numbers.
private actor VozLoader {
  private let directory: String?
  private var loaded: Voz?
  private var loading: Task<Voz, Error>?

  init(directory: String?) {
    self.directory = directory
  }

  func voz(progress: @escaping @Sendable (DownloadProgress) -> Void) async throws -> Voz {
    if let loaded {
      return loaded
    }
    if let loading {
      return try await loading.value
    }
    let directory = self.directory
    let task = Task { try await Voz(directory: directory, progress: progress) }
    loading = task
    defer { loading = nil }
    let model = try await task.value
    loaded = model
    return model
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per chunk. Phase changes and the terminal `1.0` always pass.
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
