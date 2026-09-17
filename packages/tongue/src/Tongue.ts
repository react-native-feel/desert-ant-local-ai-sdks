import { toDesertAntError } from '@desert-ant-labs/react-native-core';

import NativeTongue, { type NativeTongueModel, type NativeDetectOptions } from './native';
import { type Detection, type DetectOptions } from './types';

const MODEL = 'tongue';

/** `detect`'s `topK` default upstream, for the platforms where the module is not
 *  there to ask. */
const FALLBACK_DEFAULT_TOP_K = 3;

/**
 * The gap `Detection.isTooCloseToCall` requires, mirrored from the literal in
 * `Sources/Tongue/Tongue.swift` and `Tongue.kt`.
 *
 * Neither SDK names it: it is written inline in `isTooCloseToCall` on both
 * platforms, so there is no symbol to read the way `defaultTopK` and
 * `maxCharacters` are read. It is duplicated here anyway for the same reason
 * `Ear.confusableLanguages` is -- it is the answer to the question a `true`
 * provokes, and a caller cannot otherwise put a number on "too close".
 *
 * Nothing branches on it. `isTooCloseToCall` is decided natively and this is here
 * to explain that decision, not to repeat it.
 */
const FALLBACK_TIE_MARGIN = 0.12;

/** `Normalizer.maxCharacters` upstream. Same reason as `defaultTopK`. */
const FALLBACK_MAX_CHARACTERS = 512;

/**
 * On-device language identification for short text: which of 84 languages a few
 * words are in, in tens of microseconds, with nothing downloaded.
 *
 * The text-domain sibling of Ear, which answers the same question from audio.
 * Where Ear listens to ninety seconds of a recording and takes a quarter of a
 * second, Tongue reads three words and takes less time than the bridge hop that
 * carried them -- so it is the one model in this family you can call on every
 * keystroke without thinking about it.
 *
 * ```ts
 * const tongue = await Tongue.load();
 * const read = await tongue.detect('kann ich das haben');
 * read.language      // "de"
 * read.reliability   // "likely"
 * ```
 *
 * **Branch on `reliability`, not on `confidence`.** The probability is a softmax
 * over a handful of labels and is badly overconfident on very short text --
 * `"hi i am"` reads as Welsh at high probability to any character model.
 * `reliability` is keyed off evidence instead: how much text survived
 * normalization, and how far the winner leads the runner-up. Treat `tentative`
 * as "unknown" rather than as an answer with an asterisk.
 *
 * Nothing about this model downloads, and that is the headline difference from
 * the other six here. The whole thing is 2 MB of int8 weights plus a metadata
 * JSON, shipped inside the package -- a SwiftPM target resource on Apple, a jar
 * resource on Android -- so there is no `directory`, no `isDownloaded()`, no
 * progress and no network permission in play.
 */
export class Tongue {
  /**
   * Whether this build can run Tongue.
   *
   * On **Android** this is as broad as it gets in this family: true wherever the
   * module is present. There is no OS floor above the pod's and, unlike Clear,
   * Emo and Ear, no ABI story -- `ai.desertant:tongue` is a pure Kotlin jar with
   * no native library, so every device that runs the app runs Tongue.
   *
   * On **iOS it is false today**, and the reason is worth reading rather than
   * working around. desert-ant-core v3.1.0 declares a `Tongue` SwiftPM product
   * and then omits it from the manifest's `products:` array, so no consumer can
   * link the target at all -- naming it fails the build outright rather than
   * failing an import. The Apple sources in this package are written against the
   * module and guarded by `#if canImport(Tongue)`; when upstream exports the
   * product, adding one array entry to `packages/core/ios/DesertAntCore.podspec`
   * turns them on. {@link unsupportedReason} says all of this at runtime.
   *
   * It is also false anywhere the native module is absent entirely -- an Expo Go
   * session, a web bundle, an app that installed the package and never prebuilt.
   */
  static get isSupported(): boolean {
    return NativeTongue?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. */
  static get unsupportedReason(): string | null {
    if (Tongue.isSupported) {
      return null;
    }
    const native = NativeTongue?.unsupportedReason;
    if (native) {
      return native;
    }
    return (
      'Tongue is not available in this build. The native module did not load -- an Expo Go ' +
      'session or a web bundle, rather than a dev build with the package prebuilt in.'
    );
  }

  /** The desert-ant-core version the native binary links, or null where the
   *  module is absent. */
  static get nativeCoreVersion(): string | null {
    return NativeTongue?.nativeCoreVersion ?? null;
  }

  /**
   * The pinned model revision, or null where the module is absent.
   *
   * It names a Hub tag, and **nothing in this SDK ever fetches it**: the weights
   * are bundled, and the repo mirrors bytes that are sha256-identical to the
   * bundled copies for the sake of the website demo. It is here so a detection
   * can be traced to the weights that produced it, not because there is a
   * download to trace.
   */
  static get modelRevision(): string | null {
    return NativeTongue?.modelRevision ?? null;
  }

  /** The Hugging Face repo mirroring the bundled weights, or null where the
   *  module is absent. Nothing here downloads from it -- see
   *  {@link modelRevision}. */
  static get modelRepo(): string | null {
    return NativeTongue?.modelRepo ?? null;
  }

  /** How many candidates `detect` ranks when the caller does not say. `3`, read
   *  from upstream rather than hardcoded here. */
  static get defaultTopK(): number {
    const native = NativeTongue?.defaultTopK;
    return typeof native === 'number' && native > 0 ? native : FALLBACK_DEFAULT_TOP_K;
  }

  /**
   * The gap below which {@link Detection.isTooCloseToCall} is true:
   * `candidates[0].probability - candidates[1].probability < 0.12`.
   *
   * Exposed for display and for explaining a `true`, not for reimplementing the
   * test -- the flag already applies it. Unlike {@link defaultTopK} and
   * {@link maxCharacters} this one is mirrored rather than read: upstream writes
   * the literal inline in `isTooCloseToCall` on both platforms and names no
   * constant.
   */
  static get tieMargin(): number {
    const native = NativeTongue?.tieMargin;
    return typeof native === 'number' && native > 0 ? native : FALLBACK_TIE_MARGIN;
  }

  /**
   * The scalar cap the normalizer applies before anything is hashed. `512`.
   *
   * Counted in Unicode scalars, not grapheme clusters and not UTF-16 units --
   * the normalizer is a frozen specification ported from Python, which slices by
   * code point. Longer text is not an error; it is truncated, and
   * {@link Detection.normalized} shows exactly what the model saw.
   */
  static get maxCharacters(): number {
    const native = NativeTongue?.maxCharacters;
    return typeof native === 'number' && native > 0 ? native : FALLBACK_MAX_CHARACTERS;
  }

  /**
   * Every UAX#24 script name the router knows, as they appear in
   * {@link Route.script}.
   *
   * Synchronous, which is the safe shape here rather than a convenience: an
   * array of bare strings returned from an async native call is encoded off the
   * JavaScript thread and segfaults the runtime. See `ios/TongueModule.swift`.
   *
   * **Apple only by design, and unavailable everywhere today.** Swift exposes
   * `Script` as a public `CaseIterable` enum and `Router.route` as a public
   * function; in `ai.desertant:tongue` both `Router` and `ScriptTables` are
   * `internal`, and the Kotlin SDK's whole public surface is `Tongue`,
   * `Detection`, `Prediction`, `Route`, `Reliability` and `Verdict`. So on
   * Android this throws `ERR_UNSUPPORTED_PLATFORM` rather than returning a list
   * this package hardcoded -- which would be right until the next model revision
   * and then quietly wrong, with no way for a caller to tell.
   *
   * It throws on iOS too, for now, because the Apple half cannot link the module
   * that holds the enum -- see {@link isSupported}.
   *
   * Note that `Route.script` still works on both platforms. It is the *catalogue*
   * that is Apple-only, not the field.
   */
  static supportedScripts(): string[] {
    const native = NativeTongue?.scripts;
    if (!native || native.length === 0) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            'Tongue.supportedScripts() is iOS-only: ai.desertant:tongue keeps Router and ' +
              'ScriptTables internal, so the Kotlin SDK has no script list to expose. ' +
              'Gate the call on Platform.OS, or read `detection.route.script` instead.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return [...native];
  }

  /**
   * Create the model and parse the bundled weights, so the first `detect` does
   * not have to.
   *
   * There is no download behind this and no network call -- the 2 MB of int8
   * ships in the binary -- so it is a file read and a widen, not a progress bar.
   * On mount is the only reasonable place to call it.
   */
  static async load(): Promise<Tongue> {
    const tongue = Tongue.create();
    try {
      await tongue.warm();
      return tongue;
    } catch (error) {
      tongue.release();
      throw error;
    }
  }

  /**
   * Create the model without parsing anything. The weights are read on the first
   * `warm` or `detect`.
   *
   * Cheap enough to be worth having as a probe -- `Tongue.create().release()`
   * proves the native module bound -- but there is nothing to check afterwards
   * the way `Voz.create().isDownloaded()` checks for half a gigabyte of weights.
   */
  static create(): Tongue {
    const native = Tongue.requireNative();
    try {
      return new Tongue(native.createModel());
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeTongue> {
    if (!NativeTongue) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Tongue.unsupportedReason ??
              'Tongue is not available here. Gate the feature on `Tongue.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeTongue;
  }

  private released = false;

  private constructor(private readonly native: NativeTongueModel) {}

  /**
   * Whether the weights are parsed, so {@link detectSync} will answer rather than
   * refuse.
   *
   * This is where the other models in this family have `isDownloaded()`. The
   * question does not exist here -- nothing is ever absent from the device -- so
   * what is worth asking instead is whether the 2 MB has been read yet.
   */
  isLoaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isLoaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Read the bundled weights and build the pipeline, so the first `detect` pays
   * neither.
   *
   * Takes no progress handler, and that is upstream's shape rather than an
   * omission: there is no download to report on, and `Tongue()` is a
   * throwing initializer with no callback on either platform. Calling it twice is
   * a no-op.
   */
  async warm(): Promise<void> {
    this.assertAlive();
    try {
      await Tongue.requireNative().load(this.native);
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Identify the language of a short string.
   *
   * ```ts
   * const read = await tongue.detect('kann ich das haben');
   * read.language          // "de"
   * read.confidence        // 0.87
   * read.reliability       // "likely"
   * read.route.script      // "Latin"
   * ```
   *
   * Loads the model if `warm` has not run, which is why this is a promise at all
   * -- the detection itself is synchronous underneath and stays on the JavaScript
   * thread. On a warm model {@link detectSync} is the same call without the
   * microtask.
   */
  async detect(text: string, options: DetectOptions = {}): Promise<Detection> {
    this.assertAlive();
    const native = toNativeOptions(text, options);
    if (!this.isLoaded()) {
      await this.warm();
    }
    return this.run(text, native);
  }

  /**
   * Identify the language of a short string, **without a promise**.
   *
   * The reason this exists is the reason the model exists: a detection is an
   * int8 gather, a sum, one small matmul and a masked softmax, and upstream
   * measures it in tens of microseconds on the main thread. Awaiting that costs
   * more than doing it. This is the call to use behind an `onChangeText`.
   *
   * Requires a loaded model -- it will not read 2 MB off disk on the JavaScript
   * thread behind your back. Throws `ERR_MODEL_UNAVAILABLE` if `warm` has not
   * run; `await Tongue.load()` once on mount and it never will.
   */
  detectSync(text: string, options: DetectOptions = {}): Detection {
    this.assertAlive();
    return this.run(text, toNativeOptions(text, options));
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
   * The one native call, shared by both spellings of `detect`.
   *
   * No job id and no progress subscription, unlike every other model here: a
   * Tongue emits no events at all, so there is nothing for concurrent calls to
   * be confused about.
   */
  private run(text: string, options: NativeDetectOptions): Detection {
    try {
      return Tongue.requireNative().detect(this.native, text, options);
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private assertAlive(): void {
    if (this.released) {
      throw toDesertAntError(
        Object.assign(new Error('This Tongue was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

/**
 * Validate the input and the per-call options, and flatten them for the wire.
 *
 * Empty text is deliberately **not** an error. Upstream answers it -- with
 * `reliability: 'empty'`, no candidates and a null language -- and a field that
 * clears while someone is typing should get that answer rather than an
 * exception. What is rejected is a `text` that is not a string at all, and a
 * `topK` that would ask for no candidates.
 */
function toNativeOptions(text: unknown, options: DetectOptions): NativeDetectOptions {
  if (typeof text !== 'string') {
    throw invalid(`detect needs a string; got ${text === null ? 'null' : typeof text}`);
  }
  const topK = options?.topK ?? Tongue.defaultTopK;
  if (!Number.isInteger(topK) || topK < 1) {
    throw invalid(`'${String(topK)}' is not a candidate count; expected a whole number of at least 1`);
  }
  return { topK };
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
