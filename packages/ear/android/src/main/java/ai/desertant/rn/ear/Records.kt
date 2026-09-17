package ai.desertant.rn.ear

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The Apple half declares these with the Expo Modules 2.0 `@Record` macro, which
// infers fields from stored properties. There is no Kotlin equivalent yet, so
// these are the classic `@Field` records -- same wire shape, more ceremony.
// Keep the two in sync; `src/types.ts` is the contract both answer to.

class EarLoadOptions : Record {
  /** The model's home directory; null uses the app cache. */
  @Field val directory: String? = null
}

class EarIdentifyOptions : Record {
  /** `Options.windows = 3` in the Kotlin SDK, `Ear.defaultWindows` in Swift. */
  @Field val windows: Int = 3

  fun resolvedWindows(): Int {
    if (windows < 1) {
      throw InvalidArgumentException(
        "'$windows' is not a window count. Expected a whole number of at least 1."
      )
    }
    return windows
  }
}
