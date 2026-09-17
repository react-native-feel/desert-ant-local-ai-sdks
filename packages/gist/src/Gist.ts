import { toDesertAntError, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeGist, {
  type NativeClassifyOptions,
  type NativeGistModel,
  type NativeTagging,
} from './native';
import {
  type ClassifyOptions,
  type Distribution,
  type GistLoadOptions,
  type GistVariant,
  type RollupOptions,
  type Tagging,
  type Topic,
} from './types';

const MODEL = 'gist';

/** `topK: Int = 3` upstream, for the platforms where the module is not there to
 *  ask. Mirrored rather than read even natively -- it is a default argument in
 *  two signatures, not a constant either SDK exposes. */
const FALLBACK_DEFAULT_TOP_K = 3;

/** `GistVariant.default` upstream. */
const FALLBACK_DEFAULT_VARIANT: GistVariant = 'multilingual';

/** `RollupOptions()` upstream, field for field, for the same no-module case. The
 *  binary's own values win wherever there is a binary to ask. */
const FALLBACK_ROLLUP_OPTIONS: Required<RollupOptions> = {
  topN: 5,
  floor: 0.05,
  minPosts: 3,
  halfLifeDays: 0,
  touch: 0.15,
  nowMillis: 0,
};

/** The sentinel that means "use the model's own tuned threshold". A probability
 *  is never negative, so this cannot collide with one a caller meant. */
const INHERIT_THRESHOLD = -1;

let nextJobId = 0;

/**
 * On-device content topic tagging: what a post or an article is *about*, from a
 * fixed 36-topic taxonomy, in 101 languages, with no server call.
 *
 * Multi-label rather than single-label -- the scores are independent
 * probabilities and most items carry two or three topics -- and there is no
 * language setting to pass in: one model covers all 101. Upstream measures the
 * right topic inside the top three 91% of the time on 572 human-labelled real
 * posts.
 *
 * ```ts
 * if (!Gist.isSupported) return;             // an ABI LiteRT does not ship
 * const gist = await Gist.load();            // ~74 MB, so not on mount
 * const { topics } = await gist.classify('How to start a podcast with your iPhone');
 * topics[0];   // { slug: 'technology', name: 'Technology & Software', score: 0.91 }
 * ```
 *
 * It is a two-stream classifier with no transformer in it: a static multilingual
 * embedding table pooled over the tokens, hashed word and character n-grams
 * beside it, and one MLP head over the concatenation. That is why it costs CPU
 * time and nothing else, and why it is the one model in this family whose
 * *download* dwarfs its inference.
 *
 * **What it does not do.** It tags what a text is about, not whether the text is
 * good or safe. The 36 topics are a fixed list, so a subject outside the list
 * lands on the nearest topic on it rather than on nothing -- which is why
 * {@link Tagging.topics} always carries a top topic and
 * {@link Tagging.threshold} is worth reading next to it.
 */
export class Gist {
  /**
   * Whether this build and this device can run Gist.
   *
   * Like Clear, Emo and Ear and unlike Voz, Clips and Uhm, this is not an "Apple
   * only" flag -- upstream ships a Core ML export *and* a LiteRT one, and
   * `ai.desertant:gist` is published. It is false in two narrower cases: an
   * Android device whose ABI LiteRT does not ship (`arm64-v8a` and `x86_64` are
   * the two it does), and any build where the native module is not present at
   * all, such as Expo Go or web.
   */
  static get isSupported(): boolean {
    return NativeGist?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. On Android it names the ABIs the device actually reported, which is
   *  why it is computed natively rather than written here. */
  static get unsupportedReason(): string | null {
    if (Gist.isSupported) {
      return null;
    }
    const native = NativeGist?.unsupportedReason;
    if (native) {
      return native;
    }
    return (
      'Gist is not available in this build. The native module did not load -- an Expo Go ' +
      'session or a web bundle, rather than a dev build with the package prebuilt in.'
    );
  }

  /** The desert-ant-core version the native binary links against, or null where
   *  the module is absent. */
  static get nativeCoreVersion(): string | null {
    return NativeGist?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null where the module is
   *  absent. Both variants live at this revision -- multilingual at the repo
   *  root, English under `en/`. */
  static get modelRevision(): string | null {
    return NativeGist?.modelRevision ?? null;
  }

  /** The Hugging Face repo the weights come from, or null where the module is
   *  absent. */
  static get modelRepo(): string | null {
    return NativeGist?.modelRepo ?? null;
  }

  /**
   * How many topics a `classify` returns when the caller does not say.
   *
   * Mirrored from upstream rather than read off it, because on both platforms it
   * is a default argument in a signature rather than a constant the SDK exposes.
   * It is forwarded through the native module anyway so the two platforms cannot
   * show different numbers for the same claim -- upstream's "in the top three
   * 91% of the time" is measured at this value.
   */
  static get defaultTopK(): number {
    const native = NativeGist?.defaultTopK;
    return typeof native === 'number' && native >= 1 ? native : FALLBACK_DEFAULT_TOP_K;
  }

  /**
   * Every model build this platform can actually load.
   *
   * **Two on iOS, one on Android**, and that asymmetry is upstream's: `Gist`'s
   * Swift initializer takes a `variant`, while `ai.desertant:gist`'s whole
   * constructor is `Gist(context, directory)` and its own documentation says the
   * English build is Swift-only today. Read off the binary rather than written
   * here, so a released Kotlin SDK that gains a variant lights up without a
   * change on this side.
   *
   * Gate a variant picker on this rather than on `Platform.OS`.
   */
  static get variants(): GistVariant[] {
    const native = NativeGist?.variants;
    if (Array.isArray(native) && native.length > 0) {
      return native.filter(isVariant);
    }
    return [FALLBACK_DEFAULT_VARIANT];
  }

  /** The build a `Gist` loads unless told otherwise: `'multilingual'`, the ~74 MB
   *  101-language model. */
  static get defaultVariant(): GistVariant {
    const native = NativeGist?.defaultVariant;
    return isVariant(native) ? native : FALLBACK_DEFAULT_VARIANT;
  }

  /**
   * `channelTopics`' own defaults, read off the native binary.
   *
   * Here so a roll-up form can be laid out without this package restating six
   * numbers that upstream owns and is free to retune. Nothing branches on them --
   * {@link channelTopics} applies them natively whether or not they are passed.
   */
  static get defaultRollupOptions(): Required<RollupOptions> {
    const native = NativeGist?.defaultRollupOptions;
    if (!native || typeof native !== 'object') {
      return { ...FALLBACK_ROLLUP_OPTIONS };
    }
    const merged = { ...FALLBACK_ROLLUP_OPTIONS };
    for (const key of Object.keys(merged) as (keyof Required<RollupOptions>)[]) {
      const value = native[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        merged[key] = value;
      }
    }
    return merged;
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then build the session. Resolves when the next `classify` will not have to
   * wait for either.
   *
   * **~74 MB for the default build**, so unlike Emo and Ear this is not something
   * to do on mount without asking. The `english` variant is ~15 MB and is; see
   * {@link GistLoadOptions.variant}.
   */
  static async load(options: GistLoadOptions = {}): Promise<Gist> {
    const gist = Gist.create(options);
    try {
      await gist.warm(options.onProgress);
      return gist;
    } catch (error) {
      gist.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `classify`, which is then as slow as a download.
   *
   * Cheap enough to do purely to ask {@link isDownloaded}, which is how an app
   * decides whether to offer the download or just do it.
   */
  static create(options: GistLoadOptions = {}): Gist {
    const native = Gist.requireNative();
    const variant = options.variant ?? Gist.defaultVariant;
    if (!isVariant(variant)) {
      throw invalid(
        `'${String(variant)}' is not a Gist variant; expected one of ${Gist.variants.join(', ')}`
      );
    }
    // Refused here rather than natively so the message can name what this
    // platform *does* have. The Android module refuses too -- this is the
    // readable half of the same decision, not the only one.
    if (!Gist.variants.includes(variant)) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            `The '${variant}' build of Gist is not available on this platform. ` +
              `ai.desertant:gist's constructor takes no variant, so Android loads ` +
              `'multilingual' only. Available here: ${Gist.variants.join(', ')}.`
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    try {
      return new Gist(
        native.createModel({ directory: options.directory, variant }),
        variant
      );
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeGist> {
    if (!NativeGist) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Gist.unsupportedReason ??
              'Gist is not available here. Gate the feature on `Gist.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeGist;
  }

  private released = false;

  private constructor(
    private readonly native: NativeGistModel,
    /** Which build this instance loads. Fixed at construction, because it selects
     *  the files that get downloaded. */
    readonly variant: GistVariant
  ) {}

  /** Whether the weights are on the device, so `classify` needs no network. Ask
   *  before offering a 74 MB download the user has already paid for. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download the weights and build the session, so the first `classify` pays
   * neither.
   *
   * Identical to {@link download} -- upstream exposes one call that does both, so
   * unlike Clear and Voz there is no download-only step to run separately. Both
   * names exist so every model in this repo reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Gist.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. See its note. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Tag a piece of text: title, or title plus description, or a whole post.
   *
   * This is the API to reach for.
   *
   * ```ts
   * const { topics, threshold } = await gist.classify(post.title);
   * topics[0];               // { slug: 'finance', name: 'Personal Finance', score: 0.83 }
   * topics[0].score >= threshold;   // false means "nearest topic", not "confident"
   * ```
   *
   * Blank or whitespace-only text comes back with no topics and **does not load
   * the model** -- so a text field wired straight to this costs nothing while it
   * is empty.
   */
  async classify(text: string, options: ClassifyOptions = {}): Promise<Tagging> {
    this.assertAlive();
    if (typeof text !== 'string') {
      throw invalid('classify needs a string of text');
    }
    const native = toNativeOptions(options);
    // Two calls rather than one, and not for caching: the async half returns
    // nothing and the record is read back synchronously, because a `@JS async`
    // function's return value can be encoded off the JavaScript thread and
    // segfault the runtime. ios/GistModel.swift carries the full account.
    return this.run(options.onProgress, async (jobId) => {
      await Gist.requireNative().classify(this.native, text, native, jobId);
      return toTagging(this.native.takeTagging(jobId));
    });
  }

  /**
   * The full 36-topic probability distribution for `text`.
   *
   * What {@link channelTopics} eats. Prefer {@link classify} for showing a result
   * to someone -- it carries the display names and applies the tuned threshold --
   * and reach for this when the whole distribution is the point, because a topic
   * that is third in every post is what characterizes a channel even though it
   * tops none of them.
   *
   * One model run, the same as a `classify`. Calling both on one text runs it
   * twice; that is upstream's shape on both platforms and this package does not
   * paper over it by deriving one from the other.
   */
  async scores(text: string, options: Pick<ClassifyOptions, 'onProgress'> = {}): Promise<Distribution> {
    this.assertAlive();
    if (typeof text !== 'string') {
      throw invalid('scores needs a string of text');
    }
    return this.run(options.onProgress, async (jobId) => {
      await Gist.requireNative().scores(this.native, text, jobId);
      const distribution = this.native.takeDistribution(jobId);
      const scores: Record<string, number> = {};
      for (const entry of distribution.scores) {
        scores[entry.slug] = entry.score;
      }
      return {
        scores,
        processingSec: distribution.processingSec,
        modelRevision: distribution.modelRevision ?? null,
        variant: asVariant(distribution.variant, this.variant),
      };
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
   * distinguishable on the single `progress` event -- and so two of them cannot
   * take each other's stored result.
   */
  private async run<T>(
    onProgress: ((event: ProgressEvent) => void) | undefined,
    call: (jobId: string) => Promise<T>
  ): Promise<T> {
    nextJobId += 1;
    const jobId = `gist-${nextJobId}`;
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
        Object.assign(new Error('This Gist was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

/** Validate the per-call options and flatten them for the wire. */
function toNativeOptions(options: ClassifyOptions): NativeClassifyOptions {
  const topK = options.topK ?? Gist.defaultTopK;
  if (!Number.isInteger(topK) || topK < 1) {
    throw invalid(`'${String(topK)}' is not a topic count; expected a whole number of at least 1`);
  }
  const threshold = options.threshold;
  if (threshold !== undefined) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw invalid(`'${String(threshold)}' is not a threshold; expected a probability in 0..1`);
    }
  }
  return { topK, threshold: threshold ?? INHERIT_THRESHOLD };
}

/** Shape a native tagging for the caller. `topic` is flattened here rather than
 *  sent twice over the bridge. */
function toTagging(native: NativeTagging): Tagging {
  const topics: Topic[] = native.topics.map((topic) => ({
    slug: topic.slug,
    name: topic.name,
    score: topic.score,
  }));
  return {
    topics,
    topic: topics[0] ?? null,
    threshold: native.threshold ?? null,
    processingSec: native.processingSec,
    modelRevision: native.modelRevision ?? null,
    variant: asVariant(native.variant, Gist.defaultVariant),
  };
}

function isVariant(value: unknown): value is GistVariant {
  return value === 'multilingual' || value === 'english';
}

/** A variant name the native side reported, or the instance's own if a future
 *  build ever names one this package does not know. */
function asVariant(value: unknown, fallback: GistVariant): GistVariant {
  return isVariant(value) ? value : fallback;
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
