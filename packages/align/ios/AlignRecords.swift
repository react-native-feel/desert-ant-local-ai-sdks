// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.
//
// What matters is *where* these are encoded: everything in this file is handed to
// JavaScript from a synchronous member, never returned from a `@JS async`
// function. `AlignTranscript` is an array of `@Record`s inside a `@Record`, and
// the largest result in this family after Clear's audio. See AlignModel.swift --
// and note that the `JavaScriptValuesBuffer.deinit` crashes are the *argument*
// half of that defect, which no return type fixes.

import Align
import ExpoModulesCore
import Foundation

/// How an `AlignModel` finds its weights.
///
/// One field, like Redact's, Shapes' and Uhm's. `Catalog.swift` declares a single
/// set of Apple artifacts -- two `.mlmodelc` directories and three sidecars -- so
/// the only thing to say is where they live. There is no variant to pick and no
/// compute-unit knob to forward: `StageModel` hardcodes
/// `MLModelConfiguration.computeUnits = .cpuAndNeuralEngine` and exposes no way
/// to change it, so this package does not invent one.
@Record
struct AlignLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the weights itself points at the folder holding them. Nil uses the
  /// managed platform cache.
  var directory: String?
}

/// One `transcribe` call's settings.
@Record
struct AlignTranscribeOptions {
  /// BCP-47 or ICU locale identifier -- `en-US`, `es_ES`, `ja-JP`. Validated
  /// rather than silently defaulted; see `AlignModelObject.transcribe`.
  var locale: String = ""

  /// Transcribe anyway when Align has no language id for `locale`, accepting
  /// Apple's own timestamps. False refuses instead.
  var allowUnrefined: Bool = false

  /// How much audio the refiner keeps for context, in seconds.
  ///
  /// Forwarded because it is upstream's only tunable, and validated because
  /// upstream does not validate it: `maxBufferedSeconds` multiplies into a ring
  /// buffer cap, and a zero or negative value makes that cap zero. It has no
  /// effect on this SDK's file path -- `init(locale:audioFile:)` calls
  /// `useCompleteAudio`, which clears the ring buffer entirely -- so it is here
  /// for completeness and for the streaming path a future version may expose,
  /// and a caller who sets it to nonsense should hear about it rather than
  /// wonder later.
  var maxBufferedSeconds: Double = 30
}

/// One word, its refined span, and the span Apple gave it.
///
/// Both timings are on the wire on purpose, and it is the field pair that makes
/// this model checkable. Align's whole claim is a *delta* -- 106.4 ms of mean
/// error down to 20.2 ms, upstream's numbers on LibriSpeech test-clean -- and a
/// result that reported only the corrected span would be indistinguishable from
/// Apple's output plus a `refined: true` flag. With both, an app can measure the
/// shift it actually got on its own audio, which is the only number that is
/// really about its audio.
@Record
struct AlignWord {
  /// The word, exactly as Apple transcribed it. Align never changes the text.
  var text: String = ""
  /// Refined start, in seconds from the beginning of the audio.
  var start: Double = 0
  /// Refined end, in seconds.
  var end: Double = 0
  /// Apple's original start, in seconds.
  var originalStart: Double = 0
  /// Apple's original end, in seconds.
  var originalEnd: Double = 0
  /// True when the refiner actually moved this word.
  ///
  /// False is a documented, ordinary outcome rather than a failure: upstream
  /// keeps Apple's span whenever either boundary's cascade output is invalid,
  /// the coarse correction lands at the edge of the search window, or the
  /// correction would invert the word. `refined == false` therefore means
  /// `start == originalStart` and `end == originalEnd`.
  var refined: Bool = false
}

/// What one `transcribe` call produced.
@Record
struct AlignTranscript {
  /// The full transcript, as Apple's `SpeechTranscriber` wrote it. Align refines
  /// timings, never text.
  var text: String = ""
  /// Every word with both spans, in time order.
  var words: [AlignWord] = []
  /// The locale actually used, as `Locale.identifier` normalized it.
  var locale: String = ""
  /// Whether Align had a language id for that locale. **False means every word's
  /// `refined` is false and the timings are Apple's** -- which is only reachable
  /// by passing `allowUnrefined`.
  var languageRefined: Bool = false
  /// How many words the refiner moved.
  var refinedWordCount: Int = 0
  /// Length of the audio, in seconds.
  var durationSec: Double = 0
  /// Wall clock around the whole call: Apple's recognition plus Align's work.
  var processingSec: Double = 0
  /// Wall clock inside `SpeechTimestampRefiner.refine`, summed across finalized
  /// results. This is Align's own cost, as opposed to Apple's.
  var refineSec: Double = 0
  /// Wall clock building the refiner: reading the config and the mel filterbank,
  /// loading the two Core ML stages and the calibrator, and decoding the audio
  /// into the refiner's buffer. Paid once per call, not once per word.
  var setupSec: Double = 0
  /// `durationSec / processingSec`: seconds of audio per second of wall clock.
  var realtimeFactor: Double = 0
  /// The model revision this came from, so a benchmark or a telemetry event is
  /// self-identifying. **Currently `main`, a branch** -- see
  /// `AlignModule.revisionIsPinned`.
  var modelRevision: String?
  /// The inference runtime that produced it. `coreml` -- there is no other.
  var modelRuntime: String?
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
///
/// Only two phases are ever emitted, and neither is invented:
///
///   * `loadingModel` carries a true byte fraction from
///     `ModelDeclaration.resolve`'s `DownloadProgress`, and -- for the second
///     download Align needs -- `AssetInstallationRequest.progress`'s
///     `fractionCompleted`, which is Apple's own.
///   * `transcribing` carries `result.range.end / durationSec` off Apple's own
///     result stream. That is measured rather than modelled: it is how far into
///     the recording the recognizer has finalized.
///
/// Refinement itself reports nothing, because there is nothing to report:
/// `refine(_:)` takes no handler on any of its overloads, and it is milliseconds.
@Record
struct AlignProgressEvent {
  var jobId: String = ""
  var phase: String = ""
  var fraction: Double = 0
}
