import { toDesertAntError } from '@desert-ant-labs/react-native-core';

import { type Redaction, type RedactionItem } from './types';

const MODEL = 'redact';

/**
 * Put the originals back into text that came out of whatever processed the
 * redacted version -- an LLM reply, a translation, a summary.
 *
 * ```ts
 * const r = await redact.redaction(userText);
 * const reply = await myLLM.rewrite(r.redactedText);   // sees only [EMAIL_1], [GIVEN_NAME_1], ...
 * const final = restore(r, reply);                     // originals filled back in
 * ```
 *
 * A free function rather than a method, because the redaction crosses the bridge
 * as a plain record and a record has no methods. Upstream spells it
 * `result.restore(reply)` on both platforms; this is the same call with the
 * receiver moved to the first argument.
 *
 * **Ported rather than bound**, which is the opposite of the choice `Gist`'s
 * `channelTopics` makes, and for the opposite reason. `channelTopics` is
 * probability arithmetic that a third implementation could get subtly and
 * silently wrong. This is a literal substitution of a unique, bracket-delimited,
 * numbered placeholder -- `Redaction.restore` in Swift is a loop over
 * `String.replacing(_:with:)` and in Kotlin a loop over `String.replace`, both
 * of which replace every literal occurrence -- so there is exactly one behaviour
 * to reproduce, and reproducing it here means the call needs no model, no
 * handle, and no trip back across the bridge carrying the personal data that was
 * just brought over it.
 *
 * Order-independent: placeholders are numbered and bracketed, so none is a
 * prefix of another and no substitution can create or destroy a later one.
 *
 * Every occurrence is replaced, not just the first. That is upstream's behaviour
 * and it is the useful one: a model that mentions `[GIVEN_NAME_1]` three times
 * should come back naming the person three times.
 *
 * Pure and synchronous. It runs on a device that has never downloaded a weight,
 * and it never sees the network -- the originals it substitutes never left.
 *
 * @param redaction the result of a `redaction()` call, or anything carrying its
 *   `items`.
 * @param processed the text to fill the originals back into.
 */
export function restore(redaction: Pick<Redaction, 'items'>, processed: string): string {
  if (!redaction || typeof redaction !== 'object' || !Array.isArray(redaction.items)) {
    throw invalid('restore needs a redaction; pass the result of redaction(text)');
  }
  if (typeof processed !== 'string') {
    throw invalid('restore needs a string to put the originals back into');
  }
  let out = processed;
  for (const item of redaction.items as RedactionItem[]) {
    if (!item || typeof item.placeholder !== 'string' || typeof item.original !== 'string') {
      throw invalid('restore needs every item to carry a placeholder and an original');
    }
    // `split`/`join` rather than `replaceAll`, and rather than a RegExp: a
    // placeholder is a literal, and building a regex out of one would mean
    // escaping `[` and `]` on every call to get back to the literal semantics
    // both native SDKs already have.
    out = out.split(item.placeholder).join(item.original);
  }
  return out;
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
