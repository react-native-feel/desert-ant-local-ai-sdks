package ai.desertant.rn.shapes

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The Apple half declares these with the Expo Modules 2.0 `@Record` macro, which
// infers fields from stored properties. There is no Kotlin equivalent yet, so
// these are the classic `@Field` records -- same wire shape, more ceremony.
// Keep the two in sync; `src/native.ts` is the contract both answer to.
//
// Only the *argument* types are here. Results go back as plain maps, because
// records are an argument type on Android and the return path wants maps.

class ShapesLoadOptions : Record {
  /** The model's home directory; null uses the app cache. */
  @Field val directory: String? = null
}

class ShapesRecognizeOptions : Record {
  /**
   * An extra minimum classifier confidence, on top of each class's calibrated
   * gate. `0.0` in both SDKs' signatures.
   */
  @Field val minimumConfidence: Double = 0.0

  /**
   * Validated rather than clamped.
   *
   * The Kotlin SDK does not clamp at all: `Options` is a plain data class and
   * `Shapes.recognize` writes the `f64` straight onto the FFI, where the Swift
   * `Options.init` on the other side runs
   * `isFinite ? min(1, max(0, value)) : 0`. So `95` -- meaning "95%" -- silently
   * becomes `1.0` and rejects every stroke, and `NaN` silently becomes `0` and
   * rejects none. The Apple half refuses for the same reason; so does the
   * TypeScript above both.
   */
  fun resolvedConfidence(): Double {
    if (!minimumConfidence.isFinite() || minimumConfidence < 0.0 || minimumConfidence > 1.0) {
      throw InvalidArgumentException(
        "'$minimumConfidence' is not a confidence. Expected a probability in 0..1."
      )
    }
    return minimumConfidence
  }
}
