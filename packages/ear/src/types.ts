import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/** One candidate language and how likely the detector thinks it is. */
export interface LanguageCandidate {
  /** ISO 639-1 where one exists, otherwise ISO 639-3. */
  language: string;
  /** `0` to `1`, averaged over the windows that were listened to. */
  probability: number;
}

/**
 * What the detector heard.
 *
 * Read {@link isReliable} rather than thresholding {@link confidence} yourself.
 * They are not the same test and the difference is the whole point of the field
 * -- see the note on `isReliable`.
 */
export interface Detection {
  /**
   * The detected language as an ISO code, or null when there was nothing to
   * listen to.
   *
   * Three codes are rewritten on the way out, because the detector's label space
   * and the codes an app routes on are not the same vocabulary: `tl` becomes
   * `fil`, `nb` becomes `no`, and `yue` is folded into `zh`.
   */
  language: string | null;
  /** {@link language}'s probability, `0` to `1`. `0` when there is no answer. */
  confidence: number;
  /**
   * Whether this answer is worth routing work on.
   *
   * **This is the field to branch on**, and it is not a threshold on
   * {@link confidence}. Two separate things make it false:
   *
   * - the top two candidates are within {@link Ear.reliableMargin} of each other,
   *   so the answer is a coin toss between them; and
   * - the answer is Norwegian, Swedish or Danish, which the detector confuses
   *   with each other *confidently* -- it reads Norwegian as Swedish in roughly
   *   40% of clips and is sure about it. A margin test cannot catch that, which
   *   is why the language list exists as well as the margin.
   *
   * Nothing is hidden when it is false: {@link language} still holds the
   * detector's answer. What the flag says is that acting on it -- picking a
   * recognizer, tagging a file -- is a bet rather than a fact.
   *
   * Decided natively on both platforms rather than recomputed here. The rule is
   * calibrated against Desert Ant's own corpus, and three SDKs reimplementing it
   * would be three chances to differ.
   */
  isReliable: boolean;
  /** Every candidate, most likely first. Includes the winner at index 0. */
  candidates: LanguageCandidate[];
  /**
   * How many thirty-second windows the answer is averaged over.
   *
   * Fewer than requested when the recording is shorter than that much audio, so
   * this is what was actually listened to rather than what was asked for.
   */
  windows: number;
  /**
   * Wall-clock time the identification took, in seconds -- decode included on
   * the file path.
   *
   * Measured around the call natively, so it excludes the bridge hop but
   * includes everything the model did. A first call on a cold model also pays
   * the download and session build; a second does not, and the difference
   * between the two is exactly that cost.
   */
  processingSec: number;
  /** The published model revision this came from, so a benchmark or a telemetry
   *  event is self-identifying. */
  modelRevision: string | null;
}

export interface EarLoadOptions extends ModelLoadOptions {
  /**
   * Called while the model downloads and loads.
   *
   * The weights are **~9 MB** -- the second-smallest model in this family after
   * Emo -- so this is a progress bar that is over quickly, and loading on mount
   * is reasonable.
   */
  onProgress?: (event: ProgressEvent) => void;
}

/** Tuning for one `identify` call. Every field is per-call: a model instance
 *  holds no settings, so two callers can ask the same loaded model for different
 *  amounts of listening. */
export interface IdentifyOptions {
  /**
   * How many thirty-second windows to listen to. Defaults to
   * {@link Ear.defaultWindows} (3).
   *
   * Windows are chosen by how speech-like they sound and spread across the
   * recording rather than taken from the front, because the opening of a file is
   * titles and music. A recording shorter than one window uses one.
   *
   * Raising it buys less than it looks like it should. Desert Ant measured one
   * window and six windows misrouting the same 11 files out of 162, because a
   * recording is one speaker in one room: when the detector is wrong it is wrong
   * in every window of that file, so the errors are unanimous and there is
   * nothing for an average to cancel. Three is the default because it costs
   * ~45 ms in total and covers the one case a single window cannot -- a file
   * whose opening is music.
   */
  windows?: number;
  /** Called while the model downloads and loads. Identification itself reports
   *  nothing -- see {@link EarProgressNote}. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface IdentifyFileOptions extends IdentifyOptions {
  /**
   * The audio to identify. A `file://` URI or a plain path.
   *
   * On iOS, anything AVFoundation can decode (`.m4a` from expo-audio, `.wav`,
   * `.mp3`, and the audio track of a `.mov` or `.mp4`). On Android, WAV plus
   * anything `MediaCodec` can open, which is the same list in practice.
   *
   * It is downmixed to mono and resampled to the model's 16 kHz on the way in.
   */
  uri: string;
}

/**
 * A marker for the one thing this model does not report.
 *
 * `identify` emits no progress of its own: upstream's `identify` takes no
 * handler on either platform, unlike its `download`. So the only phase an Ear
 * ever emits is `loadingModel`, and it emits it from `warm`, `download`, and the
 * load that the first `identify` does implicitly. Inventing an `identifying`
 * fraction would mean making one up -- and at ~250 ms there is nothing a
 * progress bar could usefully show anyway.
 */
export type EarProgressNote = never;

export type { ModelPhase, ProgressEvent };
