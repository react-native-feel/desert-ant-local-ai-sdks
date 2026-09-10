package ai.desertant.rn.clear

import ai.desertant.clear.ChannelMode
import ai.desertant.clear.Mastering
import ai.desertant.clear.Options
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The Apple half declares these with the Expo Modules 2.0 `@Record` macro, which
// infers fields from stored properties. There is no Kotlin equivalent yet, so
// these are the classic `@Field` records -- same wire shape, more ceremony.
// Keep the two in sync; `src/types.ts` is the contract both answer to.

class ClearLoadOptions : Record {
  /** `clear-studio` (default) or `clear-natural`. */
  @Field val variant: String = "clear-studio"

  /** The model's home directory; null uses the app cache. */
  @Field val directory: String? = null
}

class ClearEnhanceOptions : Record {
  @Field val strength: Double = 1.0
  @Field val masteringEnabled: Boolean = true
  @Field val targetLUFS: Double = -19.0
  @Field val peakCeilingDBFS: Double = -1.5
  @Field val maxGainDB: Double = 9.0
  @Field val outputSampleRate: Double = 48_000.0
  @Field val channelMode: String = "mono"
  @Field val balanceChannelsLUFS: Double? = null

  fun resolved(): Options {
    val mode = when (channelMode) {
      "mono" -> ChannelMode.MONO
      "preserve" -> ChannelMode.PRESERVE
      else -> throw InvalidArgumentException(
        "'$channelMode' is not a channel mode. Expected 'mono' or 'preserve'."
      )
    }
    return Options(
      strength = strength,
      mastering = Mastering(
        integratedLufs = targetLUFS,
        truePeakDbtp = peakCeilingDBFS,
        maxLoudnessGainDb = maxGainDB,
        enabled = masteringEnabled,
        balanceChannelsLufs = balanceChannelsLUFS,
      ),
      sampleRate = outputSampleRate,
      channelMode = mode,
    )
  }
}

/**
 * What mastering measured on the way out. Returned as a plain map rather than a
 * `Record`: records are an argument type on Android, and the return path wants a
 * Map. The keys are the Apple `ClearMetrics` field names.
 */
fun metricsOf(
  result: ai.desertant.clear.Result,
  variant: String? = null,
): Map<String, Any?> = mapOf(
  "sampleRate" to result.sampleRate,
  "durationSec" to result.durationSec,
  "processingSec" to result.processingSec,
  "channelCount" to result.channelCount,
  "realtimeFactor" to result.realtimeFactor,
  "measuredLUFS" to result.measuredLufs,
  "measuredTruePeakDBFS" to result.measuredTruePeakDbfs,
  "modelVariant" to variant,
  // `ai.desertant.clear.Result` carries no revision, unlike its Swift
  // counterpart, so this is honestly null rather than guessed.
  "modelRevision" to null,
  "modelRuntime" to "litert",
)

/** The zeroed metrics a JavaScript-constructed buffer reports. */
fun emptyMetrics(): Map<String, Any?> = mapOf(
  "sampleRate" to 0.0,
  "durationSec" to 0.0,
  "processingSec" to 0.0,
  "channelCount" to 0,
  "realtimeFactor" to 0.0,
  "measuredLUFS" to null,
  "measuredTruePeakDBFS" to null,
  "modelVariant" to null,
  "modelRevision" to null,
  "modelRuntime" to null,
)
