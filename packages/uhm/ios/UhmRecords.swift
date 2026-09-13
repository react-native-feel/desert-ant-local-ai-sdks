// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.

// `ComputeUnits` lives in the `Inference` target, which `DesertAnt` re-exports;
// importing the `Uhm` product alone does not bring it into scope.
import DesertAnt
import ExpoModulesCore
import Uhm

/// How an `UhmModel` finds its weights, and what it may run on.
@Record
struct UhmLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the ~45 MB of weights itself points at the folder holding them. Nil
  /// uses the managed platform cache.
  var directory: String?

  /// `all` (the default, and upstream's own), `cpuAndNeuralEngine` or `cpuOnly`.
  var computeUnits: String = "all"

  /// Resolve into the Swift SDK's own enum.
  func resolvedComputeUnits() throws -> ComputeUnits {
    switch computeUnits {
    case "all": return .all
    case "cpuAndNeuralEngine": return .cpuAndNeuralEngine
    case "cpuOnly": return .cpuOnly
    default: throw InvalidComputeUnitsException(computeUnits)
    }
  }
}

/// One `analyze` call's settings.
///
/// `minConfidence` arrives split into a number and a flag rather than as an
/// optional: JavaScript's "I said nothing" and "I said 0.0" are the same value
/// on the wire otherwise, and one of them means "use the preset".
@Record
struct UhmAnalyzeOptions {
  var bias: String = "balanced"
  var includeTypes: Bool = true
  var minConfidence: Double = 0.65
  var useBiasThreshold: Bool = true
  var minDurationSec: Double = 0.12

  func resolved() throws -> Uhm.Options {
    let preset: Uhm.Bias
    switch bias {
    case "precision": preset = .precision
    case "balanced": preset = .balanced
    case "recall": preset = .recall
    default: throw InvalidBiasException(bias)
    }
    return Uhm.Options(
      bias: preset,
      includeTypes: includeTypes,
      minConfidence: useBiasThreshold ? nil : minConfidence,
      minDurationSec: minDurationSec)
  }
}

/// One detected filler.
///
/// A `@Record` rather than a tuple or a dictionary because it is returned inside
/// an array: `Array` is `JavaScriptEncodable` where its `Element` is, and every
/// `Record` is, so `[UhmFiller]` encodes as a real array of real objects with no
/// per-filler dictionary boxing.
@Record
struct UhmFiller {
  /// Seconds from the start of the audio. Resolution is 20 ms -- one model
  /// frame.
  var start: Double = 0
  var end: Double = 0
  var durationSec: Double = 0
  var confidence: Double = 0
  /// `uh`, `um`, `hmm`, `and` or `other`; nil when the type labeller did not run.
  var type: String?
}

/// Where one `analyze` call's time went.
@Record
struct UhmTimings {
  var decodeSec: Double = 0
  var inferenceSec: Double = 0
  var prepSec: Double = 0
  var groupSec: Double = 0
  var labelingSec: Double = 0
}

/// What Uhm found, plus what it cost.
///
/// The audio is never in here and never comes back out: a file or a
/// `Float32Array` goes *in*, and a handful of spans comes back. That is why this
/// package needs no equivalent of Clear's `ClearAudio` shared object -- the
/// constraint that forced it (expo-modules-core 57 cannot return a
/// Swift-allocated buffer through `@JS`) only bites when audio has to travel
/// back.
@Record
struct UhmResult {
  var fillers: [UhmFiller] = []
  var durationSec: Double = 0
  var processingSec: Double = 0
  /// `durationSec / processingSec`: seconds of audio per second of wall clock.
  var realtimeFactor: Double = 0
  var timings: UhmTimings = UhmTimings()
  /// The pinned model revision this came from, so a benchmark or a telemetry
  /// event is self-identifying.
  var modelRevision: String?
  /// The inference runtime that produced it. Always `coreml`: Uhm has no other.
  var modelRuntime: String?
}

/// One transcript word, for `reconcileWords`.
@Record
struct UhmWord {
  var text: String = ""
  var start: Double = 0
  var end: Double = 0
}

/// One span, for the fillers handed *into* `reconcileWords`. Deliberately not
/// `UhmFiller`: reconciliation reads only the times, so requiring a confidence
/// and a type would make a caller fabricate two fields to pass spans of their
/// own.
@Record
struct UhmRange {
  var start: Double = 0
  var end: Double = 0
}

@Record
struct UhmReconcileOptions {
  var minOverlapFraction: Double = 0.5
  var splitContainedWords: Bool = false

  func resolved() -> ReconcileOptions {
    ReconcileOptions(
      minOverlapFraction: minOverlapFraction,
      splitContainedWords: splitContainedWords)
  }
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
@Record
struct UhmProgressEvent {
  var jobId: String = ""
  /// `loadingModel` or `detecting`.
  var phase: String = ""
  var fraction: Double = 0
}

// MARK: - Mapping

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func uhmResult(from result: Uhm.Result, processingSec: Double) -> UhmResult {
  var record = UhmResult()
  record.fillers = result.fillers.map { detection in
    var mapped = UhmFiller()
    mapped.start = detection.start
    mapped.end = detection.end
    mapped.durationSec = detection.duration
    mapped.confidence = detection.confidence
    mapped.type = detection.type?.rawValue
    return mapped
  }
  record.durationSec = result.audioDuration
  record.processingSec = processingSec
  // A run too fast to time would otherwise divide by zero and report an
  // infinity that no display formats well.
  record.realtimeFactor = processingSec > 0 ? result.audioDuration / processingSec : 0
  var timings = UhmTimings()
  timings.decodeSec = result.phaseTimings.decodeSec
  timings.inferenceSec = result.phaseTimings.inferenceSec
  timings.prepSec = result.phaseTimings.prepSec
  timings.groupSec = result.phaseTimings.groupSec
  timings.labelingSec = result.phaseTimings.labelingSec
  record.timings = timings
  record.modelRevision = UhmModel.revision
  record.modelRuntime = "coreml"
  return record
}

extension UhmWord {
  func asWordRange() -> WordRange {
    WordRange(start: start, end: end, word: text)
  }
}

extension UhmRange {
  /// Reconciliation reads only `start` and `end`, so the confidence and type it
  /// never looks at are filled with values that cannot be mistaken for measured
  /// ones.
  func asDetection() -> Uhm.Detection {
    Uhm.Detection(start: start, end: end, confidence: 1, type: nil)
  }
}

func uhmWord(from range: WordRange) -> UhmWord {
  var record = UhmWord()
  record.text = range.word
  record.start = range.start
  record.end = range.end
  return record
}
