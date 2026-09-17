import { toDesertAntError, toPath, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeUhm, { type NativeAnalyzeOptions, type NativeUhmModel } from './native';
import {
  type AnalyzeFileOptions,
  type AnalyzeOptions,
  type Bias,
  type FillerType,
  type ReconcileOptions,
  type UhmLoadOptions,
  type UhmResult,
  type WordRange,
} from './types';

const MODEL = 'uhm';

const BIASES: Bias[] = ['precision', 'balanced', 'recall'];

/** The thresholds the Swift enum holds, for the platforms where it is not there
 *  to ask. Kept in step with `Uhm.Bias.minConfidence` upstream. */
const FALLBACK_THRESHOLDS: Record<Bias, number> = {
  precision: 0.75,
  balanced: 0.65,
  recall: 0.5,
};

const FALLBACK_FILLER_TYPES: FillerType[] = ['uh', 'um', 'hmm', 'and', 'other'];

let nextJobId = 0;

/**
 * On-device filler-word detection: where every "uh", "um" and "hmm" is, to
 * within 20 ms, without transcribing anything.
 *
 * Acoustic, and that is the point rather than an implementation detail. A
 * recognizer is trained to produce readable text, so it drops disfluencies or
 * spells them inconsistently -- asking one where the "um"s are means asking for
 * the thing it was taught to throw away. Uhm reads the waveform instead, so it
 * finds fillers a transcript never contained, and it costs about 12 seconds per
 * hour of audio.
 *
 * Create one and reuse it. The weights are ~45 MB, small enough to load on
 * mount rather than behind a button.
 *
 * ```ts
 * if (!Uhm.isSupported) return;            // Android: the model has no build
 * const uhm = await Uhm.load();
 * const { fillers } = await uhm.analyze({ uri: recording.uri });
 * for (const filler of fillers) {
 *   console.log(filler.type ?? 'filler', filler.start, filler.end);
 * }
 * ```
 *
 * Trained on English. It transfers acoustically to Spanish, French, German and
 * Dutch without retraining -- Desert Ant has not measured per-language accuracy,
 * so treat those four as "works, unquantified" rather than as supported.
 */
export class Uhm {
  /**
   * Whether this build can run Uhm at all.
   *
   * **False on Android**, for two reasons that are both upstream's: no LiteRT
   * export of the detector has been published, and the type labeller is a
   * SoundAnalysis classifier, which is Apple-only by construction. Check this
   * before offering the feature; every other member throws
   * `ERR_UNSUPPORTED_PLATFORM` where it is false.
   */
  static get isSupported(): boolean {
    return NativeUhm?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. */
  static get unsupportedReason(): string | null {
    if (Uhm.isSupported) {
      return null;
    }
    return (
      'Uhm runs on Apple platforms only: desert-ant-core publishes no Android build of the ' +
      'detector, and its type labeller is a SoundAnalysis classifier.'
    );
  }

  /** The desert-ant-core version the native binary links against, or null off iOS. */
  static get nativeCoreVersion(): string | null {
    return NativeUhm?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null off iOS. */
  static get modelRevision(): string | null {
    return NativeUhm?.modelRevision ?? null;
  }

  /**
   * Every filler type the labeller can return.
   *
   * Read this rather than hardcoding the list if you are building UI per type --
   * the set is the labeller's, and a republished labeller may widen it.
   */
  static get fillerTypes(): FillerType[] {
    const native = NativeUhm?.fillerTypes;
    return native && native.length > 0 ? (native as FillerType[]) : [...FALLBACK_FILLER_TYPES];
  }

  /**
   * What confidence each bias preset gates at.
   *
   * Useful for more than display: an app that offers "cut automatically" and
   * "let me review" can gate the two actions at `precision` and `recall` from
   * one analysis, rather than analyzing twice.
   *
   * ```ts
   * const { fillers } = await uhm.analyze({ uri, bias: 'recall' });
   * const safeToCut = fillers.filter((f) => f.confidence >= Uhm.biasThresholds.precision);
   * ```
   */
  static get biasThresholds(): Record<Bias, number> {
    const native = NativeUhm?.biasThresholds;
    if (!native) {
      return { ...FALLBACK_THRESHOLDS };
    }
    return {
      precision: native.precision ?? FALLBACK_THRESHOLDS.precision,
      balanced: native.balanced ?? FALLBACK_THRESHOLDS.balanced,
      recall: native.recall ?? FALLBACK_THRESHOLDS.recall,
    };
  }

  /**
   * Trim a transcript's words around the fillers found in the same audio, so a
   * cut lands on silence rather than through a word.
   *
   * This is the join between Voz and Uhm, and it is upstream's own geometry
   * rather than a reimplementation, because the cases are not obvious. A
   * recognizer emits one span per word, and that span can straddle a filler,
   * contain one, or *be* one -- the recognizer heard "um" and wrote it down as a
   * word. Dropping every word that overlaps a filler loses about a third of the
   * detections to that last case; cutting at filler boundaries clips real
   * speech. Five rules, applied per overlapping pair:
   *
   * - a word inside a filler is dropped -- it was the filler;
   * - a word running into one has its end pulled back;
   * - a word running out of one has its start pushed forward;
   * - a word containing one is split, and by default only the longer half is
   *   kept;
   * - anything that does not overlap passes through.
   *
   * ```ts
   * const { words } = await voz.transcribe({ uri });
   * const { fillers } = await uhm.analyze({ uri });
   * const clean = Uhm.reconcileWords(words, fillers);
   * ```
   *
   * Pure and synchronous -- it needs no model and no download.
   */
  static reconcileWords(
    words: WordRange[],
    fillers: { start: number; end: number }[],
    options: ReconcileOptions = {}
  ): WordRange[] {
    const native = Uhm.requireNative();
    const minOverlapFraction = options.minOverlapFraction ?? 0.5;
    if (!Number.isFinite(minOverlapFraction) || minOverlapFraction < 0 || minOverlapFraction > 1) {
      throw invalid(
        `'${String(minOverlapFraction)}' is not an overlap fraction; expected a number in 0..1`
      );
    }
    try {
      return native.reconcileWords(words ?? [], fillers ?? [], {
        minOverlapFraction,
        splitContainedWords: options.splitContainedWords ?? false,
      });
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then build the Core ML session. Resolves when the next `analyze` will not
   * have to wait for either.
   *
   * Unlike Voz and Clips this is a reasonable thing to do on mount -- ~45 MB,
   * and a session build measured in seconds rather than tens of them.
   */
  static async load(options: UhmLoadOptions = {}): Promise<Uhm> {
    const uhm = Uhm.create(options);
    try {
      await uhm.warm(options.onProgress);
      return uhm;
    } catch (error) {
      uhm.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `analyze`, which is then as slow as a download.
   */
  static create(options: UhmLoadOptions = {}): Uhm {
    const native = Uhm.requireNative();
    try {
      return new Uhm(
        native.createModel({
          directory: options.directory,
          computeUnits: options.computeUnits ?? 'all',
        })
      );
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeUhm> {
    if (!NativeUhm) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Uhm.unsupportedReason ?? 'Uhm is not available here. Gate the feature on `Uhm.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeUhm;
  }

  private released = false;

  private constructor(private readonly native: NativeUhmModel) {}

  /** Whether the weights are on the device, so `analyze` needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download the weights and build the session, so the first `analyze` pays
   * neither.
   *
   * Identical to {@link download} -- upstream exposes one call that does both, so
   * unlike Clear and Voz there is no download-only step to run separately. Both
   * names exist so every model in this repo reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Uhm.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. See its note. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Find the fillers in an audio or video file.
   *
   * This is the API to reach for. The audio never crosses into JavaScript: the
   * file is decoded natively to mono 16 kHz, and what comes back is a handful of
   * spans.
   */
  async analyze(options: AnalyzeFileOptions): Promise<UhmResult> {
    this.assertAlive();
    if (typeof options?.uri !== 'string' || options.uri.length === 0) {
      throw invalid('analyze needs a `uri`: a file:// URI or a path to audio');
    }
    const native = toNativeOptions(options);
    return this.run(options.onProgress, async (jobId) => {
      await Uhm.requireNative().analyzeFile(this.native, toPath(options.uri), native, jobId);
      // Collected separately, and synchronously -- see `native.ts`.
      return this.native.takeResult(jobId);
    });
  }

  /**
   * Find the fillers in mono samples already in memory.
   *
   * Cheaper than the equivalent on Clear -- the audio travels one way only, and
   * the result is a few spans -- but it still copies every sample into native
   * memory (~3.8 MB per minute at 16 kHz, more before resampling). Use it for
   * audio an app synthesized or already holds as floats; use {@link analyze} for
   * anything that is, or could be, a file.
   *
   * `sampleRate` defaults to 16000, the rate the model runs at. Anything else is
   * resampled natively.
   */
  async analyzeSamples(
    samples: Float32Array | number[],
    sampleRate = 16_000,
    options: AnalyzeOptions = {}
  ): Promise<UhmResult> {
    this.assertAlive();
    const mono = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
    if (mono.length === 0) {
      throw invalid('analyzeSamples was given no audio');
    }
    if (!(sampleRate > 0)) {
      throw invalid(`'${String(sampleRate)}' is not a sample rate; expected a positive number`);
    }
    const native = toNativeOptions(options);
    return this.run(options.onProgress, async (jobId) => {
      await Uhm.requireNative().analyzeSamples(this.native, mono, sampleRate, native, jobId);
      // Collected separately, and synchronously -- see `native.ts`.
      return this.native.takeResult(jobId);
    });
  }

  /**
   * Release the model. Calling it twice is a no-op; using the instance
   * afterwards throws `ERR_RELEASED`.
   */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.native.release();
  }

  /**
   * Run one native call with a progress subscription scoped to it. Every native
   * entry point takes a job id, so concurrent calls on one model stay
   * distinguishable on the single `progress` event.
   */
  private async run<T>(
    onProgress: ((event: ProgressEvent) => void) | undefined,
    call: (jobId: string) => Promise<T>
  ): Promise<T> {
    nextJobId += 1;
    const jobId = `uhm-${nextJobId}`;
    const subscription = onProgress
      ? this.native.addListener('progress', (event: ProgressEvent) => {
          if (event.jobId === jobId) {
            onProgress(event);
          }
        })
      : undefined;
    try {
      return await call(jobId);
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    } finally {
      subscription?.remove();
    }
  }

  private assertAlive(): void {
    if (this.released) {
      throw toDesertAntError(
        Object.assign(new Error('This Uhm was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

/**
 * Validate the per-call options and flatten them for the wire.
 *
 * `minConfidence` is two states in TypeScript -- a number, or absent for "use
 * the preset" -- and two fields on the wire, so the native record never has to
 * read a threshold of 0 as "the caller said nothing".
 */
function toNativeOptions(options: AnalyzeOptions): NativeAnalyzeOptions {
  const bias = options.bias ?? 'balanced';
  if (!BIASES.includes(bias)) {
    throw invalid(`'${String(bias)}' is not a bias; expected ${BIASES.join(', ')}`);
  }
  const minConfidence = options.minConfidence;
  if (
    minConfidence !== undefined &&
    (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)
  ) {
    throw invalid(`'${String(minConfidence)}' is not a confidence; expected a number in 0..1`);
  }
  const minDurationSec = options.minDurationSec ?? 0.12;
  if (!Number.isFinite(minDurationSec) || minDurationSec < 0) {
    throw invalid(
      `'${String(minDurationSec)}' is not a minimum duration; expected a non-negative number`
    );
  }
  return {
    bias,
    includeTypes: options.includeTypes ?? true,
    minConfidence: minConfidence ?? FALLBACK_THRESHOLDS[bias],
    useBiasThreshold: minConfidence === undefined,
    minDurationSec,
  };
}

function invalid(message: string) {
  return toDesertAntError(
    Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }),
    MODEL
  );
}
