import type { Card, CardShape } from './types';

/**
 * Does this card have the shape the model says its cards have?
 *
 * Pure arithmetic over a result that is already in hand: no model, no bridge hop,
 * no download. The same kind of call as `timestampShift` in Align, `channelTopics`
 * in Gist and `restore` in Redact -- something the SDK can answer on a device that
 * has never resolved a weight.
 *
 * It exists for the reason Align's `timestampShift` exists, which is that this
 * model's published claim is *checkable* and taking it on trust would be a choice.
 * The model page states the output shape in one sentence -- "A title of three to
 * eight words with no final punctuation, and a description of one or two
 * sentences, from one call" -- and states the caveat in the next: Title "is in
 * internal testing and its card carries no quality figures ... the model sometimes
 * opens a description with a stock phrase its own instruction forbids. Read the
 * output before it reaches a user." An app that is going to put a generated title
 * in front of somebody can run this first and fall back to its own naming when
 * the answer is off-shape.
 *
 * **The thresholds are the published ones, not upstream's source.** They could
 * not be read off the binary: they live inside `Titles.prompt`, a `static let`
 * with no access modifier and therefore internal to the `Title` module, and
 * upstream is emphatic that a second copy of that prompt is a bug waiting to
 * happen -- the previous version of the property "was a different string from the
 * one training used", so "the shipped model was served an unseen prompt on every
 * call". So this function does not restate the prompt; it restates the *product
 * page*, which is a published contract with a URL, and says so here rather than
 * implying a source it does not have.
 *
 * ```ts
 * const card = await title.describe(note.body);
 * const shape = cardShape(card);
 * setTitle(shape.matchesPublishedShape ? card.title : note.firstLine);
 * ```
 *
 * Note what this is **not**: it is not accuracy, and it is not a score. A card can
 * pass every check and describe the wrong passage. Read it as "did the model keep
 * its own format on my text", which is a different and answerable question.
 *
 * @see https://desertant.com/models/title/
 */
export function cardShape(card: Pick<Card, 'title' | 'description'> | null | undefined): CardShape {
  const title = typeof card?.title === 'string' ? card.title.trim() : '';
  const description = typeof card?.description === 'string' ? card.description.trim() : '';

  const titleWordCount = title.length === 0 ? 0 : title.split(/\s+/u).length;
  const titleWordsInRange = titleWordCount >= 3 && titleWordCount <= 8;
  const titleEndsWithPunctuation = /[.!?;…]$/u.test(title);

  const descriptionSentenceCount = countSentences(description);
  const descriptionSentencesInRange =
    descriptionSentenceCount >= 1 && descriptionSentenceCount <= 2;

  const both = `${title}\n${description}`;
  const hasEmoji = EMOJI.test(both);
  const hasHashtag = /(^|\s)#[^\s#]/u.test(both);

  return {
    titleWordCount,
    titleWordsInRange,
    titleEndsWithPunctuation,
    descriptionSentenceCount,
    descriptionSentencesInRange,
    hasEmoji,
    hasHashtag,
    matchesPublishedShape:
      titleWordsInRange &&
      !titleEndsWithPunctuation &&
      descriptionSentencesInRange &&
      !hasEmoji &&
      !hasHashtag,
  };
}

/**
 * Sentences, counted on terminal punctuation.
 *
 * Deliberately crude, and the crudeness is bounded by what it is used for: a
 * one-or-two test over one or two sentences of model output. A real sentence
 * splitter would have to know about `Dr.`, decimals and ellipses, and getting
 * those wrong here costs a boolean rather than a result. Runs of terminal
 * punctuation collapse, so `Wait...` is one sentence and not four, and a
 * description with no terminal punctuation at all counts as one rather than zero
 * -- the model routinely ends without a period and that is not a second sentence.
 *
 * Counts CJK terminal punctuation too, because the model writes "in the same
 * language as the passage" and a Japanese description ends in `。` rather than
 * `.`. Missing that would have made every non-Latin card read as one sentence
 * regardless of how many it had.
 */
function countSentences(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const matches = text.match(/[.!?…。！？]+/gu);
  if (!matches) {
    return 1;
  }
  // A trailing terminator closes the last sentence; anything after it opens
  // another one that was simply never finished.
  const trailing = /[.!?…。！？]+\s*$/u.test(text);
  return trailing ? matches.length : matches.length + 1;
}

/**
 * Emoji, as the prompt means it: pictographs and the regional-indicator flags.
 *
 * `\p{Extended_Pictographic}` rather than `\p{Emoji}`, which is a trap -- the
 * ASCII digits and `#` and `*` all carry the `Emoji` property because they are
 * the bases of keycap sequences, so `\p{Emoji}` matches "3" and would report an
 * emoji in every card with a number in it.
 */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
