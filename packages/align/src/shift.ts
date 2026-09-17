import type { AlignedWord, TimestampShift } from './types';

/**
 * How far Align moved Apple's word boundaries, over a list of words.
 *
 * Pure arithmetic over a result that is already in hand: no model, no bridge hop,
 * no download. The same kind of call as `channelTopics` in Gist and `restore` in
 * Redact -- something the SDK can answer on a device that has never resolved a
 * weight, kept in TypeScript because that is where it is cheapest and where its
 * provenance is visible.
 *
 * It exists because Align is the one model in this family whose output is not
 * self-evidently better than the input. A transcript with refined timestamps
 * looks exactly like a transcript with Apple's timestamps; the difference is in
 * the tens of milliseconds, and the only honest way to see it on your own audio
 * is to measure it. Upstream publishes 106.4 ms of Apple error against 20.2 ms of
 * its own on LibriSpeech test-clean -- those are upstream's numbers on upstream's
 * corpus, not a promise about a phone recording in a kitchen. This measures what
 * actually happened.
 *
 * ```ts
 * const { words } = await align.transcribe({ uri, locale: 'en-US' });
 * const shift = timestampShift(words);
 * console.log(`${shift.refinedCount}/${shift.wordCount} moved, mean ${shift.meanAbsSec * 1000} ms`);
 * ```
 *
 * Note what this is **not**: it is not accuracy. It says how far the two models
 * disagree, not which one is right -- that needs reference boundaries, which a
 * device does not have. A large mean shift on audio Align handles well and a
 * large mean shift on audio it handles badly look the same from here. Read it as
 * "is this model doing anything on my audio", which is a question worth being
 * able to answer, rather than as a score.
 *
 * Words with `refined: false` are counted in `wordCount` and contribute zero to
 * every mean, because their two spans are identical by construction. That keeps
 * `meanAbsSec` the average movement *per word of the transcript* rather than per
 * word the model chose to touch; `refinedCount` is there to compute the other one
 * if that is what you want.
 */
export function timestampShift(words: readonly AlignedWord[]): TimestampShift {
  const empty: TimestampShift = {
    wordCount: 0,
    refinedCount: 0,
    meanAbsSec: 0,
    maxAbsSec: 0,
    meanStartSec: 0,
    meanEndSec: 0,
  };
  if (!words || words.length === 0) {
    return empty;
  }

  let refinedCount = 0;
  let absTotal = 0;
  let maxAbs = 0;
  let startTotal = 0;
  let endTotal = 0;

  for (const word of words) {
    if (word.refined) {
      refinedCount += 1;
    }
    const startDelta = delta(word.start, word.originalStart);
    const endDelta = delta(word.end, word.originalEnd);
    startTotal += startDelta;
    endTotal += endDelta;
    absTotal += Math.abs(startDelta) + Math.abs(endDelta);
    maxAbs = Math.max(maxAbs, Math.abs(startDelta), Math.abs(endDelta));
  }

  return {
    wordCount: words.length,
    refinedCount,
    // Two boundaries per word, so the denominator is twice the word count: this
    // is the mean movement of a *boundary*, which is the unit upstream's own
    // 106.4 ms and 20.2 ms are quoted in.
    meanAbsSec: absTotal / (2 * words.length),
    maxAbsSec: maxAbs,
    meanStartSec: startTotal / words.length,
    meanEndSec: endTotal / words.length,
  };
}

/**
 * One boundary's movement, or zero when either end of the comparison is not a
 * number.
 *
 * A single `NaN` would otherwise poison every mean in the result, turning "one
 * word came back malformed" into "this whole measurement is unreadable". Nothing
 * native produces one -- the Swift side builds every field from a `Double` off a
 * `CMTime` -- but `timestampShift` takes a plain array and a caller may well hand
 * it a hand-built or partially-mapped one.
 */
function delta(refinedValue: number, originalValue: number): number {
  if (!Number.isFinite(refinedValue) || !Number.isFinite(originalValue)) {
    return 0;
  }
  return refinedValue - originalValue;
}
