import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/** One word of recognized speech and the span it occupies, in seconds. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

/**
 * One sentence of a transcript and the span of the recording it occupies.
 *
 * Position in the array is the sentence's identity: {@link Clip.sentenceIds}
 * indexes into the same array you passed in, so reordering or filtering a
 * transcript after selection resolves to different audio.
 */
export interface TranscriptSentence {
  /** The sentence text. */
  text: string;
  /** Seconds from the start of the recording. */
  start: number;
  /** Seconds from the start of the recording. */
  end: number;
}

/** A span of the recording to play, in seconds. */
export interface ClipRange {
  start: number;
  end: number;
}

/** A moment worth cutting. */
export interface Clip {
  /**
   * The clip's rank in the selected set: `0` is the best. Results come back in
   * this order already.
   */
  rank: number;
  /** The clip's sentences, joined with spaces. */
  text: string;
  /** Which sentences it is made of, as indices into the array you passed. */
  sentenceIds: number[];
  /**
   * The model's raw score.
   *
   * **Comparable only within one transcript.** To threshold, or to compare
   * across recordings, use {@link percentile}.
   */
  score: number;
  /** Where this clip ranks within its own transcript, `0` to `1`. */
  percentile: number;
  /** Spoken length of `text`, estimated from word count. */
  estimatedDurationSec: number;
  /**
   * The spans of the recording to play, in ascending order.
   *
   * Usually one, but a clip whose sentences are separated by a pause comes back
   * as one span per run of speech, so the pause is cut rather than played. Each
   * end is padded by up to `padding` seconds — but only into actual silence, so
   * a cut never reaches into a neighbouring word.
   */
  ranges: ClipRange[];
  /** Total length of `ranges`, excluding any pauses cut between them. */
  durationSec: number;
}

export interface ClipsLoadOptions extends ModelLoadOptions {
  /**
   * Which backends Core ML may prepare and run the graph on.
   *
   * Defaults to `cpuAndNeuralEngine`, and that default is measured rather than
   * cautious: `clips.mlmodelc` is a multifunction package, so `all` compiles two
   * graphs for three backends — 3–4 minutes to specialize on an iPhone 17 Pro
   * against roughly 41 s — for selection latency that did not improve. Use
   * `cpuOnly` to take the Neural Engine out of the picture when diagnosing.
   */
  computeUnits?: ComputeUnits;
  /** Called while `Clips.load` downloads and prepares the model (~288 MB). */
  onProgress?: (event: ProgressEvent) => void;
}

export type ComputeUnits = 'cpuAndNeuralEngine' | 'all' | 'cpuOnly';

export interface FindClipsOptions {
  /**
   * The transcript, one sentence per element, in spoken order.
   *
   * Fewer than three sentences returns `[]` — there is nothing to choose
   * between.
   */
  sentences: TranscriptSentence[];
  /**
   * The most clips to return. Defaults to 10. Pass `null` to let the model
   * decide from the transcript's duration.
   *
   * **This sizes the work, it does not trim the result.** The candidate pool is
   * four anchors wide per clip of budget, and scoring those candidates is
   * 60–85% of the runtime, so a smaller limit is genuinely faster. It also means
   * the answer at `10` is not the first ten of the answer at `14`: selection
   * returns the best non-overlapping *set* of at most k, and the best set of ten
   * is not the best set of fourteen with four dropped.
   */
  limit?: number | null;
  /**
   * The most time, in seconds, to add to either end of a span. Defaults to 0.15.
   *
   * Only silence is consumed — a sentence running straight into the next takes
   * none — so raising this lets a clip breathe without ever clipping a word.
   */
  padding?: number;
}

export interface ToSentencesOptions {
  /**
   * The character count at which unpunctuated speech is broken into a new
   * sentence. Defaults to 320.
   *
   * It exists because a recognizer that emits no punctuation would otherwise
   * produce one enormous sentence, and clip selection needs more than one thing
   * to choose between.
   */
  runOnLimit?: number;
}

export type { ModelPhase, ProgressEvent };
