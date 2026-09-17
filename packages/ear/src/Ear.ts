import { toDesertAntError, toPath, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeEar, { type NativeEarModel, type NativeIdentifyOptions } from './native';
import {
  type Detection,
  type EarLoadOptions,
  type IdentifyFileOptions,
  type IdentifyOptions,
} from './types';

const MODEL = 'ear';

/** `Ear.defaultWindows` upstream, for the platforms where the module is not there
 *  to ask. */
const FALLBACK_DEFAULT_WINDOWS = 3;

/** `Detection.reliableMargin` upstream. Same reason. */
const FALLBACK_RELIABLE_MARGIN = 0.25;

/**
 * The languages an answer names without carrying information.
 *
 * Mirrored from `confusableLanguages` in `Sources/Ear/Languages.swift` rather
 * than read from it: the set is `internal` there, so neither platform SDK
 * exposes it. It is duplicated here anyway because it is the answer to the
 * question `isReliable === false` provokes -- "is this one of the two cases, and
 * which?" -- and a caller cannot otherwise tell a Nordic answer apart from a
 * close-margin one.
 *
 * Nothing branches on this list. `isReliable` is decided natively and already
 * accounts for it; this is here to explain that decision, not to repeat it.
 */
const CONFUSABLE_LANGUAGES = ['no', 'sv', 'da'] as const;

let nextJobId = 0;

/**
 * On-device spoken language identification: which of 99 languages a recording is
 * in, before anything transcribes it.
 *
 * The problem it solves is routing. A transcriber has to be told what language
 * it is listening to, or be a much larger model that works it out -- and asking
 * the user is the wrong question at the wrong time. Ear listens to about ninety
 * seconds of the file, in three thirty-second windows chosen by how speech-like
 * they sound, and names the language in ~250 ms.
 *
 * Create one and reuse it. The weights are ~9 MB, small enough to load on mount.
 *
 * ```ts
 * if (!Ear.isSupported) return;            // an ABI LiteRT does not ship
 * const ear = await Ear.load();
 * const heard = await ear.identify({ uri: recording.uri });
 * if (heard.isReliable) {
 *   route(heard.language);                 // "pt"
 * } else {
 *   ask();                                 // the answer is a bet, not a fact
 * }
 * ```
 *
 * **Branch on `isReliable`, not on `confidence`.** They disagree in the case the
 * flag exists for: the detector reads Norwegian as Swedish in roughly 40% of
 * clips and is confident when it does, so a probability threshold passes an
 * answer that a calibrated rule rejects. On Desert Ant's 162-recording corpus,
 * 98.5% of the answers marked reliable routed to the right transcriber.
 */
export class Ear {
  /**
   * Whether this build and this device can run Ear.
   *
   * Unlike Voz, Clips and Uhm this is not an "Apple only" flag -- upstream ships
   * both a Core ML export and a LiteRT one, and `ai.desertant:ear` is published.
   * It is false in two narrower cases: an Android device whose ABI LiteRT does
   * not ship (`arm64-v8a` and `x86_64` are the two it does), and any build where
   * the native module is not present at all, such as Expo Go or web.
   */
  static get isSupported(): boolean {
    return NativeEar?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. On Android it names the ABIs the device actually reported, which is
   *  why it is computed natively rather than written here. */
  static get unsupportedReason(): string | null {
    if (Ear.isSupported) {
      return null;
    }
    const native = NativeEar?.unsupportedReason;
    if (native) {
      return native;
    }
    return (
      'Ear is not available in this build. The native module did not load -- an Expo Go ' +
      'session or a web bundle, rather than a dev build with the package prebuilt in.'
    );
  }

  /** The desert-ant-core version the native binary links against, or null where
   *  the module is absent. */
  static get nativeCoreVersion(): string | null {
    return NativeEar?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null where the module is
   *  absent. */
  static get modelRevision(): string | null {
    return NativeEar?.modelRevision ?? null;
  }

  /** The Hugging Face repo the weights come from, or null where the module is
   *  absent. */
  static get modelRepo(): string | null {
    return NativeEar?.modelRepo ?? null;
  }

  /**
   * How many windows an `identify` listens to when the caller does not say.
   *
   * Read from upstream rather than hardcoded here. See {@link IdentifyOptions.windows}
   * for why raising it buys less than it appears to.
   */
  static get defaultWindows(): number {
    const native = NativeEar?.defaultWindows;
    return typeof native === 'number' && native > 0 ? native : FALLBACK_DEFAULT_WINDOWS;
  }

  /**
   * How far ahead the top candidate must be before {@link Detection.isReliable}
   * is true: `candidates[0].probability - candidates[1].probability`.
   *
   * Calibrated by Desert Ant against 162 recordings. At this margin the detector
   * answers four files in five and is right 98.5% of the time it does; at 0.80 it
   * is right 100% of the time and declines a fifth of the corpus, which is a
   * worse trade for anyone who has to do something with the remainder.
   *
   * Exposed for display and for understanding a `false`, not for reimplementing
   * the test -- the flag already applies it, and applies the Nordic rule that a
   * margin test cannot express.
   */
  static get reliableMargin(): number {
    const native = NativeEar?.reliableMargin;
    return typeof native === 'number' && native > 0 ? native : FALLBACK_RELIABLE_MARGIN;
  }

  /**
   * The languages for which {@link Detection.isReliable} is always false.
   *
   * Norwegian, Swedish and Danish. The detector confuses them with each other
   * confidently rather than uncertainly, so their probability does not reveal the
   * problem -- which is why a margin test cannot catch the case and this list
   * exists alongside it.
   *
   * Useful for explaining a `false` to a user: an answer of `sv` with a high
   * confidence and `isReliable === false` is this rule, not a close call.
   *
   * ```ts
   * const nordic = heard.language !== null && Ear.confusableLanguages.includes(heard.language);
   * ```
   */
  static get confusableLanguages(): string[] {
    return [...CONFUSABLE_LANGUAGES];
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then build the session. Resolves when the next `identify` will not have to
   * wait for either.
   *
   * ~9 MB, so unlike Voz and Clips this is a reasonable thing to do on mount.
   */
  static async load(options: EarLoadOptions = {}): Promise<Ear> {
    const ear = Ear.create(options);
    try {
      await ear.warm(options.onProgress);
      return ear;
    } catch (error) {
      ear.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `identify`, which is then as slow as a download.
   */
  static create(options: EarLoadOptions = {}): Ear {
    const native = Ear.requireNative();
    try {
      return new Ear(native.createModel({ directory: options.directory }));
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeEar> {
    if (!NativeEar) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Ear.unsupportedReason ??
              'Ear is not available here. Gate the feature on `Ear.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeEar;
  }

  private released = false;

  private constructor(private readonly native: NativeEarModel) {}

  /** Whether the weights are on the device, so `identify` needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download the weights and build the session, so the first `identify` pays
   * neither.
   *
   * Identical to {@link download} -- upstream exposes one call that does both, so
   * unlike Clear and Voz there is no download-only step to run separately. Both
   * names exist so every model in this repo reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Ear.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. See its note. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Name the language of an audio or video file.
   *
   * This is the API to reach for. The audio never crosses into JavaScript: the
   * file is decoded natively to mono 16 kHz, and what comes back is a handful of
   * candidates.
   *
   * ```ts
   * const heard = await ear.identify({ uri: recording.uri });
   * heard.language      // "pt"
   * heard.confidence    // 0.91
   * heard.isReliable    // true
   * ```
   */
  async identify(options: IdentifyFileOptions): Promise<Detection> {
    this.assertAlive();
    if (typeof options?.uri !== 'string' || options.uri.length === 0) {
      throw invalid('identify needs a `uri`: a file:// URI or a path to audio');
    }
    const native = toNativeOptions(options);
    return this.run(options.onProgress, (jobId) =>
      Ear.requireNative().identifyFile(this.native, toPath(options.uri), native, jobId)
    );
  }

  /**
   * Name the language of mono samples already in memory.
   *
   * Every sample is copied into native memory (~3.8 MB per minute at 16 kHz, more
   * before resampling), so prefer {@link identify} for anything that is, or could
   * be, a file. This is for audio an app synthesized or already holds as floats.
   *
   * `sampleRate` defaults to 16000, the rate the model runs at. Anything else is
   * resampled natively.
   */
  async identifySamples(
    samples: Float32Array | number[],
    sampleRate = 16_000,
    options: IdentifyOptions = {}
  ): Promise<Detection> {
    this.assertAlive();
    const mono = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
    if (mono.length === 0) {
      throw invalid('identifySamples was given no audio');
    }
    if (!(sampleRate > 0)) {
      throw invalid(`'${String(sampleRate)}' is not a sample rate; expected a positive number`);
    }
    const native = toNativeOptions(options);
    return this.run(options.onProgress, (jobId) =>
      Ear.requireNative().identifySamples(this.native, mono, sampleRate, native, jobId)
    );
  }

  /**
   * Every language this model can name, as ISO codes.
   *
   * Loads the model if it is not loaded -- the list is a sidecar downloaded with
   * the weights, not a constant -- so call it on a warm model, or expect a
   * download.
   *
   * **Apple only.** `ai.desertant:ear` publishes `Ear`, `Detection`,
   * `LanguageCandidate` and `Options`, and nothing that reads the sidecar, so on
   * Android this throws `ERR_UNSUPPORTED_PLATFORM` rather than returning a list
   * this package made up. Gate a "languages we support" screen on
   * `Platform.OS === 'ios'`, or ship the list yourself.
   */
  async supportedLanguages(): Promise<string[]> {
    this.assertAlive();
    // Two calls rather than one, and not for caching: the async half returns
    // nothing and the array is read back synchronously, because a `@JS async`
    // function returning `[String]` encodes it off the JavaScript thread and
    // segfaults the runtime. ios/EarModel.swift carries the full account.
    await this.run(undefined, (jobId) => Ear.requireNative().loadLanguages(this.native, jobId));
    try {
      return this.native.languages();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
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
    const jobId = `ear-${nextJobId}`;
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
        Object.assign(new Error('This Ear was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

/** Validate the per-call options and flatten them for the wire. */
function toNativeOptions(options: IdentifyOptions): NativeIdentifyOptions {
  const windows = options.windows ?? Ear.defaultWindows;
  if (!Number.isInteger(windows) || windows < 1) {
    throw invalid(`'${String(windows)}' is not a window count; expected a whole number of at least 1`);
  }
  return { windows };
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
