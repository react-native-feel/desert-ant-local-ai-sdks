import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * Delivery targets Clear ships presets for, in integrated LUFS. The same table
 * as `LOUDNESS_PRESETS` in `@desert-ant-labs/clear`, so a value carried over
 * from a web build means the same thing here.
 */
export const LOUDNESS_PRESETS = {
  applePodcasts: -19,
  podcast: -19,
  spotify: -14,
  youtube: -14,
  broadcast: -23,
} as const;

export type LoudnessPreset = keyof typeof LOUDNESS_PRESETS;

/**
 * Which published export of the model to run. The two are trained differently,
 * not relabelled: `clear-studio` is the more aggressive denoise/dereverb and
 * leaves silences close to true zero, `clear-natural` keeps room tone, breath
 * and lip texture.
 *
 * **Apple only.** `ai.desertant:clear` takes no variant, so asking for
 * `clear-natural` on Android throws `ERR_INVALID_ARGUMENT` rather than quietly
 * running the other one.
 */
export type ClearVariant = 'clear-studio' | 'clear-natural';

/** What the output's channel layout should be. */
export type ChannelMode =
  /** Downmix before enhancement and emit one channel. The default. */
  | 'mono'
  /** Keep the input's layout, at an inference pass per channel (~1.8x). */
  | 'preserve';

export interface ClearLoadOptions extends ModelLoadOptions {
  /** Defaults to `clear-studio`. Apple only -- see {@link ClearVariant}. */
  variant?: ClearVariant;
  /** Called while `Clear.load` downloads and warms the model. The first-ever
   *  load is the slow one, so this is the callback a splash screen wants. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface EnhanceOptions {
  /** Enhancement blend in `0..1`. 1 (the default) is the full model output. */
  strength?: number;
  /**
   * An integrated-LUFS number, a {@link LoudnessPreset} name, or `null` to skip
   * mastering and return the model's own level. Defaults to `applePodcasts`.
   */
  targetLUFS?: number | LoudnessPreset | null;
  /** True-peak ceiling in dBTP. Defaults to -1.5, which leaves headroom for
   *  lossy codecs. */
  peakCeilingDBFS?: number;
  /** Upper bound on the loudness gain in dB, so a very quiet input lands under
   *  target rather than lifting the model's noise floor with it. Defaults to 9. */
  maxGainDB?: number;
  /** Delivery sample rate. The model always runs at 48 kHz; the result is
   *  resampled on the way out. Defaults to 48000. */
  outputSampleRate?: number;
  /** Defaults to `mono`. */
  channelMode?: ChannelMode;
  /** Per-channel LUFS target applied before the joint stages, to correct a pair
   *  whose sides were recorded at different levels. Omit to leave the balance
   *  alone: mastering is otherwise joint -- one gain, one limiter envelope --
   *  so it never moves the stereo image. */
  balanceChannelsLUFS?: number;
  /** Called as the work proceeds. See {@link ProgressEvent.fraction} for what
   *  Android can and cannot report. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface EnhanceFileOptions extends EnhanceOptions {
  /** The audio to enhance. A `file://` URI or a plain path; anything the
   *  platform can decode (`.m4a` from expo-audio, `.wav`, `.mp3`, ...). */
  uri: string;
  /**
   * Where to write the result. Defaults to the input's directory with a
   * `-clear` suffix and the same extension.
   *
   * The encoding follows this path's extension: `.wav` is 16-bit PCM,
   * `.m4a`/`.mp4`/`.aac` is AAC, and on Apple `.caf`/`.aiff` is PCM. Anything
   * else writes WAV.
   *
   * On iOS this is honoured only for a **WAV input**. Any other input is decoded
   * in memory and written back as WAV regardless of what is asked for, to avoid
   * a crash in the upstream SDK's streaming path. {@link EnhanceFileResult.uri}
   * reports where the audio actually landed.
   */
  outputUri?: string;
}

/** What mastering measured on the way out, and which artifact produced it. */
export interface ClearMetrics {
  /** The delivery rate: 48000 unless `outputSampleRate` asked otherwise. */
  sampleRate: number;
  /** Length of the output in seconds. */
  durationSec: number;
  /** Wall-clock time the enhance took. */
  processingSec: number;
  /** How many channels the output has. */
  channelCount: number;
  /** `durationSec / processingSec`: above 1 is faster than real time. */
  realtimeFactor: number;
  /** Integrated loudness of the *input*, or null when mastering was bypassed. */
  measuredLUFS: number | null;
  /** True peak of the delivered audio in dBFS (4x oversampled), measured after
   *  limiting -- so it is what to assert a delivery spec against. Null when
   *  mastering was bypassed. */
  measuredTruePeakDBFS: number | null;
  /** The variant that produced this output. */
  modelVariant: string | null;
  /** The published model revision this output came from. Null on Android, whose
   *  `Result` carries no revision. */
  modelRevision: string | null;
  /** Which inference runtime ran it: `coreml` on Apple, `litert` on Android. */
  modelRuntime: string | null;
}

export interface EnhanceFileResult extends ClearMetrics {
  /**
   * A `file://` URI for the enhanced audio.
   *
   * Usually `outputUri`, but **not always**: on iOS anything that is not already
   * a WAV is decoded in memory and re-encoded as WAV, so a `.m4a` request comes
   * back as `.wav`. Always read the file from here rather than assuming the path
   * you asked for.
   */
  uri: string;
}

export interface EnhanceSamplesResult extends ClearMetrics {
  /** Enhanced audio, one entry per channel. Mono input gives one. */
  channels: Float32Array[];
  /** The first channel -- the whole signal for mono, the left of a stereo pair. */
  samples: Float32Array;
}

export type { ModelPhase, ProgressEvent };
