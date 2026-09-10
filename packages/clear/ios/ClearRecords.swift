// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.
//
// These deliberately mirror `index.d.ts` in `@desert-ant-labs/clear` (the web
// SDK) rather than the Swift SDK's own shapes: an app moving between Desert Ant's
// platforms should not have to relearn the options.

import ExpoModulesCore
import Clear

/// How a `ClearModel` finds its weights.
@Record
struct ClearLoadOptions {
  /// A `ModelVariant` raw value: `clear-studio` (default) or `clear-natural`.
  var variant: String = "clear-studio"

  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the weights points at the folder it unpacked them into. Nil uses the
  /// app cache.
  var directory: String?
}

/// One `enhance` call's settings. The TS layer resolves loudness presets to a
/// number before this is built, so there is exactly one representation of a
/// target here.
@Record
struct ClearEnhanceOptions {
  /// Enhancement blend in `0...1`. 1 is the full model output.
  var strength: Double = 1.0

  /// False bypasses the mastering chain and returns the model's own level.
  /// Split from `targetLUFS` on purpose: a nullable-with-a-default field would
  /// make "omitted" and "explicitly bypassed" the same wire value.
  var masteringEnabled: Bool = true

  /// Integrated-LUFS target. Ignored when `masteringEnabled` is false.
  var targetLUFS: Double = -19.0

  /// True-peak ceiling in dBTP.
  var peakCeilingDBFS: Double = -1.5

  /// Upper bound on the loudness gain in dB, so a very quiet input lands under
  /// target rather than lifting the model's noise floor with it.
  var maxGainDB: Double = 9.0

  /// Delivery sample rate. The model always runs at 48 kHz; the result is
  /// resampled on the way out.
  var outputSampleRate: Double = 48_000

  /// `mono` (default) or `preserve`.
  var channelMode: String = "mono"

  /// Per-channel LUFS target applied before the joint stages, for a pair whose
  /// sides were recorded at different levels. Nil leaves the balance alone.
  var balanceChannelsLUFS: Double?

  /// Resolve into the Swift SDK's own options type.
  func resolved() throws -> Clear.Options {
    let mode: Clear.ChannelMode
    switch channelMode {
    case "mono": mode = .mono
    case "preserve": mode = .preserve
    default: throw InvalidChannelModeException(channelMode)
    }
    let mastering = Clear.Mastering(
      integratedLUFS: targetLUFS,
      truePeakDBTP: peakCeilingDBFS,
      enabled: masteringEnabled,
      maxLoudnessGainDB: maxGainDB,
      balanceChannelsLUFS: balanceChannelsLUFS
    )
    return Clear.Options(
      strength: Clear.Strength(strength),
      mastering: mastering,
      sampleRate: outputSampleRate,
      channelMode: mode
    )
  }
}

/// What mastering measured on the way out, plus which artifact produced it.
///
/// The audio itself is never in here: a file call leaves it on disk and a buffer
/// call leaves it in a `ClearAudio`, so this record stays small enough that
/// returning it costs nothing.
@Record
struct ClearMetrics {
  var sampleRate: Double = 0
  var durationSec: Double = 0
  var processingSec: Double = 0
  var channelCount: Int = 0
  /// `durationSec / processingSec`: above 1 is faster than real time.
  var realtimeFactor: Double = 0
  /// Integrated loudness of the *input*, or nil when mastering was bypassed.
  var measuredLUFS: Double?
  /// True peak of the delivered audio in dBFS, measured after limiting, so it is
  /// what to assert a delivery spec against. Nil when mastering was bypassed.
  var measuredTruePeakDBFS: Double?
  /// The variant that produced this output, so a benchmark is self-identifying.
  var modelVariant: String?
  /// The published model revision this output came from, for a self-identifying
  /// benchmark or telemetry event. Nil on Android: `ai.desertant.clear.Result`
  /// carries no revision.
  var modelRevision: String?
  /// Which inference runtime ran it. Derived from the platform rather than read
  /// off the result -- `Clear.Result` gained a `modelRuntime` field after 3.1.0,
  /// and this SDK pins 3.1.0.
  var modelRuntime: String?
}

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func clearMetrics(from result: Clear.Result, variant: ModelVariant) -> ClearMetrics {
  var metrics = ClearMetrics()
  metrics.sampleRate = result.sampleRate
  metrics.durationSec = result.durationSec
  metrics.processingSec = result.processingSec
  metrics.channelCount = result.channelCount
  metrics.realtimeFactor = result.realtimeFactor
  metrics.measuredLUFS = result.measuredLUFS
  metrics.measuredTruePeakDBFS = result.measuredTruePeakDBFS
  metrics.modelVariant = result.modelVariant?.rawValue ?? variant.rawValue
  metrics.modelRevision = result.modelRevision
  metrics.modelRuntime = "coreml"
  return metrics
}

/// A progress tick. `jobId` is the id the caller passed to the `enhance*` call,
/// so one listener can serve concurrent calls.
@Record
struct ClearProgressEvent {
  var jobId: String = ""
  /// `loadingModel`, `analyzing` or `enhancing`.
  var phase: String = ""
  var fraction: Double = 0
}
