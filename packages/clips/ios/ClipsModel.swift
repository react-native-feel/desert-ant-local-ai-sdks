// The model handle. One instance owns one loaded pair of Core ML graphs -- the
// per-sentence selector and the per-span scorer, which live in one multifunction
// package -- so an app creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `ClipsModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// ClipsModule.swift.

import Clips
import DesertAnt
import ExpoModulesCore
import Foundation
import Transcript

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the
// Swift SDK invokes from its own task -- can capture `self`. What it touches is a
// `let` and a lock-guarded gate, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("ClipsModel")
final class ClipsModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Whether this device can run the model at all.
  ///
  /// A real check, not a constant. `clips.mlmodelc` is a MULTIFUNCTION Core ML
  /// package and multifunction is an iOS 18 feature, which `ClipModel` declares
  /// as `OSFloor.multifunction` -- and **nothing upstream enforces that
  /// declaration**. Without this an iOS 17 device would reach an opaque Core ML
  /// load failure after a 288 MB download instead of a legible refusal before it.
  static var isSupported: Bool {
    ClipModel.supports(.current) && ClipModel.osFloor.isSatisfiedHere
  }

  /// A sentence a developer can act on, or nil when the model can run here.
  static var unsupportedReason: String? {
    guard ClipModel.supports(.current) else {
      return "desert-ant-core ships no Clips artifact for this platform"
    }
    return ClipModel.osFloor.unmetReason("Clips")
  }

  private let clips: Clips
  private let progressGate = ProgressGate()

  /// Emitted while the model downloads and builds. Throttled to ~20 Hz.
  @Event
  var onProgress: (ClipsProgressEvent) -> Void

  init(directory: String?, computeUnits: ComputeUnits) {
    // Construction does no work and starts no download; the model loads on the
    // first `load` or `find`, off the calling thread.
    self.clips = Clips(directory: directory, computeUnits: computeUnits)
    super.init()
  }

  /// Whether the weights are on the device, so `find` needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    clips.isDownloaded()
  }

  // MARK: - Work (driven by ClipsModule)

  /// Download the weights and build the session.
  ///
  /// One call rather than two, because upstream fuses them: `Clips.download`
  /// runs the whole loader and reports a fraction for the downloading phase,
  /// mapping the build to 1. There is no download-only entry point to expose, so
  /// `warm()` and `download()` in TypeScript both land here.
  func load(jobId: String) async throws {
    do {
      try await clips.download { [weak self] fraction in
        self?.report(jobId, fraction: fraction)
      }
    } catch {
      throw Self.mapped(error, fallback: { ModelUnavailableException($0) })
    }
  }

  /// Select the best non-overlapping moments.
  ///
  /// Two things happen here that JavaScript does not see. The model is given
  /// only the sentence *texts* -- that is upstream's whole input -- and the times
  /// are used afterwards, by `Clip.ranges(in:padding:)`, to turn the selected
  /// sentences into spans of audio. Keeping both halves on this side means the
  /// rule for where a cut goes has exactly one definition.
  func find(
    sentences: [ClipsSentence],
    options: ClipsFindOptions,
    jobId: String
  ) async throws -> [ClipsClip] {
    let transcript = sentences.enumerated().map { $0.element.asSentence(id: $0.offset) }
    let limit: Int? = options.useDurationCurve ? nil : options.limit
    do {
      let selected = try await clips.clips(in: transcript.map(\.text), limit: limit)
      return selected.map { clipsRecord(from: $0, transcript: transcript, padding: options.padding) }
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let clipError = error as? ClipError {
      switch clipError {
      case .modelNotFound: return ModelUnavailableException(clipError.message)
      case .predictionFailed: return InferenceFailedException(clipError.message)
      }
    }
    return fallback(String(describing: error))
  }

  // MARK: - Progress

  /// Called from whatever context the load is on, so it hops to the JavaScript
  /// actor before touching the event.
  ///
  /// Only ever `loadingModel`: selection itself reports nothing, because
  /// `Clips.clips(in:limit:)` takes no progress handler.
  private func report(_ jobId: String, fraction: Double) {
    guard progressGate.shouldEmit(fraction: fraction) else {
      return
    }
    Task { @JavaScriptActor [weak self] in
      self?.onProgress(ClipsProgressEvent(jobId: jobId, phase: "loadingModel", fraction: fraction))
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
