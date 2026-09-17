// The model handle. One instance owns one loaded Core ML program, so an app
// creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `EmoModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// EmoModule.swift.

import DesertAnt
import Emo
import ExpoModulesCore
import Foundation

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the Swift
// SDK invokes from its own tasks -- can capture `self`. What it touches is a
// `let` and a lock-guarded gate, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("EmoModel")
final class EmoModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Whether this build can run Emo at all.
  ///
  /// Reads the catalog rather than answering `true`: `EmoModel.files` is the
  /// upstream statement of which platforms have an artifact, and on Apple it does
  /// have one. Unlike Clips there is no second, OS-level check to make -- Emo
  /// declares no `osFloor` above the package's, and `emo.mlmodelc` is an ordinary
  /// Core ML package rather than a multifunction one, so nothing can fail to load
  /// on a device the pod's own deployment target already allows.
  static var isSupported: Bool { EmoModel.supports(.current) }

  private let emo: Emo
  private let progressGate = ProgressGate()

  /// Emitted while the model loads. Nothing emits during a suggestion: that is
  /// one forward pass at about two milliseconds, and a fraction over it is a
  /// number no UI can use.
  @Event
  var onProgress: (EmoProgressEvent) -> Void

  init(directory: String?) {
    // Construction does no work and starts no download; the model loads on the
    // first `load` or `suggest`, off the calling thread.
    self.emo = Emo(directory: directory)
    super.init()
  }

  /// Whether the weights are on the device, so a suggestion needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    emo.isDownloaded()
  }

  // MARK: - Work (driven by EmoModule)

  /// Download the weights and build the session.
  ///
  /// One call rather than two, because upstream fuses them: `Emo.download` runs
  /// the whole loader -- resolve the files, *then* build the Core ML session --
  /// so there is no download-only entry point to expose, and `warm()` and
  /// `download()` in TypeScript both land here.
  ///
  /// That fusing is also why the failure is classified rather than assumed. Both
  /// stages throw out of the same call, and they are different problems for a
  /// caller: a download that failed is worth a retry button, a session that
  /// refused to build is not. The files being on disk afterwards is what
  /// separates them.
  func load(jobId: String) async throws {
    do {
      try await emo.download { [weak self] fraction in
        self?.report(jobId, phase: "loadingModel", fraction: fraction)
      }
    } catch {
      let downloaded = emo.isDownloaded()
      throw Self.mapped(
        error,
        fallback: { downloaded ? ModelLoadFailedException($0) : ModelUnavailableException($0) })
    }
  }

  /// Rank the vocabulary for `text` and return the top `limit`.
  ///
  /// `load` is called explicitly first even though `Emo.suggestions` would load
  /// lazily anyway, and it is not belt-and-braces. Upstream's lazy load happens
  /// *inside* the call, so a failed download would come back out of the same call
  /// as an inference failure and be reported as `ERR_INFERENCE_FAILED` -- a
  /// caller offering "retry the download" would never see the case it exists for.
  /// Loading first gives the two failures their own codes.
  func suggest(
    text: String,
    options: EmoSuggestOptions,
    jobId: String
  ) async throws -> [EmoSuggestionRecord] {
    let limit = try options.resolvedLimit()
    let skinTone = try options.resolvedSkinTone()
    try await load(jobId: jobId)
    do {
      let suggestions = try await emo.suggestions(for: text, limit: limit, skinTone: skinTone)
      return suggestions.map(emoSuggestion(from:))
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  ///
  /// `EmoError` is the only typed one upstream throws from these paths; anything
  /// else (a URLSession failure inside the download, a Core ML load failure)
  /// falls through to the caller's own default, which is why `fallback` is a
  /// parameter rather than a fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let emoError = error as? EmoError {
      switch emoError {
      // The model, the tokenizer, or the metadata sidecar is missing -- so the
      // files are the problem, not the session built from them.
      case .modelNotFound:
        return ModelUnavailableException(emoError.message)
      case .predictionFailed:
        return InferenceFailedException(emoError.message)
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
      self?.onProgress(EmoProgressEvent(jobId: jobId, phase: phase, fraction: fraction))
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
  private var suggestions: [String: [EmoSuggestionRecord]] = [:]

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an asynchronous one, and holding it across an `await` is
  /// what that rule exists to prevent.
  func stash(_ value: [EmoSuggestionRecord], for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    suggestions[jobId] = value
  }

  /// Hand over the result computed for `jobId`, and forget it.
  ///
  /// Synchronous, and that is the point rather than an optimization: a
  /// synchronous `@JS` member's return value is encoded inside the host call, on
  /// the JavaScript thread, by construction. The asynchronous half returns
  /// `Void` so that nothing is encoded on the cooperative pool. See the note on
  /// `takeSuggestions` in the module.
  @JS
  func takeSuggestions(_ jobId: String) throws -> [EmoSuggestionRecord] {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let value = suggestions.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no result is waiting for job \(jobId)")
    }
    return value
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
