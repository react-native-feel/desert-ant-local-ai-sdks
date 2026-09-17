import { toDesertAntError } from '@desert-ant-labs/react-native-core';

import NativeGist, { type NativePostTopics, type NativeRollupOptions } from './native';
import { Gist } from './Gist';
import { type ChannelTopic, type PostTopics, type RollupOptions } from './types';

const MODEL = 'gist';

/**
 * Aggregate many posts' topic distributions into a ranked list of channel-level
 * topics.
 *
 * **Pure, deterministic, and no model.** It runs on a device that has never
 * downloaded a weight -- there is nothing to load and nothing to await -- which
 * is why it is a free function here rather than a method on a `Gist`, exactly as
 * it is a free function in Swift and a top-level `fun` in Kotlin.
 *
 * ```ts
 * const posts = await Promise.all(recent.map((p) => gist.scores(p.title)));
 * const about = channelTopics(posts.map((p) => ({ topics: p.scores })));
 * // [{ slug: 'technology', share: 0.31, postCount: 9 }, ...]
 * ```
 *
 * Every post's *whole* distribution contributes, weighted by probability -- not
 * just the topics that cleared a threshold. That is the point of the roll-up: a
 * topic that comes third in every post is what a channel is about even though it
 * tops none of them.
 *
 * Two guards keep one-off posts from characterizing a channel: a share
 * {@link RollupOptions.floor} below which a topic is dropped, and
 * {@link RollupOptions.minPosts}, below which the whole answer is empty rather
 * than confidently wrong about three posts. Optional recency decay is off until
 * both {@link RollupOptions.halfLifeDays} and {@link RollupOptions.nowMillis} are
 * supplied, because a half-life with no clock to measure against decays nothing.
 *
 * Bound rather than ported. Swift and Kotlin already agree on this arithmetic
 * field for field and default for default; a TypeScript third implementation
 * would be a third chance to differ, on a calculation whose output nothing would
 * flag as wrong.
 *
 * Synchronous -- it is arithmetic over a few hundred numbers, and a `@JS async`
 * function's return value can be encoded off the JavaScript thread. A
 * synchronous one cannot.
 *
 * Throws `ERR_UNSUPPORTED_PLATFORM` where the native module is absent, and
 * `ERR_INVALID_ARGUMENT` for a malformed post.
 */
export function channelTopics(
  posts: PostTopics[],
  options: RollupOptions = {}
): ChannelTopic[] {
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
  if (!Array.isArray(posts)) {
    throw invalid('channelTopics needs an array of posts');
  }
  try {
    return NativeGist.channelTopics(posts.map(toNativePost), toNativeOptions(options));
  } catch (error) {
    throw toDesertAntError(error, MODEL);
  }
}

/**
 * A `Record<string, number>` is the friendly shape, and an array of two-field
 * records is the one that crosses the bridge. The conversion is here rather than
 * asking callers for the wire shape.
 */
function toNativePost(post: PostTopics, index: number): NativePostTopics {
  if (!post || typeof post !== 'object' || !post.topics || typeof post.topics !== 'object') {
    throw invalid(`post ${index} has no \`topics\`; pass the \`scores\` from gist.scores(text)`);
  }
  const topics = Object.entries(post.topics).map(([slug, score]) => {
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw invalid(`post ${index} scores '${slug}' as '${String(score)}', which is not a probability`);
    }
    return { slug, score };
  });
  const timestamp = post.timestampMillis;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp))) {
    throw invalid(`post ${index} has a timestampMillis that is not a number`);
  }
  // `0` is upstream's "no timestamp": a post with none is never decayed, and the
  // epoch is not a time anyone is rolling up posts from.
  return { topics, timestampMillis: timestamp ?? 0 };
}

/** Fill every field from the binary's own defaults, so a caller passing one
 *  option does not silently take this package's idea of the other five. */
function toNativeOptions(options: RollupOptions): NativeRollupOptions {
  const defaults = Gist.defaultRollupOptions;
  const resolved = {
    topN: options.topN ?? defaults.topN,
    floor: options.floor ?? defaults.floor,
    minPosts: options.minPosts ?? defaults.minPosts,
    halfLifeDays: options.halfLifeDays ?? defaults.halfLifeDays,
    touch: options.touch ?? defaults.touch,
    nowMillis: options.nowMillis ?? defaults.nowMillis,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalid(`'${String(value)}' is not a number for \`${key}\``);
    }
  }
  if (!Number.isInteger(resolved.topN) || resolved.topN < 1) {
    throw invalid(`'${resolved.topN}' is not a topic count; expected a whole number of at least 1`);
  }
  if (!Number.isInteger(resolved.minPosts) || resolved.minPosts < 0) {
    throw invalid(`'${resolved.minPosts}' is not a post count; expected a whole number of at least 0`);
  }
  return resolved;
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
