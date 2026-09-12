// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.
//
// Records nest here in a way Clear's and Voz's do not -- a `ClipsClip` holds
// `[ClipsRange]` -- which works for the same reason `[VozWord]` does:
// `Array: JavaScriptEncodable where Element: JavaScriptEncodable` in
// expo-modules-jsi, and every `Record` is `JavaScriptEncodable`.

import Clips
// `ComputeUnits` lives in the `Inference` target, which `DesertAnt` re-exports;
// importing the `Clips` product alone does not bring it into scope.
import DesertAnt
import ExpoModulesCore
import Transcript

/// How a `ClipsModel` finds its weights, and what it may run on.
@Record
struct ClipsLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the ~288 MB of weights itself points at the folder holding them. Nil
  /// uses the managed platform cache.
  var directory: String?

  /// `cpuAndNeuralEngine` (default), `all` or `cpuOnly`.
  var computeUnits: String = "cpuAndNeuralEngine"

  /// Resolve into the Swift SDK's own enum.
  func resolvedComputeUnits() throws -> ComputeUnits {
    switch computeUnits {
    case "cpuAndNeuralEngine": return .cpuAndNeuralEngine
    case "all": return .all
    case "cpuOnly": return .cpuOnly
    default: throw InvalidComputeUnitsException(computeUnits)
    }
  }
}

/// One sentence of the transcript, and the span it occupies.
///
/// Identity is position: this crosses as an array, and `ClipsClip.sentenceIds`
/// indexes back into the same array JavaScript passed in.
@Record
struct ClipsSentence {
  var text: String = ""
  var start: Double = 0
  var end: Double = 0
}

/// One word of recognized speech, for `sentencesFromWords`.
@Record
struct ClipsWord {
  var text: String = ""
  var start: Double = 0
  var end: Double = 0
}

/// A span of the recording to play.
@Record
struct ClipsRange {
  var start: Double = 0
  var end: Double = 0
}

/// One selected moment.
@Record
struct ClipsClip {
  /// Rank in the selected set; 0 is the best. Results are already in this order.
  var rank: Int = 0
  var text: String = ""
  var sentenceIds: [Int] = []
  /// Comparable only within one transcript -- use `percentile` to threshold.
  var score: Double = 0
  var percentile: Double = 0
  var estimatedDurationSec: Double = 0
  /// The spans to play, in ascending order. More than one where the clip's
  /// sentences are separated by a pause, so the pause is cut rather than played.
  var ranges: [ClipsRange] = []
  /// Total of `ranges`, excluding any pause cut between them.
  var durationSec: Double = 0
}

/// One `find` call's settings.
@Record
struct ClipsFindOptions {
  /// Ignored when `useDurationCurve` is true. Split from it on purpose: a
  /// nullable-with-a-default field would make "omitted" and "let the model
  /// decide" the same wire value.
  var limit: Int = 10
  /// True passes `nil` upstream, letting the duration curve choose a count.
  var useDurationCurve: Bool = false
  /// Greatest time added to either end of a span, in seconds.
  var padding: Double = 0.15
}

/// A progress tick, emitted while the model loads. Selection itself reports
/// nothing -- `Clips.clips(in:)` upstream takes no progress handler.
@Record
struct ClipsProgressEvent {
  var jobId: String = ""
  /// Always `loadingModel`.
  var phase: String = ""
  var fraction: Double = 0
}

// MARK: - Mapping

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature.
func clipsRecord(from clip: Clip, transcript: [Sentence], padding: Double) -> ClipsClip {
  var record = ClipsClip()
  record.rank = clip.id
  record.text = clip.text
  record.sentenceIds = clip.sentenceIDs
  record.score = clip.score
  record.percentile = clip.percentile
  record.estimatedDurationSec = clip.estimatedDurationSec
  // Computed here rather than in JavaScript. `Clip.ranges(in:padding:)` is the
  // upstream rule for turning selected sentences into audio spans -- it splits a
  // clip at pauses, pads each end into silence only, and merges spans that
  // overlap once padded. Reimplementing that in TypeScript would be a second
  // definition of where a cut goes, free to drift from this one.
  record.ranges = clip.ranges(in: transcript, padding: padding).map { range in
    var mapped = ClipsRange()
    mapped.start = range.start
    mapped.end = range.end
    return mapped
  }
  record.durationSec = record.ranges.reduce(0) { $0 + ($1.end - $1.start) }
  return record
}

func clipsSentenceRecord(from sentence: Sentence) -> ClipsSentence {
  var record = ClipsSentence()
  record.text = sentence.text
  record.start = sentence.start
  record.end = sentence.end
  return record
}

extension ClipsSentence {
  /// Position in the array is the sentence's identity, so the index is supplied
  /// by the caller rather than carried on the wire.
  func asSentence(id: Int) -> Sentence {
    Sentence(id: id, text: text, start: start, end: end)
  }
}

extension ClipsWord {
  func asTimedWord() -> TimedWord {
    TimedWord(text: text, start: start, end: end)
  }
}
