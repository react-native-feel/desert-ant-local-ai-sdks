import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * What kind of filler a detection is.
 *
 * `and` is the mid-sentence "and"-as-filler subtype, which an editor may well
 * want to keep where it would cut an `um`. `other` is the labeller's "something
 * is here but I am not confident which kind" bucket -- useful as-is for
 * analytics, but show it as a neutral "filler" rather than as a category.
 *
 * `null` where the type labeller did not run: {@link AnalyzeOptions.includeTypes}
 * was false, or its ~13 KB head was not on disk.
 */
export type FillerType = 'uh' | 'um' | 'hmm' | 'and' | 'other';

/**
 * The precision/recall preset a detection run is gated at. Each is a confidence
 * threshold, and the thresholds are stable across model revisions -- the
 * published models are pre-calibrated, so `precision` means the same thing
 * against any release.
 *
 * - `precision` (0.75): fewest false alarms. The one to use when a cut happens
 *   without anyone looking at it.
 * - `balanced` (0.65): the default, and the cleanest cutoff Desert Ant measured
 *   across en/es/fr/de/nl.
 * - `recall` (0.50): catches more, at the cost of more false positives. For a
 *   review-and-confirm UI, where missing one is worse than offering one.
 */
export type Bias = 'precision' | 'balanced' | 'recall';

/** One filler, and where it sits in the recording. */
export interface Filler {
  /** Seconds from the start of the audio. */
  start: number;
  /** Seconds from the start of the audio. */
  end: number;
  /** `end - start`, in seconds. */
  durationSec: number;
  /** How sure the model is, `0` to `1`. Already above the run's threshold. */
  confidence: number;
  /** Which kind, or null when the type labeller did not run. */
  type: FillerType | null;
}

/**
 * Where the time in one `analyze` call went.
 *
 * Worth reading rather than only `processingSec`: `inferenceSec` is the part the
 * accelerator touched, so a run whose cost is mostly `decodeSec` is waiting on
 * the audio file, not on the model, and no compute-unit setting will move it.
 */
export interface UhmTimings {
  /** Audio file to 16 kHz mono floats. One pass over the audio. */
  decodeSec: number;
  /** Every model call in the frame detector, summed. */
  inferenceSec: number;
  /** Per-window normalize and input build. */
  prepSec: number;
  /** Thresholding and run-merging over the frame probabilities. */
  groupSec: number;
  /** The type labeller across every detection. A small model, usually a few ms. */
  labelingSec: number;
}

/** What Uhm found. */
export interface UhmResult {
  /** Every filler, in time order. */
  fillers: Filler[];
  /** Length of the audio analyzed, in seconds. */
  durationSec: number;
  /** Wall-clock time the analysis took, in seconds. */
  processingSec: number;
  /** `durationSec / processingSec`: seconds of audio per second of wall clock. */
  realtimeFactor: number;
  /** Where that time went. */
  timings: UhmTimings;
  /** The published model revision this came from, so a benchmark or a telemetry
   *  event is self-identifying. */
  modelRevision: string | null;
  /** The inference runtime that produced it. `coreml` -- there is no other. */
  modelRuntime: string | null;
}

export type ComputeUnits = 'all' | 'cpuAndNeuralEngine' | 'cpuOnly';

export interface UhmLoadOptions extends ModelLoadOptions {
  /**
   * Which backends Core ML may prepare and run the graph on. Defaults to `all`,
   * which is upstream's own default.
   *
   * The detector is a 45 MB DistilHuBERT, small enough that the specialization
   * `all` pays is seconds rather than the minutes a larger graph costs, so the
   * cautious setting is not obviously the better one here. `cpuOnly` is for
   * taking the Neural Engine out of the picture while diagnosing.
   */
  computeUnits?: ComputeUnits;
  /**
   * Called while the model downloads and loads.
   *
   * The weights are **~45 MB** -- small enough to load on mount, unlike Voz's
   * 490 MB or Clips' 288 MB -- so this is a progress bar that is over quickly.
   */
  onProgress?: (event: ProgressEvent) => void;
}

/** Tuning for one `analyze` call. Every field is per-call: a model instance holds
 *  no settings, so two callers can gate the same loaded model differently. */
export interface AnalyzeOptions {
  /** The precision/recall preset. Defaults to `balanced`. */
  bias?: Bias;
  /**
   * Run the type labeller to fill in {@link Filler.type}. Defaults to true.
   *
   * Set it false when the spans alone are what you need: the labeller is a
   * separate Apple-only pass that round-trips a one-second clip per detection
   * through a temporary WAV, so skipping it is real time saved on audio with
   * many fillers.
   */
  includeTypes?: boolean;
  /**
   * An explicit confidence threshold, `0` to `1`, overriding `bias`.
   *
   * Prefer the preset. The presets are calibrated against Desert Ant's labelled
   * corpus and stay meaningful across model revisions; a hardcoded number is
   * only calibrated against whatever you tested it on.
   */
  minConfidence?: number;
  /** Discard anything shorter than this, in seconds. Defaults to 0.12. */
  minDurationSec?: number;
  /** Called as the detector works, with a true `0..1` fraction. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface AnalyzeFileOptions extends AnalyzeOptions {
  /**
   * The audio to analyze. A `file://` URI or a plain path; anything
   * AVFoundation can decode (`.m4a` from expo-audio, `.wav`, `.mp3`, and the
   * audio track of a `.mov` or `.mp4`).
   *
   * It is decoded to mono 16 kHz on the way in.
   */
  uri: string;
}

/** One word of a transcript and the span it occupies, for {@link reconcileWords}. */
export interface WordRange {
  /** The word itself. Carried through unchanged. */
  text: string;
  /** Seconds from the start of the recording. */
  start: number;
  /** Seconds from the start of the recording. */
  end: number;
}

export interface ReconcileOptions {
  /**
   * How much of a word a filler must cover before the word is trimmed:
   * overlapping seconds over the word's own length. Defaults to 0.5.
   *
   * It exists to absorb the disagreement between two models that measured the
   * same audio differently -- Voz places a word boundary to about 80 ms, Uhm
   * places a filler edge to 20 ms -- so a small overlap is jitter rather than a
   * word running into an "um". Lower it to trim more aggressively; raise it to
   * touch only the unambiguous cases.
   */
  minOverlapFraction?: number;
  /**
   * When a word strictly contains a filler, emit both the before and after
   * halves rather than only the longer one. Defaults to false, which is one
   * timestamp per word.
   */
  splitContainedWords?: boolean;
}

export type { ModelPhase, ProgressEvent };
