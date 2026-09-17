import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * Which published build of the model to run.
 *
 * Not a label -- it selects the files that are downloaded and loaded, and the two
 * builds live in separate folders of the same Hub repo (multilingual at the root,
 * English under `en/`), so choosing one never downloads the other.
 *
 * - `multilingual` -- 36 topics across 101 languages, **~74 MB**. The default.
 * - `english` -- the same 36 topics and the same classifier head at **~15 MB**.
 *   English and other Latin-script text only; upstream is explicit that other
 *   scripts are not covered and degrade to noise rather than to a low score.
 *
 * **iOS only.** `Gist(variant:)` is a Swift initializer; `ai.desertant:gist`'s
 * whole constructor is `Gist(context, directory)`, and its own documentation says
 * the English build is selectable from the Swift SDK alone. Asking for `english`
 * on Android raises `ERR_UNSUPPORTED_PLATFORM` rather than silently loading 74 MB
 * -- see {@link Gist.variants}, which is read off the binary and is one entry
 * shorter there.
 */
export type GistVariant = 'multilingual' | 'english';

/** One predicted topic and how likely the model thinks it is. */
export interface Topic {
  /** The taxonomy slug, e.g. `'technology'`. Stable; this is what to store. */
  slug: string;
  /**
   * The human-readable name, e.g. `'Technology & Software'`.
   *
   * Read from the model's own `taxonomy.json` rather than from a table in this
   * package, so it cannot go stale against a new model revision -- and so a
   * display string never has to be invented from a slug.
   */
  name: string;
  /** The model's probability for this topic, `0` to `1`. */
  score: number;
}

/**
 * What the tagger made of a piece of text.
 *
 * Multi-label, not single-label: the scores are independent probabilities rather
 * than a distribution that sums to one, so two or three topics clearing the
 * threshold is the ordinary case rather than a tie.
 */
export interface Tagging {
  /**
   * The ranked topics above the tuned threshold, most likely first, capped at
   * `topK`.
   *
   * **The top topic is always here even when nothing clears the threshold.** That
   * is upstream's rule on both platforms, not this package's: a text always has a
   * nearest topic, and the score is what says how near.
   *
   * So the length is the signal a threshold would otherwise give you. Topics are
   * sorted descending and only the first is exempt, so **two or more means every
   * one of them cleared the threshold**; exactly one means it may be the nearest
   * topic rather than a confident one. Pass an explicit
   * {@link ClassifyOptions.threshold} when you need the bar to be yours.
   */
  topics: Topic[];
  /** `topics[0]`, or null for text that was blank. Flattened because it is the
   *  field most callers want. */
  topic: Topic | null;
  /**
   * The threshold passed to {@link ClassifyOptions.threshold}, echoed back so a
   * result is self-describing -- and **null when none was passed**.
   *
   * Null rather than the model's own tuned value because neither SDK exposes
   * that value: `Model.threshold` is `internal` in Swift and `Gist.tagged` is
   * `private` in Kotlin. Duplicating the number out of the model's
   * `gist_config.json` would be right until the next revision retunes it and
   * then quietly wrong, which is worse than an honest null.
   *
   * What *is* derivable is the question the threshold is usually being asked:
   * see {@link topics}. More than one topic means every one of them cleared it.
   */
  threshold: number | null;
  /**
   * Wall-clock time the tagging took, in seconds.
   *
   * Measured around the call natively, so it excludes the bridge hop but includes
   * everything the model did. A first call on a cold model also pays the download
   * and the session build; a second does not.
   */
  processingSec: number;
  /** The published model revision this came from, so a benchmark or a telemetry
   *  event is self-identifying. */
  modelRevision: string | null;
  /** Which build answered. Useful next to a result, because the ~15 MB English
   *  build and the ~74 MB multilingual one are different models. */
  variant: GistVariant;
}

/**
 * The full 36-topic probability distribution for one text.
 *
 * This is the input to {@link channelTopics}: a roll-up wants every topic's mass,
 * not just the ones that cleared a threshold, because a topic that is third in
 * every post is what characterizes a channel even though it tops none of them.
 */
export interface Distribution {
  /**
   * Slug to probability, all 36 of them.
   *
   * The names are not here, because upstream's `scores` does not carry them --
   * `Gist.scores(of:)` in Swift and `Gist.scores` in Kotlin both return a bare
   * map. Call {@link Gist.classify} when a display string is wanted.
   */
  scores: Record<string, number>;
  /** Wall-clock time this took, in seconds. Measured natively. */
  processingSec: number;
  /** The published model revision this came from. */
  modelRevision: string | null;
  /** Which build answered. */
  variant: GistVariant;
}

/** How a `Gist` finds its weights, and which build to load. */
export interface GistLoadOptions extends ModelLoadOptions {
  /**
   * Which build to run. Defaults to {@link Gist.defaultVariant}
   * (`'multilingual'`).
   *
   * **iOS only.** Passing `'english'` on Android raises
   * `ERR_UNSUPPORTED_PLATFORM`; see {@link GistVariant}.
   */
  variant?: GistVariant;
  /**
   * Called while the model downloads and loads.
   *
   * Worth wiring, unlike Emo's or Ear's: the default build is **~74 MB**, the
   * third-largest model in this family after Voz and Clips. The English build is
   * ~15 MB and closer to a model you can load on mount.
   */
  onProgress?: (event: ProgressEvent) => void;
}

/** Tuning for one `classify` call. Every field is per-call: a model instance
 *  holds no settings, so two callers can ask one loaded model for different
 *  shapes of answer. */
export interface ClassifyOptions {
  /**
   * How many topics to return at most. Defaults to {@link Gist.defaultTopK} (3).
   *
   * It caps the list; it does not change the ranking or what clears the
   * threshold, and it costs nothing -- the head scores all 36 topics either way.
   * Upstream's own product claim is measured at this default: "the right topic is
   * in the top three 91% of the time".
   */
  topK?: number;
  /**
   * Override the model's tuned threshold for this call.
   *
   * Leave it alone unless you have a reason. The default is calibrated and
   * travels with the weights; a constant here would be right until the next model
   * revision. Lower it to see more of the tail, raise it to accept only topics
   * the model is sure of -- and note that the top topic comes back either way.
   */
  threshold?: number;
  /** Called while the model downloads and loads. Tagging itself reports nothing
   *  -- see {@link GistProgressNote}. */
  onProgress?: (event: ProgressEvent) => void;
}

/** One post's topic scores, for {@link channelTopics}. */
export interface PostTopics {
  /** Slug to probability, from {@link Distribution.scores}. */
  topics: Record<string, number>;
  /**
   * Epoch milliseconds. Enables recency weighting, and only when
   * {@link RollupOptions.halfLifeDays} and {@link RollupOptions.nowMillis} are
   * both set -- a half-life with no clock to measure against decays nothing.
   */
  timestampMillis?: number;
}

/** One channel-level topic in a roll-up. */
export interface ChannelTopic {
  slug: string;
  /** This topic's share of the channel's total topical weight, `0` to `1`. */
  share: number;
  /** How many posts *meaningfully* touch it -- scored at or above
   *  {@link RollupOptions.touch}, rather than merely non-zero. */
  postCount: number;
}

/**
 * Options for {@link channelTopics}. Every default is read off the native binary
 * through {@link Gist.defaultRollupOptions} rather than written here.
 */
export interface RollupOptions {
  /** How many channel topics to return. Default `5`. */
  topN?: number;
  /** Drop a topic below this share of the total weight. Default `0.05`. */
  floor?: number;
  /** Return nothing at all for a channel with fewer posts than this. Default `3`
   *  -- two posts do not describe a channel. */
  minPosts?: number;
  /** Recency half-life in days. `0` (the default) disables decay entirely. */
  halfLifeDays?: number;
  /** The score at which a post counts as *touching* a topic, for
   *  {@link ChannelTopic.postCount}. Default `0.15`. Does not affect `share`. */
  touch?: number;
  /** The clock decay is measured against, in epoch milliseconds. Default `0`,
   *  which leaves decay off until you supply one. */
  nowMillis?: number;
}

/**
 * A marker for the one thing this model does not report.
 *
 * `classify` and `scores` emit no progress of their own: upstream's inference
 * calls take no handler on either platform, unlike its `download`. So the only
 * phase a Gist ever emits is `loadingModel`, and it emits it from `warm`,
 * `download`, and the load the first `classify` does implicitly. No phase was
 * added to `ModelPhase` in `packages/core` for this model, because upstream
 * reports none -- and one forward pass through an MLP head is not something a
 * progress bar can usefully show anyway.
 */
export type GistProgressNote = never;

export type { ModelPhase, ProgressEvent };
