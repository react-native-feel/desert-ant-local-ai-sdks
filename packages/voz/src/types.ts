import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/** One word, and where it sits in the recording. */
export interface TranscriptWord {
  /** The word itself, already detokenized -- no sentencepiece markers. */
  text: string;
  /** Seconds from the start of the audio. */
  start: number;
  /** Seconds from the start of the audio. */
  end: number;
}

/**
 * What Voz heard.
 *
 * `text` and `words` are the same transcript twice: `text` is what to show,
 * `words` is what to seek, highlight or caption with. They are produced together
 * by the same decode, so using both costs nothing extra.
 */
export interface Transcript {
  /** The full transcript, detokenized and spaced. */
  text: string;
  /**
   * Every word with its span.
   *
   * **Timing resolution is 80 ms** -- one encoder frame -- so a word boundary is
   * accurate to about that, not to the sample. Desert Ant measures mean error at
   * 83 ms on the start and 95 ms on the end. Fine for captions and click-to-seek;
   * not fine for cutting on a word boundary without a crossfade.
   */
  words: TranscriptWord[];
  /** Length of the audio transcribed, in seconds. */
  durationSec: number;
  /** Wall-clock time the transcription took, in seconds. */
  processingSec: number;
  /** `durationSec / processingSec`: seconds of audio per second of wall clock. */
  realtimeFactor: number;
  /** The published model revision this transcript came from, so a benchmark or
   *  a telemetry event is self-identifying. */
  modelRevision: string | null;
  /** The inference runtime that produced it. `coreml` -- there is no other. */
  modelRuntime: string | null;
}

export interface VozLoadOptions extends ModelLoadOptions {
  /**
   * Called while the model downloads and loads.
   *
   * Worth wiring up here rather than leaving to the first `transcribe`: the
   * weights are **~490 MB**, so the first-ever load is a real download with a
   * real progress bar, not a spinner.
   */
  onProgress?: (event: ProgressEvent) => void;
}

export interface TranscribeOptions {
  /** Called as the work proceeds, with a true `0..1` fraction. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface TranscribeFileOptions extends TranscribeOptions {
  /**
   * The audio to transcribe. A `file://` URI or a plain path; anything
   * AVFoundation can decode (`.m4a` from expo-audio, `.wav`, `.mp3`, ...).
   *
   * It is downmixed to mono and resampled to the model's 16 kHz on the way in,
   * a chunk at a time, so a long recording is never resident all at once.
   */
  uri: string;
}

export type { ModelPhase, ProgressEvent };
