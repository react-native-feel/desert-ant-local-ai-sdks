/**
 * The names a script can come back as, and how much to trust an answer.
 *
 * None of these are this package's inventions: `Reliability` and `Verdict` are
 * Swift enums and Kotlin enum classes upstream, and the script names are UAX#24
 * script property values. They are spelled here as string unions because that is
 * what crosses the bridge, and because a caller switching on one wants the
 * exhaustiveness check.
 */

/**
 * How much to trust an answer.
 *
 * **This is the field to branch on**, and it is not a threshold on
 * {@link Detection.confidence}. It is keyed off *evidence* -- how many characters
 * were normalized away, and how far the top candidate leads the runner-up --
 * rather than off the softmax, which is badly overconfident on very short text.
 * `"hi i am"` reads as Welsh to any character model at high probability; the
 * margin and the length are what reveal it as a guess.
 *
 * - `confident` -- 18+ characters and a 0.30+ margin, or a script only one
 *   language uses (which needs no model and involves no guessing).
 * - `likely` -- 12+ characters and a 0.20+ margin.
 * - `tentative` -- everything else that produced an answer. Real, and a guess.
 * - `empty` -- normalization left nothing to look at, so there is no answer at
 *   all and {@link Detection.language} is null.
 */
export type Reliability = 'confident' | 'likely' | 'tentative' | 'empty';

/** Which stage of the router answered, before the head ever ran. */
export type RouteVerdict =
  /** One language uses this script, so the answer needed no model. */
  | 'decisive'
  /** Several languages share it; the head decoded among those only. */
  | 'narrowing'
  /** No script carried enough evidence; the head decoded among the Latin
   *  labels. */
  | 'ambiguous';

/**
 * What the script router decided, before the model was consulted.
 *
 * Worth surfacing rather than hiding, because it explains an answer better than
 * a probability does: a `decisive` route means the text was in a script only one
 * language uses and the model was never asked, which is why such answers come
 * back at probability 1.
 */
export interface Route {
  verdict: RouteVerdict;
  /**
   * The languages the router allowed through. One for `decisive`, a handful for
   * `narrowing`, and empty for `ambiguous` -- where the head instead decodes
   * over every Latin-script label.
   */
  candidates: string[];
  /**
   * The UAX#24 script name the router settled on -- `'Latin'`, `'Cyrillic'`,
   * `'Han'` -- or null when there were no scripted characters at all.
   *
   * `'Japanese'` is the one name that is not a real Unicode script. Japanese
   * mixes Han with kana, so any kana settles the route even when Han characters
   * outnumber them; without that special case, kanji-heavy Japanese misroutes to
   * Chinese.
   */
  script: string | null;
}

/** One candidate language and how likely the model thinks it is. */
export interface LanguageCandidate {
  /** ISO 639-1 where one exists, otherwise ISO 639-3. */
  language: string;
  /** `0` to `1`, renormalized over the candidates the router allowed. */
  probability: number;
}

/** What the detector read. */
export interface Detection {
  /**
   * The detected language as an ISO code, or null when normalization left
   * nothing to look at.
   *
   * Always `candidates[0].language`. Flattened here because that is the field
   * almost every caller wants.
   */
  language: string | null;
  /** {@link language}'s probability, `0` to `1`. `0` when there is no answer. */
  confidence: number;
  /**
   * How much to trust it. **Branch on this, not on {@link confidence}** -- see
   * {@link Reliability}.
   */
  reliability: Reliability;
  /**
   * True when the top two candidates are within {@link Tongue.tieMargin} of each
   * other.
   *
   * Present both rather than crowning one: `"la casa"` is equally Italian and
   * Spanish, and saying so is more useful than picking. This is a *different*
   * question from {@link reliability}, which also weighs how much text there was
   * -- a long sentence can be reliable and still too close to call between two
   * sister languages.
   */
  isTooCloseToCall: boolean;
  /** Every candidate the model ranked, most likely first. Includes the winner at
   *  index 0. At most `topK` of them. */
  candidates: LanguageCandidate[];
  /**
   * The text the model actually saw: NFC-composed, lowercased, with URLs,
   * emails, mentions and digits stripped, whitespace collapsed, and capped at
   * {@link Tongue.maxCharacters} scalars.
   *
   * Exposed because it is the answer to "why did it say that?" more often than
   * any other field -- a string that normalizes to nothing comes back `empty`,
   * and a string that normalizes to two characters is a guess whatever the
   * probability says.
   */
  normalized: string;
  /** What the script router decided before the head ran. See {@link Route}. */
  route: Route;
  /**
   * Wall-clock time the detection took, in seconds.
   *
   * Measured around the call natively, so it excludes the bridge hop. Upstream
   * measures tens of *microseconds*, so expect a number with four leading zeros;
   * this is the one model in this family where the bridge hop dominates the
   * model.
   */
  processingSec: number;
  /** The pinned model revision this came from, so a benchmark or a telemetry
   *  event is self-identifying. */
  modelRevision: string | null;
}

/** Tuning for one `detect` call. Every field is per-call: a model instance holds
 *  no settings. */
export interface DetectOptions {
  /**
   * How many candidates to rank. Defaults to {@link Tongue.defaultTopK} (3).
   *
   * It does not change the winner or cost anything measurable -- the head scores
   * every allowed label either way and this only decides how many survive the
   * sort. Raise it to show a caller the field rather than the answer.
   */
  topK?: number;
}

/**
 * A marker for the two things this model does not report.
 *
 * Tongue emits **no progress at all**, and that is upstream's shape rather than
 * an omission. There is nothing to download -- the 2 MB of int8 weights ship
 * inside the binary -- and neither `Tongue()` nor `detect` takes a progress
 * handler on either platform. So no `ProgressEvent` is ever raised, no phase of
 * `ModelPhase` was added for this model, and `load` takes no `onProgress`.
 *
 * It is also the only model in this family with no `directory` load option and
 * no `isDownloaded()`: both questions are about a download that does not happen.
 */
export type TongueProgressNote = never;
