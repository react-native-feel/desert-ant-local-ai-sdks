// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.

import ExpoModulesCore
import Voz

/// How a `VozModel` finds its weights.
@Record
struct VozLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the ~490 MB of weights itself -- or has already downloaded them --
  /// points at the folder holding them. Nil uses the managed platform cache.
  var directory: String?
}

/// One word and the span it occupies.
///
/// A `@Record` rather than a tuple or a dictionary because it is returned inside
/// an array: `Array` is `JavaScriptEncodable` where its `Element` is, and every
/// `Record` is, so `[VozWord]` encodes as a real array of real objects with no
/// per-word dictionary boxing.
@Record
struct VozWord {
  var text: String = ""
  /// Seconds from the start of the audio. Resolution is 80 ms -- one encoder
  /// frame -- not one sample.
  var start: Double = 0
  var end: Double = 0
}

/// What Voz heard, plus what it cost.
///
/// The audio is never in here and never comes back out: the input is a file or a
/// `Float32Array` going *in*, and the result is text. That is why this package
/// needs no equivalent of Clear's `ClearAudio` shared object -- the constraint
/// that forced it (expo-modules-core 57 cannot return a Swift-allocated buffer
/// through `@JS`) only bites when audio has to travel back.
@Record
struct VozTranscript {
  var text: String = ""
  var words: [VozWord] = []
  var durationSec: Double = 0
  var processingSec: Double = 0
  /// `durationSec / processingSec`: seconds of audio per second of wall clock.
  var realtimeFactor: Double = 0
  /// The published model revision this transcript came from, so a benchmark or a
  /// telemetry event is self-identifying.
  var modelRevision: String?
  /// The inference runtime that produced it. Always `coreml`: Voz has no other.
  var modelRuntime: String?
}

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func vozTranscript(from result: Voz.Result) -> VozTranscript {
  var transcript = VozTranscript()
  transcript.text = result.text
  transcript.words = result.words.map { word in
    var mapped = VozWord()
    mapped.text = word.text
    mapped.start = word.start
    mapped.end = word.end
    return mapped
  }
  transcript.durationSec = result.duration
  transcript.processingSec = result.processingTime
  transcript.realtimeFactor = result.realtimeFactor
  transcript.modelRevision = VozModel.revision
  transcript.modelRuntime = "coreml"
  return transcript
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
@Record
struct VozProgressEvent {
  var jobId: String = ""
  /// `loadingModel` or `transcribing`.
  var phase: String = ""
  var fraction: Double = 0
}
