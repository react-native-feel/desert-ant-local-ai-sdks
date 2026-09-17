import { toDesertAntError, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeEmo, { type NativeEmoModel, type NativeSuggestOptions } from './native';
import {
  type EmojiSkinTone,
  type EmoLoadOptions,
  type EmoSuggestion,
  type SuggestOptions,
} from './types';

const MODEL = 'emo';

/** The tones the native enums accept, for the platforms where the native module
 *  is not there to ask. Kept in step with `EmojiSkinTone` upstream -- the Swift
 *  enum and the Kotlin one, which agree. */
const FALLBACK_SKIN_TONES: EmojiSkinTone[] = [
  'default',
  'light',
  'mediumLight',
  'medium',
  'mediumDark',
  'dark',
];

/** `limit: Int = 3` in `Emo.suggestions(for:limit:skinTone:)`. */
const FALLBACK_DEFAULT_LIMIT = 3;

let nextJobId = 0;

/**
 * On-device emoji suggestion: a short phrase in, the emoji that fit it out, in
 * 22 languages and without a network call.
 *
 * Small and fast enough to run per keystroke -- ~5 MB of weights on Apple,
 * ~11 MB on Android, and a suggestion in about two milliseconds -- which is the
 * whole reason to prefer it to a lookup table. A table matches words; this reads
 * the phrase. "Pay my bills" gets 💰 without either of those words appearing in
 * an emoji's name, and the same phrase in Japanese or Arabic gets the same
 * answer, because the semantic stream is multilingual rather than 22 tables.
 *
 * Create one and reuse it. Load it on mount: unlike Voz's 490 MB or Clips' 288 MB
 * there is nothing here worth putting behind a button.
 *
 * ```ts
 * const emo = await Emo.load();
 * const suggestions = await emo.suggest('Pay my bills');
 * // [{ emoji: '💰', confidence: 0.62 }, { emoji: '💳', ... }, { emoji: '🧾', ... }]
 *
 * const one = await emo.best('go for a run', { skinTone: 'medium' });
 * // { emoji: '🏃🏽', confidence: 0.55 }
 * ```
 *
 * Tuned for short, intent-oriented text -- a task, a calendar entry, a message
 * draft. Long-form text still returns something, but the ranking gets noisier the
 * further it is from what the model was trained on, so truncate rather than
 * feeding it a paragraph.
 *
 * Upstream's Swift, Kotlin and JavaScript SDKs spell this call `suggestions`.
 * Here it is `suggest`, matching the verb every other model in this repo uses --
 * `enhance`, `transcribe`, `find`, `analyze` -- since the two names cannot both
 * be the house style.
 */
export class Emo {
  /**
   * Whether this build can run Emo at all.
   *
   * **True on both platforms**, which makes Emo the second model here after Clear
   * with an Android half: `desert-ant-core` publishes a LiteRT export and
   * `ai.desertant:emo` is on Maven Central. It can still be false on an Android
   * device whose ABI LiteRT does not ship -- the bundled config plugin narrows
   * the app to `arm64-v8a` and `x86_64` for that reason -- and off both
   * platforms, where the native module is not there to ask.
   */
  static get isSupported(): boolean {
    return NativeEmo?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. On Android it names the ABIs the device actually reported. */
  static get unsupportedReason(): string | null {
    if (Emo.isSupported) {
      return null;
    }
    const native = NativeEmo?.unsupportedReason;
    if (typeof native === 'string' && native.length > 0) {
      return native;
    }
    return (
      'Emo is not available in this build. It runs on iOS and Android; a web build, or a ' +
      'native build that was not regenerated after the package was installed, has no module to call.'
    );
  }

  /** The desert-ant-core version the native binary links against, or null where
   *  there is no native module. */
  static get nativeCoreVersion(): string | null {
    return NativeEmo?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null where there is no
   *  native module. */
  static get modelRevision(): string | null {
    return NativeEmo?.modelRevision ?? null;
  }

  /** The Hub repository the weights come from, or null where there is no native
   *  module. */
  static get modelRepo(): string | null {
    return NativeEmo?.modelRepo ?? null;
  }

  /**
   * Every skin tone {@link SuggestOptions.skinTone} accepts.
   *
   * Read this rather than hardcoding the list if you are building a tone picker:
   * the set is the native enum's, and this reports what the linked binary
   * actually accepts rather than what this package was written against.
   */
  static get skinTones(): EmojiSkinTone[] {
    const native = NativeEmo?.skinTones;
    return native && native.length > 0 ? (native as EmojiSkinTone[]) : [...FALLBACK_SKIN_TONES];
  }

  /** How many suggestions a `suggest` call returns when it is not told. */
  static get defaultLimit(): number {
    const native = NativeEmo?.defaultLimit;
    return typeof native === 'number' && native > 0 ? native : FALLBACK_DEFAULT_LIMIT;
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then build the session. Resolves when the next `suggest` will not have to
   * wait for either.
   *
   * Reasonable on mount, and the only model in this repo where that is true
   * without a caveat -- a few megabytes and a session build in the low
   * milliseconds.
   */
  static async load(options: EmoLoadOptions = {}): Promise<Emo> {
    const emo = Emo.create(options);
    try {
      await emo.warm(options.onProgress);
      return emo;
    } catch (error) {
      emo.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `suggest`, which is then as slow as a download.
   */
  static create(options: EmoLoadOptions = {}): Emo {
    const native = Emo.requireNative();
    try {
      return new Emo(native.createModel({ directory: options.directory }));
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeEmo> {
    if (!NativeEmo) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Emo.unsupportedReason ??
              'Emo is not available here. Gate the feature on `Emo.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeEmo;
  }

  private released = false;

  private constructor(private readonly native: NativeEmoModel) {}

  /** Whether the weights are on the device, so `suggest` needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download the weights and build the session, so the first `suggest` pays
   * neither.
   *
   * Identical to {@link download} -- upstream exposes one call that does both, so
   * unlike Clear and Voz there is no download-only step to run separately. Both
   * names exist so every model in this repo reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Emo.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. See its note. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Suggest emoji for `text`, most likely first.
   *
   * Empty or whitespace-only input returns `[]` without calling the model, which
   * is what makes this safe to call on every keystroke: a cleared field costs
   * nothing, and the model itself is ~2 ms. Still debounce if the field can move
   * faster than the render loop -- not to protect the model, but to avoid
   * rendering three suggestion rows per frame.
   */
  async suggest(text: string, options: SuggestOptions = {}): Promise<EmoSuggestion[]> {
    this.assertAlive();
    if (typeof text !== 'string') {
      throw invalid(`suggest needs a string; got ${typeof text}`);
    }
    // Upstream trims and short-circuits empty input too, in both Swift and
    // Kotlin. Doing it here as well saves the bridge hop, and means the same
    // input returns the same `[]` even before the weights have arrived.
    if (text.trim().length === 0) {
      return [];
    }
    const native = toNativeOptions(options);
    return this.run(undefined, async (jobId) => {
      await Emo.requireNative().suggest(this.native, text, native, jobId);
      // Collected separately, and synchronously -- see `native.ts`.
      return this.native.takeSuggestions(jobId);
    });
  }

  /**
   * The single best emoji for `text`, or null when there is none.
   *
   * `suggest` with `limit: 1`, which is the case the model is actually tuned for
   * -- upstream optimizes for top-1 relevance, and the tail of the ranking is
   * weaker than its head. Null rather than a throw for empty input, so a caller
   * rendering one glyph next to a text field can do it without a guard.
   */
  async best(text: string, options: Omit<SuggestOptions, 'limit'> = {}): Promise<EmoSuggestion | null> {
    const suggestions = await this.suggest(text, { ...options, limit: 1 });
    return suggestions[0] ?? null;
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
   *
   * `suggest` passes no handler: it emits nothing. The model reports progress
   * while it loads, and inference is one shot at a couple of milliseconds -- a
   * fraction over that is a number no UI can use.
   */
  private async run<T>(
    onProgress: ((event: ProgressEvent) => void) | undefined,
    call: (jobId: string) => Promise<T>
  ): Promise<T> {
    nextJobId += 1;
    const jobId = `emo-${nextJobId}`;
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
        Object.assign(new Error('This Emo was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

/** Validate the per-call options and flatten them for the wire. */
function toNativeOptions(options: SuggestOptions): NativeSuggestOptions {
  const limit = options.limit ?? Emo.defaultLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw invalid(`'${String(limit)}' is not a limit; expected a whole number of at least 1`);
  }
  const skinTone = options.skinTone ?? 'default';
  if (!Emo.skinTones.includes(skinTone)) {
    throw invalid(`'${String(skinTone)}' is not a skin tone; expected ${Emo.skinTones.join(', ')}`);
  }
  return { limit, skinTone };
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
