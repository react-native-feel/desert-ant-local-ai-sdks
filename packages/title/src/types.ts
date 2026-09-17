import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * A title and a description for a passage of text.
 *
 * The first three fields are upstream's `Card` verbatim. Everything else is this
 * call's provenance, so a log line or a telemetry event identifies itself.
 */
export interface Card {
  /**
   * Three to eight words, no final punctuation, in the language of the passage.
   *
   * That shape is what the model's own prompt asks for, and it is a request
   * rather than a guarantee -- the published model page says in as many words
   * that Title "is in internal testing", that "the model sometimes opens a
   * description with a stock phrase its own instruction forbids", and to "read
   * the output before it reaches a user". {@link cardShape} is how you check one
   * without reading it.
   */
  title: string;
  /**
   * One or two sentences saying what this passage *is*, as opposed to what its
   * subject is. That distinction is deliberate upstream and is most of what makes
   * the output usable as a description rather than as a summary.
   */
  description: string;
  /**
   * Upstream's own emptiness test: neither field came back.
   *
   * The only failure signal there is, because parsing is tolerant by design --
   * a reply that drifts off the `TITLE:` / `DESC:` format degrades to a usable
   * title rather than throwing. Treat `isEmpty` as "no card", not as an error.
   */
  isEmpty: boolean;
  /** Wall clock around the generation, excluding the load. */
  processingSec: number;
  /** The revision the model folder was resolved at: `v0.1.0`. A tag. */
  modelRevision: string | null;
  /** The runtime that produced it. `mlx` -- there is no other. */
  modelRuntime: string | null;
}

export interface TitleLoadOptions extends ModelLoadOptions {
  /**
   * The decode cap, in tokens. Defaults to 96, which is upstream's own default
   * argument on `Titles.init`.
   *
   * A cap rather than a target: upstream's note on it is that it "stops a
   * degenerate run decoding forever, which is a real failure mode for a small
   * instruct model given unusual input". Validated rather than clamped, because
   * upstream hands it straight to `GenerateParameters` where zero ends the decode
   * before the first token and yields an empty card that looks like a refusal.
   */
  maxTokens?: number;
  /**
   * Called while the model folder downloads.
   *
   * ~280 MB in seven files, so this is a progress bar that matters -- the
   * third-largest download in this family after Voz's ~490 MB and Clips' ~288 MB.
   * One phase, `loadingModel`, carrying a true byte fraction.
   */
  onProgress?: (event: ProgressEvent) => void;
}

export interface DescribeOptions {
  /** Called as the work proceeds. In practice nothing is emitted from
   *  {@link Title.describe}: the download is `prepare`'s phase, and generation
   *  reports no fraction because upstream's decode stream has no denominator. */
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * What {@link cardShape} measured about one card.
 *
 * Every field is arithmetic over the two strings. Nothing here is a model output
 * and nothing here is a score.
 */
export interface CardShape {
  /** Words in the title, split on whitespace. */
  titleWordCount: number;
  /** Whether that count is in the 3-8 the model page publishes. */
  titleWordsInRange: boolean;
  /** Whether the title ends in `.`, `!`, `?`, `…` or `;` -- which the published
   *  shape says it should not. */
  titleEndsWithPunctuation: boolean;
  /** Sentences in the description, counted on terminal punctuation. */
  descriptionSentenceCount: number;
  /** Whether that count is the 1-2 the model page publishes. */
  descriptionSentencesInRange: boolean;
  /** Whether either field contains an emoji, which the prompt forbids. */
  hasEmoji: boolean;
  /** Whether either field contains a `#hashtag`, which the prompt forbids. */
  hasHashtag: boolean;
  /**
   * True when every check above passed.
   *
   * Not a quality judgement. A card can satisfy every one of these and be about
   * the wrong thing, and a good card can fail one -- a nine-word title is
   * off-shape, not wrong. Read it as "did the model keep its own format", which
   * is a question worth being able to answer automatically.
   */
  matchesPublishedShape: boolean;
}

export type { ModelPhase, ProgressEvent };
