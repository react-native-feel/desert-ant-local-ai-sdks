import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * One word, the span Align gives it, and the span Apple gave it.
 *
 * Both are here on purpose, and the pair is what makes this model checkable.
 * Align's whole claim is a *delta* -- upstream measures Apple's mean boundary
 * error at 106.4 ms and its own at 20.2 ms on LibriSpeech test-clean, and 95% of
 * words inside 50 ms -- and a result carrying only the corrected span would be
 * indistinguishable from Apple's output with a flag bolted on. With both, an app
 * can measure the shift it got on *its* audio, which is the only number that is
 * about its audio. {@link timestampShift} does the arithmetic.
 */
export interface AlignedWord {
  /** The word, exactly as Apple transcribed it. Align never changes text. */
  text: string;
  /** Refined start, in seconds from the beginning of the audio. */
  start: number;
  /** Refined end, in seconds. */
  end: number;
  /** Apple's original start, in seconds. */
  originalStart: number;
  /** Apple's original end, in seconds. */
  originalEnd: number;
  /**
   * Whether the refiner moved this word.
   *
   * False is an ordinary outcome, not a failure. Upstream keeps Apple's span
   * whenever either boundary's cascade output is invalid, the coarse correction
   * lands at the edge of its search window, or the correction would invert the
   * word -- a documented fallback rather than an error path. So `refined: false`
   * means `start === originalStart` and `end === originalEnd`, and a result with
   * a low {@link AlignedTranscript.refinedWordCount} is one Align mostly declined
   * to touch.
   */
  refined: boolean;
}

/**
 * What one `transcribe` call produced: Apple's transcript, with Align's
 * timestamps.
 */
export interface AlignedTranscript {
  /** The full transcript, as Apple's `SpeechTranscriber` wrote it. */
  text: string;
  /** Every word with both spans, in time order. */
  words: AlignedWord[];
  /** The locale actually used, as `Locale.identifier` normalized it -- so
   *  `en-US` comes back `en_US`. */
  locale: string;
  /**
   * Whether Align had a language id for that locale.
   *
   * **False means nothing was refined**: `SpeechTimestampRefiner.refine` is a
   * passthrough for a language it was not trained on, so every word's `refined`
   * is false and every timestamp is Apple's. Only reachable by passing
   * {@link TranscribeOptions.allowUnrefined}, because the default is to refuse
   * rather than to hand back a result that looks refined and is not.
   */
  languageRefined: boolean;
  /** How many words the refiner moved. */
  refinedWordCount: number;
  /** Length of the audio, in seconds. */
  durationSec: number;
  /** Wall clock around the whole call -- Apple's recognition included. */
  processingSec: number;
  /**
   * Wall clock inside the refiner, summed across finalized results.
   *
   * This is Align's own cost as opposed to Apple's, and it is the number a
   * decision about adding Align is made on: `processingSec` is dominated by
   * recognition, which an app doing this at all is already paying.
   */
  refineSec: number;
  /**
   * Wall clock building the refiner: reading the config and mel filterbank,
   * loading the two Core ML stages and the calibrator, and decoding the audio
   * into the refiner's buffer.
   *
   * Paid once per `transcribe`, not once per word, and separate from
   * {@link refineSec} because it is a fixed cost rather than one that scales
   * with the transcript.
   */
  setupSec: number;
  /** `durationSec / processingSec`: seconds of audio per second of wall clock. */
  realtimeFactor: number;
  /**
   * The model revision this came from.
   *
   * Today it is `main`, a branch rather than a tag -- read {@link Align.revisionIsPinned}
   * before treating this as provenance.
   */
  modelRevision: string | null;
  /** The inference runtime that produced it. `coreml` -- there is no other. */
  modelRuntime: string | null;
}

export interface AlignLoadOptions extends ModelLoadOptions {
  /**
   * Called while Align's weights download.
   *
   * ~0.7 MB in two Core ML stages plus three sidecars, so this is a progress bar
   * that is over quickly -- the second-smallest download in this family after
   * Shapes' 0.2 MB. Apple's speech model for a locale is a *separate* and much
   * larger download; see {@link Align.prepareLocale}.
   */
  onProgress?: (event: ProgressEvent) => void;
}

export interface TranscribeOptions {
  /**
   * BCP-47 or ICU locale identifier for the audio: `en-US`, `es-ES`, `ja-JP`.
   *
   * Required, and validated rather than defaulted. Upstream accepts anything
   * `Locale(identifier:)` accepts -- which is everything -- and silently turns a
   * language it does not know into a refiner that returns Apple's timestamps
   * unchanged. A typo would cost the entire benefit and raise nothing.
   */
  locale: string;
  /**
   * Transcribe anyway when Align has no model for `locale`'s language, accepting
   * Apple's own timestamps. Defaults to false, which refuses instead.
   *
   * Set it true when a transcript of unknown-language audio is still worth having
   * and the timings are a bonus -- then branch on
   * {@link AlignedTranscript.languageRefined}.
   */
  allowUnrefined?: boolean;
  /**
   * How much audio the refiner keeps for context, in seconds. Defaults to 30.
   *
   * Has no effect on this SDK's file path, which loads the whole file into the
   * refiner and clears the ring buffer this bounds. Forwarded because it is
   * upstream's only tunable, and validated because upstream does not validate it.
   */
  maxBufferedSeconds?: number;
  /** Called as the work proceeds. Two phases: `loadingModel` while Apple's speech
   *  assets install, then `transcribing` with a true `0..1` fraction. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface TranscribeFileOptions extends TranscribeOptions {
  /**
   * The audio to transcribe. A `file://` URI or a plain path; anything
   * AVFoundation can decode (`.m4a` from expo-audio, `.wav`, `.mp3`, and the
   * audio track of a `.mov` or `.mp4`).
   *
   * The file is read twice -- once by Apple's analyzer and once by the refiner,
   * through its own handle -- and never crosses into JavaScript.
   */
  uri: string;
}

/** What {@link timestampShift} measured over a word list. All values in seconds. */
export interface TimestampShift {
  /** How many words were compared. */
  wordCount: number;
  /** How many of those the refiner actually moved. */
  refinedCount: number;
  /** Mean absolute movement across every boundary of every refined word. */
  meanAbsSec: number;
  /** The largest single boundary movement. */
  maxAbsSec: number;
  /** Mean signed movement of the start boundaries. Negative means Align pulled
   *  word starts earlier than Apple placed them. */
  meanStartSec: number;
  /** Mean signed movement of the end boundaries. */
  meanEndSec: number;
}

export type { ModelPhase, ProgressEvent };
