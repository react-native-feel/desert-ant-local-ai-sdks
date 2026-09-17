package ai.desertant.rn.gist

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The Apple half declares these with the Expo Modules 2.0 `@Record` macro, which
// infers fields from stored properties. There is no Kotlin equivalent yet, so
// these are the classic `@Field` records -- same wire shape, more ceremony.
// Keep the two in sync; `src/native.ts` is the contract both answer to.
//
// Only the *argument* types are here. Results go back as plain maps, because
// records are an argument type on Android and the return path wants maps.

class GistLoadOptions : Record {
  /** The model's home directory; null uses the app cache. */
  @Field val directory: String? = null

  /**
   * `"multilingual"` or `"english"`.
   *
   * Only the first is loadable here. `ai.desertant:gist`'s whole constructor is
   * `Gist(context, directory)` and its own KDoc says the English build is
   * selectable from the Swift SDK only, so this is validated and refused rather
   * than quietly ignored -- a caller who asked for 15 MB and silently got 74 would
   * have no way to tell.
   */
  @Field val variant: String = MULTILINGUAL

  fun resolvedVariant(): String {
    if (variant == MULTILINGUAL) return variant
    if (variant == ENGLISH) {
      throw UnsupportedPlatformException(ENGLISH_UNAVAILABLE)
    }
    throw InvalidArgumentException(
      "'$variant' is not a Gist variant. Expected 'multilingual' or 'english'."
    )
  }

  companion object {
    const val MULTILINGUAL = "multilingual"
    const val ENGLISH = "english"

    const val ENGLISH_UNAVAILABLE =
      "The 'english' build of Gist is iOS-only: ai.desertant:gist's constructor takes no " +
        "variant, so Android loads 'multilingual' (~74 MB) only. Gate a variant picker on " +
        "Gist.variants, which reports one entry here and two on iOS."
  }
}

class GistClassifyOptions : Record {
  /** `topK: Int = 3` in both SDKs' `classify` signatures. */
  @Field val topK: Int = 3

  /** The caller's threshold override, or a negative number meaning "use the
   *  model's own tuned value". See the note in ios/GistRecords.swift. */
  @Field val threshold: Double = -1.0

  fun resolvedTopK(): Int {
    if (topK < 1) {
      throw InvalidArgumentException(
        "'$topK' is not a topic count. Expected a whole number of at least 1."
      )
    }
    return topK
  }

  fun resolvedThreshold(): Double? {
    if (threshold < 0) return null
    if (threshold > 1) {
      throw InvalidArgumentException("'$threshold' is not a threshold. Expected a probability in 0..1.")
    }
    return threshold
  }
}

/** One slug and its probability, on the way in. */
class GistScore : Record {
  @Field val slug: String = ""
  @Field val score: Double = 0.0
}

/** One post's distribution, for `channelTopics`. */
class GistPostTopics : Record {
  @Field val topics: List<GistScore> = emptyList()

  /** Epoch milliseconds, or `0` for "no timestamp" -- upstream's null, which
   *  means the post is never decayed. */
  @Field val timestampMillis: Double = 0.0
}

/** `RollupOptions` on the wire. Defaults mirror upstream's data class so a caller
 *  who passes nothing gets exactly what Kotlin would give them. */
class GistRollupOptions : Record {
  @Field val topN: Int = 5
  @Field val floor: Double = 0.05
  @Field val minPosts: Int = 3
  @Field val halfLifeDays: Double = 0.0
  @Field val touch: Double = 0.15
  @Field val nowMillis: Double = 0.0
}
