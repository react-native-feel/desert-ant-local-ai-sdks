import { toDesertAntError, toPath, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeVoz, { type NativeVozModel } from './native';
import {
  type TranscribeFileOptions,
  type TranscribeOptions,
  type Transcript,
  type VozLoadOptions,
} from './types';

const MODEL = 'voz';

let nextJobId = 0;

/**
 * On-device speech recognition: a transcript with word-level timestamps, running
 * entirely on the Neural Engine.
 *
 * Create one and reuse it. The weights are **~490 MB** and the first load after
 * downloading them also pays a one-time Neural Engine specialization of roughly
 * 20 seconds; every load after that is about 0.2 s. So a `Voz` is something an
 * app downloads deliberately -- behind a button, with a progress bar -- and then
 * holds for as long as it might transcribe anything.
 *
 * ```ts
 * if (!Voz.isSupported) return;            // Android: the model has no build
 * const voz = await Voz.load({ onProgress: (e) => setProgress(e.fraction) });
 * const { text, words } = await voz.transcribe({ uri: recording.uri });
 * voz.release();
 * ```
 */
export class Voz {
  /**
   * Whether this build can run Voz at all.
   *
   * **False on Android**, and that is upstream: Voz is Core ML only, so
   * `desert-ant-core` publishes no Android artifact for it (`Sources/Voz/Catalog.swift`
   * lists `.apple` and nothing else). Check this before offering the feature;
   * every other member throws `ERR_UNSUPPORTED_PLATFORM` where it is false.
   */
  static get isSupported(): boolean {
    return NativeVoz?.isSupported ?? false;
  }

  /** The desert-ant-core version the native binary links against, or null off iOS. */
  static get nativeCoreVersion(): string | null {
    return NativeVoz?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null off iOS. */
  static get modelRevision(): string | null {
    return NativeVoz?.modelRevision ?? null;
  }

  /**
   * The 25 languages the model was trained on, as ISO 639-1 codes.
   *
   * Worth checking against, because the failure is silent: Voz does **not**
   * detect what it is hearing, and audio in a language outside this set comes
   * back as confident nonsense rather than an error or a low score. An app
   * routing mixed input should establish the language some other way first and
   * compare it with this.
   */
  static get supportedLanguages(): string[] {
    return NativeVoz?.supportedLanguages ?? [];
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then build the Core ML session. Resolves when the next `transcribe` will not
   * have to wait for either.
   *
   * Pass `onProgress` -- on a cold install this is a ~490 MB download.
   */
  static async load(options: VozLoadOptions = {}): Promise<Voz> {
    const voz = Voz.create(options);
    try {
      await voz.warm(options.onProgress);
      return voz;
    } catch (error) {
      voz.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `transcribe`, which is then as slow as a download.
   */
  static create(options: VozLoadOptions = {}): Voz {
    const native = Voz.requireNative();
    try {
      return new Voz(native.createModel({ directory: options.directory }));
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeVoz> {
    if (!NativeVoz) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            'Voz runs on Apple platforms only: desert-ant-core publishes no Android build of ' +
              'this model. Gate the feature on `Voz.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeVoz;
  }

  private released = false;

  private constructor(private readonly native: NativeVozModel) {}

  /** Whether the weights are on the device, so `transcribe` needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Fetch the weights ahead of time, without loading them. A no-op once
   * `isDownloaded()` is true.
   *
   * Use it to get the ~490 MB out of the way during onboarding; `warm` is the
   * one that also pays the Neural Engine specialization.
   */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Voz.requireNative().download(this.native, jobId));
  }

  /**
   * Download if needed, then build the Core ML session, so the first transcribe
   * pays neither.
   *
   * The session build is the part worth doing early: the first load after a
   * download specializes the graph for the Neural Engine, which is ~20 s once per
   * install. Every later load reads that cache in ~0.2 s.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Voz.requireNative().load(this.native, jobId));
  }

  /**
   * Transcribe an audio file.
   *
   * This is the API to reach for. The audio never crosses into JavaScript, and
   * the file is read, downmixed and resampled a chunk at a time, so peak memory
   * does not grow with the recording -- an hour of audio would be 230 MB of
   * `Float` if it were decoded up front.
   */
  async transcribe(options: TranscribeFileOptions): Promise<Transcript> {
    this.assertAlive();
    return this.run(options.onProgress, async (jobId) => {
      await Voz.requireNative().transcribeFile(this.native, toPath(options.uri), jobId);
      // Collected separately, and synchronously -- see `native.ts`.
      return this.native.takeTranscript(jobId);
    });
  }

  /**
   * Transcribe mono samples already in memory.
   *
   * Cheaper than the equivalent on Clear -- the audio only travels one way, and
   * the result is text -- but it still copies every sample into native memory
   * (~3.8 MB per minute at 16 kHz, more before resampling), and it gives up the
   * chunked read. Use it for audio an app synthesized or already holds as
   * floats; use {@link transcribe} for anything that is, or could be, a file.
   *
   * `sampleRate` defaults to 16000, the rate the model runs at. Anything else is
   * resampled natively.
   */
  async transcribeSamples(
    samples: Float32Array | number[],
    sampleRate = 16_000,
    options: TranscribeOptions = {}
  ): Promise<Transcript> {
    this.assertAlive();
    const mono = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    if (mono.length === 0) {
      throw toDesertAntError(
        Object.assign(new Error('transcribeSamples was given no audio'), {
          code: 'ERR_INVALID_ARGUMENT',
        }),
        MODEL
      );
    }
    if (!(sampleRate > 0)) {
      throw toDesertAntError(
        Object.assign(new Error(`'${sampleRate}' is not a sample rate; expected a positive number`), {
          code: 'ERR_INVALID_ARGUMENT',
        }),
        MODEL
      );
    }
    return this.run(options.onProgress, async (jobId) => {
      await Voz.requireNative().transcribeSamples(this.native, mono, sampleRate, jobId);
      // Collected separately, and synchronously -- see `native.ts`.
      return this.native.takeTranscript(jobId);
    });
  }

  /**
   * Release the model. Calling it twice is a no-op; using the instance
   * afterwards throws `ERR_RELEASED`.
   *
   * Worth doing explicitly here: a loaded Voz is holding three Core ML programs
   * and a mapped 10 MB embedding table.
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
    const jobId = `voz-${nextJobId}`;
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
        Object.assign(new Error('This Voz was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}
