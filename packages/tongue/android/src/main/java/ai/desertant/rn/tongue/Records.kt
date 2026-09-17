package ai.desertant.rn.tongue

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The Apple half declares these with the Expo Modules 2.0 `@Record` macro, which
// infers fields from stored properties. There is no Kotlin equivalent yet, so
// this is the classic `@Field` record -- same wire shape, more ceremony.
// `src/types.ts` is the contract both answer to.
//
// One record, where the other models here have two. There is no load-options
// record because `Tongue.bundled()` takes no directory: nothing is downloaded,
// so there is nowhere to point it.

class TongueDetectOptions : Record {
  /** `topK = 3` in both SDKs' `detect` signature. */
  @Field val topK: Int = 3

  fun resolvedTopK(): Int {
    if (topK < 1) {
      throw InvalidArgumentException(
        "'$topK' is not a candidate count. Expected a whole number of at least 1."
      )
    }
    return topK
  }
}
