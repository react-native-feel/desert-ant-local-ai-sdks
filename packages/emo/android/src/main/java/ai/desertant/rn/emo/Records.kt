package ai.desertant.rn.emo

import ai.desertant.emo.EmojiSkinTone
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The Apple half declares these with the Expo Modules 2.0 `@Record` macro, which
// infers fields from stored properties. There is no Kotlin equivalent yet, so
// these are the classic `@Field` records -- same wire shape, more ceremony.
// Keep the two in sync; `src/types.ts` is the contract both answer to.

class EmoLoadOptions : Record {
  /** The model's home directory; null uses the app cache. */
  @Field val directory: String? = null
}

class EmoSuggestOptions : Record {
  /** `limit: Int = 3` in `Emo.suggestions`. */
  @Field val limit: Int = 3

  /** `default`, `light`, `mediumLight`, `medium`, `mediumDark` or `dark`. */
  @Field val skinTone: String = "default"

  fun resolvedLimit(): Int {
    if (limit < 1) {
      throw InvalidArgumentException(
        "'$limit' is not a limit. Expected a whole number of at least 1."
      )
    }
    return limit
  }

  /**
   * The wire spelling is the Swift enum's -- lowerCamelCase -- and the Kotlin
   * enum's is SCREAMING_SNAKE, so this maps rather than calling `valueOf`.
   * Mapping explicitly is also what makes an unknown tone an
   * `ERR_INVALID_ARGUMENT` with a readable message instead of an
   * `IllegalArgumentException` from the enum.
   */
  fun resolvedSkinTone(): EmojiSkinTone = when (skinTone) {
    "default" -> EmojiSkinTone.DEFAULT
    "light" -> EmojiSkinTone.LIGHT
    "mediumLight" -> EmojiSkinTone.MEDIUM_LIGHT
    "medium" -> EmojiSkinTone.MEDIUM
    "mediumDark" -> EmojiSkinTone.MEDIUM_DARK
    "dark" -> EmojiSkinTone.DARK
    else -> throw InvalidArgumentException(
      "'$skinTone' is not a skin tone. Expected 'default', 'light', 'mediumLight', " +
        "'medium', 'mediumDark' or 'dark'."
    )
  }
}
