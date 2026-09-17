import { toDesertAntError, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeClear, { type NativeClearAudio, type NativeClearModel } from './native';
import { toNativeOptions } from './options';
import {
  type ClearLoadOptions,
  type ClearMetrics,
  type EnhanceFileOptions,
  type EnhanceFileResult,
  type EnhanceOptions,
  type EnhanceSamplesResult,
} from './types';
import { defaultOutputPath, toPath, toUri } from './uri';

const MODEL = 'clear';

let nextJobId = 0;

/**
 * On-device speech enhancement: denoise, dereverb, loudness-normalize.
 *
 * Create one and reuse it. The first-ever load downloads ~9 MB of weights and,
 * on Apple, compiles the Core ML program for the Neural Engine -- seconds, once
 * per install. Every load after that is milliseconds, so a `Clear` held for the
 * life of a screen is the difference between an instant result and a spinner.
 *
 * ```ts
 * const clear = await Clear.load();
 * const { uri, realtimeFactor } = await clear.enhance({ uri: recording.uri });
 * clear.release();
 * ```
 */
export class Clear {
  /**
   * False when this build cannot run Clear at all -- an Android ABI with no
   * LiteRT binary. Check it before offering the feature; every other method
   * throws `ERR_UNSUPPORTED_PLATFORM` here.
   */
  static get isSupported(): boolean {
    return NativeClear.isSupported;
  }

  /** The desert-ant-core version the native binary links against. */
  static get nativeCoreVersion(): string {
    return NativeClear.nativeCoreVersion;
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then (on Apple) build the session. Resolves when the next `enhance` will not
   * have to wait for either.
   */
  static async load(options: ClearLoadOptions = {}): Promise<Clear> {
    const clear = Clear.create(options);
    try {
      await clear.warm(options.onProgress);
      return clear;
    } catch (error) {
      clear.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `enhance`, which is then as slow as a download.
   */
  static create(options: ClearLoadOptions = {}): Clear {
    try {
      return new Clear(
        NativeClear.createModel({
          variant: options.variant ?? 'clear-studio',
          directory: options.directory,
        })
      );
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private released = false;

  private constructor(private readonly native: NativeClearModel) {}

  /** Whether the weights are on the device, so `enhance` needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /** Fetch the weights ahead of time. A no-op once `isDownloaded()` is true. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => NativeClear.download(this.native, jobId));
  }

  /**
   * Download if needed, then build the session, so the first enhance pays
   * neither. On Android this stops after the download: `ai.desertant:clear`
   * builds its LiteRT session lazily inside the first `enhance` and exposes no
   * way to ask for it early.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => NativeClear.load(this.native, jobId));
  }

  /**
   * Enhance an audio file and write the result next to it.
   *
   * This is the API to reach for. The audio never crosses into JavaScript, so a
   * two-minute recording costs the same call as a two-second one, and on Apple
   * the work runs as a streaming pass whose peak memory does not grow with the
   * file.
   */
  async enhance(options: EnhanceFileOptions): Promise<EnhanceFileResult> {
    this.assertAlive();
    const inputPath = toPath(options.uri);
    const outputPath = options.outputUri ? toPath(options.outputUri) : defaultOutputPath(inputPath);
    const { outputPath: written, ...metrics } = await this.run(options.onProgress, async (jobId) => {
      await NativeClear.enhanceFile(
        this.native,
        inputPath,
        outputPath,
        toNativeOptions(options),
        jobId
      );
      // Collected separately, and synchronously -- see `native.ts`.
      return NativeClear.takeMetrics(this.native, jobId);
    });
    // Trust the native side over the request: iOS re-encodes a non-WAV input as
    // WAV, so the extension it wrote may not be the one that was asked for.
    return { ...metrics, uri: toUri(written || outputPath) };
  }

  /**
   * Enhance samples already in memory.
   *
   * Second-class next to {@link enhance}: every sample is copied into native
   * memory and back out again, which for a minute of 48 kHz mono is ~11 MB each
   * way. Use it for audio an app synthesized or already holds as floats; use
   * `enhance` for anything that is, or could be, a file.
   *
   * Pass one run of samples for mono, or one entry per channel. The output is
   * mono unless `channelMode` is `preserve`.
   */
  async enhanceSamples(
    samples: Float32Array | Float32Array[] | number[] | number[][],
    sampleRate = 48_000,
    options: EnhanceOptions = {}
  ): Promise<EnhanceSamplesResult> {
    this.assertAlive();
    const channels = normalizeChannels(samples);
    if (channels.length === 0 || channels[0]!.length === 0) {
      throw toDesertAntError(
        Object.assign(new Error('enhanceSamples was given no audio'), {
          code: 'ERR_INVALID_ARGUMENT',
        }),
        MODEL
      );
    }
    const frameCount = channels[0]!.length;
    if (channels.some((channel) => channel.length !== frameCount)) {
      throw toDesertAntError(
        Object.assign(new Error('every channel must hold the same number of samples'), {
          code: 'ERR_INVALID_ARGUMENT',
        }),
        MODEL
      );
    }

    let input: NativeClearAudio | undefined;
    let output: NativeClearAudio | undefined;
    let lastJobId = '';
    try {
      input = NativeClear.createAudio(channels.length, frameCount, sampleRate);
      channels.forEach((channel, index) => input!.write(index, channel));

      const metrics = await this.run(options.onProgress, async (jobId) => {
        lastJobId = jobId;
        await NativeClear.enhanceBuffer(this.native, input!, toNativeOptions(options), jobId);
        // Collected separately, and synchronously -- see `native.ts`.
        return NativeClear.takeMetrics(this.native, jobId);
      });
      output = NativeClear.takeEnhancedAudio(this.native, lastJobId);

      const out: Float32Array[] = [];
      for (let index = 0; index < output.channelCount; index += 1) {
        const channel = new Float32Array(output.frameCount);
        output.read(index, channel);
        out.push(channel);
      }
      return { ...metrics, channels: out, samples: out[0] ?? new Float32Array(0) };
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    } finally {
      // The native buffers hold the whole programme twice over. Hand both back
      // now rather than waiting for two garbage collectors to agree.
      input?.release();
      output?.release();
    }
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
    const jobId = `clear-${nextJobId}`;
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
        Object.assign(new Error('This Clear was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

function normalizeChannels(
  samples: Float32Array | Float32Array[] | number[] | number[][]
): Float32Array[] {
  if (samples instanceof Float32Array) {
    return [samples];
  }
  if (!Array.isArray(samples)) {
    return [];
  }
  if (samples.length === 0) {
    return [];
  }
  const first = samples[0];
  if (typeof first === 'number') {
    return [Float32Array.from(samples as number[])];
  }
  return (samples as (Float32Array | number[])[]).map((channel) =>
    channel instanceof Float32Array ? channel : Float32Array.from(channel)
  );
}

export type { ClearMetrics };
