import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { ProgressEvent } from './types';

/**
 * The native surface. iOS and Android both.
 *
 * Gist is the fourth model in this repo with two working halves, after Clear, Emo
 * and Ear: `Sources/Gist/Variant.swift` lists `.apple`, `.android`, `.linux`,
 * `.windows` and `.web`, and `ai.desertant:gist` is on Maven Central. So
 * `isSupported` off Apple is a statement about the *device* rather than about the
 * catalog -- the LiteRT export ships `arm64-v8a` and `x86_64`, and an ABI outside
 * those has no `.so` to load.
 *
 * `requireOptionalNativeModule` resolves to `null` rather than throwing where the
 * module was not built in (Expo Go, web, an app that installed the package
 * without prebuilding), so `Gist.isSupported` can answer honestly instead of the
 * import crashing.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Gist`.
 */

export interface NativeGistLoadOptions {
  directory?: string;
  /** `'multilingual'` or `'english'`. Validated against the module's own
   *  `variants` before it gets here, so a refusal on Android names the reason
   *  rather than failing inside the SDK. */
  variant: string;
}

export interface NativeClassifyOptions {
  /** Validated `>= 1` before it gets here. */
  topK: number;
  /**
   * The threshold override, or a negative number meaning "use the model's own".
   *
   * A sentinel rather than an optional because `@Record` fields and Kotlin
   * `@Field`s both want a value, and a probability is never negative -- so `-1`
   * cannot collide with a threshold a caller meant. `Gist.ts` validates that an
   * explicitly passed threshold is inside `0..1` before it becomes this.
   */
  threshold: number;
}

export interface NativeTopic {
  slug: string;
  name: string;
  score: number;
}

export interface NativeTagging {
  topics: NativeTopic[];
  /** The caller's override, echoed back, or null when there was none. */
  threshold: number | null;
  processingSec: number;
  modelRevision: string | null;
  variant: string;
}

export interface NativeScore {
  slug: string;
  score: number;
}

export interface NativeDistribution {
  scores: NativeScore[];
  processingSec: number;
  modelRevision: string | null;
  variant: string;
}

export interface NativePostTopics {
  /**
   * The distribution as an array rather than as a map.
   *
   * A `Record<string, number>` is the friendlier TypeScript shape and is what
   * `PostTopics` uses; this is the shape that crosses the bridge, because an
   * array of two-field records is the argument conversion both platforms
   * demonstrably do (Clips passes `[ClipsSentence]` the same way) and a
   * dictionary argument is not exercised anywhere else in this repo. `channel.ts`
   * converts.
   */
  topics: NativeScore[];
  /** `0` means "no timestamp", which is what upstream's `nil`/`null` does: with
   *  no timestamp a post is never decayed. */
  timestampMillis: number;
}

export interface NativeRollupOptions {
  topN: number;
  floor: number;
  minPosts: number;
  halfLifeDays: number;
  touch: number;
  nowMillis: number;
}

export interface NativeChannelTopic {
  slug: string;
  share: number;
  postCount: number;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeGistModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
  /**
   * Hand over the tagging that `classify` computed for `jobId`, and forget it.
   *
   * **Synchronous, and that is load-bearing rather than a convenience.** A `@JS
   * async` function's return value can be encoded off the JavaScript thread,
   * which segfaults the runtime -- it took Ear down through `Array<String>` and
   * Clear through `Record`. A synchronous `@JS` member runs on the JavaScript
   * thread by construction, so the record is encoded where it has to be. See
   * `ios/GistModel.swift`.
   *
   * Keyed by job id rather than a single slot, so two concurrent `classify` calls
   * on one model cannot take each other's answer.
   *
   * Throws `ERR_INFERENCE_FAILED` if there is nothing stored for `jobId`, which
   * can only happen if it is called without a completed `classify` for that id.
   */
  takeTagging(jobId: string): NativeTagging;
  /** The same arrangement for `scores`. See {@link takeTagging}. */
  takeDistribution(jobId: string): NativeDistribution;
}

interface DesertAntGistModule extends NativeModule {
  /** False where this build cannot run Gist. True on iOS; on Android, false on an
   *  ABI LiteRT does not ship. */
  readonly isSupported: boolean;
  /** Why `isSupported` is false, or `''` when it is true. Computed natively
   *  because only the Android half knows which ABIs the device reported. */
  readonly unsupportedReason: string;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The pinned model revision the SDK resolves. */
  readonly modelRevision: string;
  /** The Hugging Face repo the weights come from. */
  readonly modelRepo: string;
  /**
   * How many topics `classify` returns when the caller does not say.
   *
   * Mirrored rather than read: it is `topK: Int = 3` in a Swift signature and
   * `topK: Int = 3` in a Kotlin one, and a default argument is not a constant
   * either SDK exposes. Nothing branches on it natively -- it is forwarded so the
   * two platforms show the same number.
   */
  readonly defaultTopK: number;
  /**
   * Every variant this platform can actually load, in upstream's own order.
   *
   * A **property**, not an async call, for the encoding reason on
   * `takeTagging` -- an array of bare strings is exactly what crashed Ear. Two
   * entries on iOS (`GistVariant.allCases`); one on Android, where the Kotlin
   * constructor takes no variant.
   */
  readonly variants: string[];
  /** `GistVariant.default` upstream: `'multilingual'`. Read on iOS, constant on
   *  Android, where it is also the only option. */
  readonly defaultVariant: string;
  /**
   * `RollupOptions()`'s own defaults, as a map, so a UI can lay out a roll-up
   * form without this package restating six numbers upstream already owns.
   *
   * A dictionary rather than a record because `[String: Double]` is the shape
   * `Uhm.biasThresholds` already proves encodes from a synchronous property.
   */
  readonly defaultRollupOptions: Record<string, number>;

  createModel(options: NativeGistLoadOptions): NativeGistModel;

  /** Download the weights and build the session. Upstream fuses the two. */
  load(model: NativeGistModel, jobId: string): Promise<void>;

  /**
   * Tag `text` and store the result on the shared object under `jobId`, returning
   * nothing.
   *
   * The `Void` is the point: see {@link NativeGistModel.takeTagging}.
   */
  classify(
    model: NativeGistModel,
    text: string,
    options: NativeClassifyOptions,
    jobId: string
  ): Promise<void>;

  /** The same arrangement for the full 36-topic distribution. */
  scores(model: NativeGistModel, text: string, jobId: string): Promise<void>;

  /**
   * Roll many posts' distributions up into ranked channel-level topics.
   *
   * **Synchronous, and it needs no model.** Upstream's `channelTopics` is a free
   * function on both platforms -- pure, deterministic, no inference -- so this is
   * a module function rather than a method, and it answers on a device that has
   * never downloaded a weight. Binding it rather than porting it is what keeps
   * this repo from being a third implementation of an aggregation that Swift and
   * Kotlin already agree on field for field.
   */
  channelTopics(posts: NativePostTopics[], options: NativeRollupOptions): NativeChannelTopic[];
}

export default requireOptionalNativeModule<DesertAntGistModule>('DesertAntGist');
