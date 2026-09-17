package ai.desertant.rn.redact

import ai.desertant.redact.Labels
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The Apple half declares these with the Expo Modules 2.0 `@Record` macro, which
// infers fields from stored properties. There is no Kotlin equivalent yet, so
// these are the classic `@Field` records -- same wire shape, more ceremony.
// Keep the two in sync; `src/native.ts` is the contract both answer to.
//
// Only the *argument* types are here. Results go back as plain maps, because
// records are an argument type on Android and the return path wants maps.

class RedactLoadOptions : Record {
  /** The model's home directory; null uses the app cache. */
  @Field val directory: String? = null
}

class RedactRedactionOptions : Record {
  /** Minimum confidence for neural detections. `0.6` in both SDKs' signatures.
   *  The deterministic recognizers ignore it. */
  @Field val minimumConfidence: Double = 0.6

  /** The labels to redact, or an empty list meaning `Labels.DEFAULT`. See the
   *  note in ios/RedactRecords.swift. */
  @Field val labels: List<String> = emptyList()

  fun resolvedConfidence(): Double {
    if (!minimumConfidence.isFinite() || minimumConfidence < 0.0 || minimumConfidence > 1.0) {
      throw InvalidArgumentException(
        "'$minimumConfidence' is not a confidence. Expected a probability in 0..1."
      )
    }
    return minimumConfidence
  }

  /**
   * The label set to pass upstream, or null for its default.
   *
   * Refuses a name `Labels.ALL` does not contain, which the Kotlin SDK itself
   * would not: `Options.labels` is a plain `Set<String>` and an unknown name
   * simply matches nothing, so a typo silently widens the redaction and a set of
   * nothing but typos silently redacts nothing at all. The Apple half refuses
   * for the same reason; so does the TypeScript above both.
   */
  fun resolvedLabels(): Set<String>? {
    if (labels.isEmpty()) return null
    for (name in labels) {
      if (!Labels.ALL.contains(name)) {
        throw InvalidArgumentException(
          "'$name' is not a Redact label. Expected one of ${Labels.ALL.joinToString(", ")}."
        )
      }
    }
    return labels.toSet()
  }
}
