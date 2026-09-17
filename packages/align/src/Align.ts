import { toDesertAntError, toPath, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeAlign, { type NativeAlignModel, type NativeTranscribeOptions } from './native';
import {
  type AlignLoadOptions,
  type AlignedTranscript,
  type TranscribeFileOptions,
} from './types';

const MODEL = 'align';

/** Upstream's own default for the refiner's context window, for the platforms
 *  where the module is not there to ask. Kept in step with the
 *  `maxBufferedSeconds: Double = 30` default argument on every
 *  `SpeechTimestampRefiner` initializer. */
const FALLBACK_MAX_BUFFERED_SECONDS = 30;

let nextJobId = 0;

/**
 * On-device word-timestamp refinement: Apple's transcript, with boundaries that
 * land on the word.
 *
 * Align is the one model in this family that does not answer a question. It takes
 * an answer another model already gave -- Apple's `SpeechAnalyzer`, which
 * transcribes well and times loosely -- and moves the numbers. The text is
 * untouched, word for word; only `start` and `end` change, by tens of
 * milliseconds. Upstream measures Apple's mean boundary error at 106.4 ms and its
 * own at 20.2 ms on LibriSpeech test-clean, with 95% of words inside 50 ms; those
 * are upstream's numbers on upstream's corpus. {@link timestampShift} measures
 * what happened on yours.
 *
 * Tens of milliseconds is the difference between a caption that highlights the
 * word you are hearing and one that trails it, and between a cut on a word
 * boundary and a cut through a consonant.
 *
 * ```ts
 * if (!Align.isSupported) return;                       // pre-iOS 26, or Android
 * const align = await Align.load();
 * await align.prepareLocale('en-US');                   // Apple's recognizer
 * const { words, refinedWordCount } = await align.transcribe({
 *   uri: recording.uri,
 *   locale: 'en-US',
 * });
 * console.log(timestampShift(words).meanAbsSec * 1000, 'ms moved on average');
 * ```
 *
 * **Two downloads, not one.** Align's own weights are ~0.7 MB and come from
 * desert-ant-core's catalog, through {@link load}. Apple's on-device speech model
 * for a locale is a separate, much larger download managed by `AssetInventory`,
 * through {@link prepareLocale}. An app that has one and not the other cannot
 * produce a transcript, so both are exposed rather than fused.
 *
 * Nine languages: English, Spanish, French, Italian, Portuguese, German,
 * Japanese, Korean and Chinese. Read {@link supportedLanguages} off a loaded
 * model rather than that sentence -- it comes out of the downloaded config.
 */
export class Align {
  /**
   * Whether this build and this device can run Align at all.
   *
   * **False on Android**, and false on any iOS older than 26. The first is
   * upstream's: desert-ant-core publishes no Android artifact and its manifest
   * records Align's Kotlin and JS SDKs as `none`. The second is subtler and worth
   * knowing, because it is not what it looks like -- Align's *weights* would load
   * on iOS 16. What needs 26 is `SpeechAnalyzer`, and the only public entry point
   * into the refiner takes one of its results.
   *
   * Check this before offering the feature; every other member throws
   * `ERR_UNSUPPORTED_PLATFORM` where it is false.
   */
  static get isSupported(): boolean {
    return NativeAlign?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. Native where the module exists, because only the device knows its own
   *  OS version. */
  static get unsupportedReason(): string | null {
    if (Align.isSupported) {
      return null;
    }
    const native = NativeAlign?.unsupportedReason;
    if (native) {
      return native;
    }
    return (
      'Align runs on Apple platforms only: desert-ant-core ships no Android build, and its ' +
      'manifest records the Kotlin and JavaScript SDKs as none.'
    );
  }

  /**
   * Whether Apple's on-device speech recognition exists on this device at all.
   *
   * Separate from {@link isSupported} because the two fail for different reasons
   * and have different fixes. Both must be true before a transcript is possible.
   */
  static get isAppleSpeechAvailable(): boolean {
    return NativeAlign?.appleSpeechAvailable ?? false;
  }

  /** The desert-ant-core version the native binary links against, or null off iOS. */
  static get nativeCoreVersion(): string | null {
    return NativeAlign?.nativeCoreVersion ?? null;
  }

  /** The model revision this SDK resolves, or null off iOS. Read
   *  {@link revisionIsPinned} beside it. */
  static get modelRevision(): string | null {
    return NativeAlign?.modelRevision ?? null;
  }

  /** The Hugging Face repo the weights come from, or null off iOS. */
  static get modelRepo(): string | null {
    return NativeAlign?.modelRepo ?? null;
  }

  /**
   * Whether {@link modelRevision} names a tag rather than a branch.
   *
   * **False today, and it is the one thing in this package worth reading before
   * shipping.** Every other model in this repo pins a `v`-prefixed tag;
   * `Sources/Align/Catalog.swift` pins `"main"`, with upstream's own
   * `// TODO: pin to a tag once the align model repo is tagged` above it.
   *
   * A branch means a push to the Hub silently changes what already-shipped SDKs
   * download. Two users installing your app a week apart can get different
   * weights and different timestamps, with no version number anywhere moving --
   * not this package's, not desert-ant-core's, and not `modelRevision`, which
   * reads `main` either way. `Sources/Ear/Catalog.swift` writes down why that
   * matters: "a push to the Hub silently changes what already-shipped SDKs
   * download, which is the kind of change nobody is looking for when something
   * starts behaving differently."
   *
   * If reproducibility matters to you, download the weights once, ship them, and
   * pass `directory` to {@link load} so the download never runs. This value is
   * computed from the catalog rather than hardcoded, so it becomes true on its
   * own the day upstream tags the repo.
   */
  static get revisionIsPinned(): boolean {
    return NativeAlign?.revisionIsPinned ?? false;
  }

  /** The refiner's default context window in seconds, as upstream's initializers
   *  default it. */
  static get defaultMaxBufferedSeconds(): number {
    return NativeAlign?.defaultMaxBufferedSeconds ?? FALLBACK_MAX_BUFFERED_SECONDS;
  }

  /**
   * Download Align's weights and get the model ready.
   *
   * ~0.7 MB, so this is a reasonable thing to do on mount. Note what it does
   * *not* do: it does not install Apple's speech model for any locale, which is
   * the larger of the two downloads. Call {@link prepareLocale} for that, or let
   * {@link transcribe} do it on the first call.
   *
   * There is also no Core ML session built here, which is a real difference from
   * every other model in this family rather than an omission.
   * `SpeechTimestampRefiner` builds its two cascade stages in its own
   * initializer, and that initializer is per-locale *and* per-audio-file, so
   * there is nothing to hoist. What `load` buys is that every later call is
   * offline.
   */
  static async load(options: AlignLoadOptions = {}): Promise<Align> {
    const align = Align.create(options);
    try {
      await align.warm(options.onProgress);
      return align;
    } catch (error) {
      align.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved on
   * the first {@link warm} or {@link transcribe}.
   */
  static create(options: AlignLoadOptions = {}): Align {
    const native = Align.requireNative();
    try {
      return new Align(native.createModel({ directory: options.directory }));
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeAlign> {
    if (!NativeAlign) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Align.unsupportedReason ??
              'Align is not available here. Gate the feature on `Align.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeAlign;
  }

  private released = false;

  private constructor(private readonly native: NativeAlignModel) {}

  /** Whether Align's own weights are on the device. Says nothing about Apple's
   *  speech assets; those are per-locale and separate. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * The language codes Align refines -- `['de', 'en', 'es', ...]` -- read out of
   * the downloaded config rather than hardcoded here.
   *
   * Empty before {@link load}, because the map lives in `refiner_config.json`,
   * one of the three sidecars the model downloads. That is why this is a method
   * on a loaded model rather than a static: there is genuinely nothing to answer
   * with beforehand, and a hardcoded list would look like it had been read off
   * the binary while being exactly as stale as a comment.
   *
   * Compare against a locale's language before transcribing, or simply let
   * {@link transcribe} refuse -- it checks the same list.
   */
  supportedLanguages(): string[] {
    this.assertAlive();
    try {
      return this.native.supportedLanguages();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /** Where the weights were resolved to, or `''` before {@link load}. For bug
   *  reports and for an app that wants to ship the directory itself. */
  resolvedDirectory(): string {
    this.assertAlive();
    try {
      return this.native.resolvedDirectory();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download Align's weights and read the language map out of them, so the first
   * {@link transcribe} does not have to.
   *
   * Identical to {@link download}. Both names exist so every model in this repo
   * reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Align.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Install Apple's on-device speech model for a locale.
   *
   * Align's *other* download, and the one desert-ant-core does not manage.
   * Apple's recognizer weights are per-locale, live under `AssetInventory`, and
   * are the larger of the two by a wide margin -- so this is the call to put
   * behind a button and a progress bar, not {@link load}.
   *
   * Idempotent: it returns immediately when the locale is already installed.
   * {@link transcribe} calls it for you, so this exists to let an app pay the
   * cost at a moment of its choosing rather than in the middle of a transcription.
   */
  async prepareLocale(
    locale: string,
    onProgress?: (event: ProgressEvent) => void
  ): Promise<void> {
    this.assertAlive();
    assertLocale(locale);
    await this.run(onProgress, (jobId) =>
      Align.requireNative().prepareLocale(this.native, locale, jobId)
    );
  }

  /**
   * Transcribe an audio file with Apple's recognizer and refine every word
   * boundary.
   *
   * The audio never crosses into JavaScript: the file is read natively, twice --
   * once by Apple's analyzer and once by the refiner through its own handle --
   * and what comes back is words.
   *
   * `locale` is required and is checked twice before any work starts: once as an
   * identifier, and once against the language list in the downloaded config. Both
   * refusals exist because upstream is silent where it should not be -- a locale
   * whose language Align does not know makes `refine` a passthrough that returns
   * Apple's timestamps unchanged, with no error anywhere. Pass `allowUnrefined`
   * if that is what you want, and read `languageRefined` on the result.
   */
  async transcribe(options: TranscribeFileOptions): Promise<AlignedTranscript> {
    this.assertAlive();
    if (typeof options?.uri !== 'string' || options.uri.length === 0) {
      throw invalid('transcribe needs a `uri`: a file:// URI or a path to audio');
    }
    const native = toNativeOptions(options);
    return this.run(options.onProgress, async (jobId) => {
      await Align.requireNative().transcribe(this.native, toPath(options.uri), native, jobId);
      // Synchronous on purpose: the record is encoded on the JavaScript thread.
      // See `native.ts`.
      return this.native.takeTranscript(jobId);
    });
  }

  /**
   * Release the model. Calling it twice is a no-op; using the instance afterwards
   * throws `ERR_RELEASED`.
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
    const jobId = `align-${nextJobId}`;
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
        Object.assign(new Error('This Align was released and can no longer be used.'), {
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
 * Every check here is repeated natively, and that is deliberate rather than
 * redundant: the native side is where the refusal has to live, because a native
 * caller can reach it without passing through this file, and this side is where
 * the refusal is cheap and where the error message can name the JavaScript
 * property that caused it.
 */
function toNativeOptions(options: TranscribeFileOptions): NativeTranscribeOptions {
  assertLocale(options.locale);
  const maxBufferedSeconds = options.maxBufferedSeconds ?? FALLBACK_MAX_BUFFERED_SECONDS;
  if (!Number.isFinite(maxBufferedSeconds) || maxBufferedSeconds <= 0) {
    throw invalid(
      `'${String(maxBufferedSeconds)}' is not a buffer length; expected a positive number of seconds`
    );
  }
  return {
    locale: options.locale.trim(),
    allowUnrefined: options.allowUnrefined ?? false,
    maxBufferedSeconds,
  };
}

/**
 * Refuse a locale that does not name a language.
 *
 * Upstream accepts anything: `Locale(identifier:)` never fails, so `''`,
 * `'english'` and `'en US'` all produce a refiner with no language id -- which
 * means `refine` returns Apple's timestamps unchanged and reports nothing. That
 * is the failure mode this repo refuses on principle: a typo that silently voids
 * a result is worse than an error.
 *
 * The test is deliberately shallow -- two or three letters, optionally followed
 * by a region or script subtag -- because the real check is the one the native
 * side does against the model's own language map, and a second opinion about
 * which of the world's locale identifiers are well-formed would only be wrong in
 * a different way. What this catches is the empty string, the sentence, and the
 * one with a space in it.
 */
function assertLocale(locale: unknown): asserts locale is string {
  if (typeof locale !== 'string' || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale.trim())) {
    throw invalid(
      `'${String(locale)}' is not a locale identifier; expected something like 'en-US', ` +
        `'es-ES' or 'ja-JP'`
    );
  }
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
