import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * Preferred skin tone for the emoji that have variants.
 *
 * Applied in the shared native core after the ranking, not by the model: the
 * classifier's vocabulary is toneless, and the modifier is appended to whichever
 * of its ~800 labels accept one. So a tone never changes *which* emoji come back
 * or in what order -- only how the ones capable of a tone are rendered.
 *
 * `default` is the yellow presentation with no modifier.
 */
export type EmojiSkinTone = 'default' | 'light' | 'mediumLight' | 'medium' | 'mediumDark' | 'dark';

/** One suggested emoji. */
export interface EmoSuggestion {
  /** The emoji itself, with {@link SuggestOptions.skinTone} already applied where
   *  the emoji accepts one. */
  emoji: string;
  /**
   * The model's normalized confidence, `0` to `1`.
   *
   * A softmax over the whole ~800-emoji vocabulary, so the values across one
   * call sum to 1 across the *vocabulary*, not across the handful returned --
   * expect a top suggestion in the 0.2-0.7 range rather than near 1, and expect
   * near-ties at the top, which upstream calls out as normal for emoji. Use it
   * to order and to gate, not as a probability of being "right".
   */
  confidence: number;
}

/** Tuning for one `suggest` call. Every field is per-call: a model instance holds
 *  no settings, so two callers can ask the same loaded model for different
 *  things. */
export interface SuggestOptions {
  /**
   * How many suggestions to return, most likely first. Defaults to 3.
   *
   * The model is tuned for top-1 relevance, so a keyboard-style row of three is
   * about where its accuracy still earns the space. Asking for more is cheap --
   * the whole vocabulary is scored either way, and `limit` only truncates the
   * sorted list -- but the tail is noise.
   */
  limit?: number;
  /** Which skin tone to render tone-capable emoji with. Defaults to `default`. */
  skinTone?: EmojiSkinTone;
}

export interface EmoLoadOptions extends ModelLoadOptions {
  /**
   * Called while the model downloads and loads.
   *
   * The weights are **~5 MB on Apple and ~11 MB on Android** -- the smallest
   * model in this repo by an order of magnitude -- so this is a progress bar
   * that is usually over before it is worth drawing. Load it on mount.
   */
  onProgress?: (event: ProgressEvent) => void;
}

export type { ModelPhase, ProgressEvent };
