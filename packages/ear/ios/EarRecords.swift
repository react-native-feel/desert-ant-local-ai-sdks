// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.

import DesertAnt
import Ear
import ExpoModulesCore

/// How an `EarModel` finds its weights.
///
/// Shorter than the other models' load options, and that is upstream's shape
/// rather than an omission: `Ear.init` takes a directory and nothing else. There
/// is no `computeUnits` here because `Sources/Ear` does not expose one -- the
/// detector is a ~9 MB encoder that upstream always builds with its own default.
@Record
struct EarLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the ~9 MB of weights itself points at the folder holding them. Nil
  /// uses the managed platform cache.
  var directory: String?
}

/// One `identify` call's settings.
@Record
struct EarIdentifyOptions {
  /// How many thirty-second windows to listen to. Defaults to upstream's own 3.
  var windows: Int = 3

  func resolvedWindows() throws -> Int {
    guard windows >= 1 else { throw InvalidWindowsException(windows) }
    return windows
  }
}

/// One candidate language and its probability.
///
/// A `@Record` rather than a tuple or a dictionary because it is returned inside
/// an array: `Array` is `JavaScriptEncodable` where its `Element` is, and every
/// `Record` is, so `[EarCandidate]` encodes as a real array of real objects with
/// no per-candidate dictionary boxing.
@Record
struct EarCandidate {
  /// ISO 639-1 where one exists, otherwise 639-3.
  var language: String = ""
  var probability: Double = 0
}

/// What the detector heard.
///
/// `language`, `confidence` and `isReliable` are computed properties on the Swift
/// `Detection` and flattened into stored fields here, because a `@Record` field
/// is a stored property. Flattening rather than making JavaScript re-derive them
/// is the point: `isReliable` in particular is a calibrated rule, and a second
/// implementation of it in TypeScript would be free to drift from this one.
@Record
struct EarDetection {
  /// The detected language, or nil when there was nothing to listen to.
  var language: String?
  /// `language`'s probability, `0...1`.
  var confidence: Double = 0
  /// Whether the answer is worth routing work on. See `Detection.isReliable`.
  var isReliable: Bool = false
  /// Every candidate, most likely first.
  var candidates: [EarCandidate] = []
  /// How many windows the answer is averaged over -- what was listened to, which
  /// is fewer than asked for on a short recording.
  var windows: Int = 0
  /// Wall clock around the whole call, decode included.
  var processingSec: Double = 0
  /// The pinned model revision this came from, so a benchmark or a telemetry
  /// event is self-identifying.
  var modelRevision: String?
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
///
/// `phase` is only ever `loadingModel`: upstream's `identify` takes no progress
/// handler on either platform, so there is no identification fraction to report
/// and none is invented.
@Record
struct EarProgressEvent {
  var jobId: String = ""
  var phase: String = ""
  var fraction: Double = 0
}

// MARK: - Mapping

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func earDetection(from detection: Detection, processingSec: Double) -> EarDetection {
  var record = EarDetection()
  record.candidates = detection.candidates.map { prediction in
    var candidate = EarCandidate()
    candidate.language = prediction.language
    candidate.probability = prediction.probability
    return candidate
  }
  record.language = detection.language
  record.confidence = detection.confidence
  record.isReliable = detection.isReliable
  record.windows = detection.windows
  record.processingSec = processingSec
  record.modelRevision = EarModel.revision
  return record
}
