package ai.desertant.rn.tongue

import ai.desertant.tongue.Detection
import ai.desertant.tongue.Tongue
import ai.desertant.tongue.TongueException
import android.content.Context
import expo.modules.kotlin.sharedobjects.SharedObject

/**
 * The model handle. One instance owns one parsed copy of the weights, so an app
 * creates it once and reuses it.
 *
 * The closest counterpart in this repo to ios/TongueModel.swift, and for once
 * almost line for line. Emo's two halves were symmetric in their API; these two
 * are symmetric in their *work* as well, because the Kotlin SDK is not a binding
 * over the Swift one -- it is a second implementation of the same frozen
 * specification, held to it by golden vectors upstream. The pipeline is an int8
 * gather, a sum, one 59x32 matmul and a masked softmax in both places.
 *
 * Two differences survive, and neither is this module's doing:
 *
 *  * `Tongue.bundled(context)` takes a `Context` where the Swift initializer
 *    takes nothing. It is not for the weights -- those are a jar resource read
 *    through the class loader -- but for the usage turnstile, which without one
 *    has nowhere durable to keep its device id and makes every process look like
 *    a new device.
 *  * `Router` and `ScriptTables` are `internal` here and public in Swift, so
 *    this half has no script catalogue to offer. TongueModule refuses rather
 *    than inventing one.
 */
class TongueModelObject(private val context: Context) : SharedObject() {

  @Volatile private var tongue: Tongue? = null
  @Volatile private var released = false

  fun isLoaded(): Boolean = tongue != null

  /**
   * Read the bundled weights and build the pipeline. Idempotent.
   *
   * Suspending for the same reason the Apple half is `async`, which is not I/O:
   * `Weights` widens 2,097,152 bytes and decodes ~7,500 floats, and that is the
   * only part of this model measured in milliseconds. There is no download to
   * wait on and no progress to report -- `bundled()` takes no callback, and there
   * would be nothing to put in one.
   */
  @Synchronized
  fun load() {
    if (released) throw ReleasedException("TongueModel")
    if (tongue != null) return
    tongue = try {
      Tongue.bundled(context)
    } catch (e: TongueException) {
      // Everything upstream raises from this path is a missing or malformed
      // resource. A jar that lost its resources is the load failing, not the
      // model being absent from the device -- it can never be absent.
      throw ModelLoadFailedException("${e.message}")
    } catch (e: Exception) {
      throw ModelLoadFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
  }

  /**
   * Identify the language of [text].
   *
   * Synchronous, and called on the JavaScript thread: upstream measures a
   * detection in tens of microseconds. Refuses rather than loading lazily, so
   * that reading 2 MB never happens behind a caller's back.
   *
   * Returned as a map rather than a `Record`: records are an argument type on
   * Android and the return path wants maps. The keys are the Apple
   * `TongueDetection` field names.
   */
  fun detect(text: String, options: TongueDetectOptions): Map<String, Any?> {
    val topK = options.resolvedTopK()
    val model = alive()
    val started = System.nanoTime()
    val detection = try {
      model.detect(text, topK)
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    return detection.toMap((System.nanoTime() - started) / 1_000_000_000.0)
  }

  @Synchronized
  fun release() {
    if (released) return
    released = true
    tongue = null
  }

  override fun sharedObjectDidRelease() = release()

  private fun alive(): Tongue {
    if (released) throw ReleasedException("TongueModel")
    return tongue
      ?: throw ModelUnavailableException(
        "the weights have not been read yet -- await `Tongue.load()` or `warm()` first"
      )
  }
}

/**
 * The wire shape, matching `tongueDetection(from:processingSec:)` on the Apple
 * side field for field.
 *
 * The two enums cross as their Swift lowerCamelCase spellings, which is what
 * `Reliability.rawValue` and `Verdict.rawValue` already are over there. Kotlin's
 * enum constants are `CONFIDENT` and `DECISIVE`, so this lowercases rather than
 * letting two platforms disagree about the same string -- `src/types.ts` is the
 * contract and it says `'confident'`.
 */
private fun Detection.toMap(processingSec: Double): Map<String, Any?> = mapOf(
  "language" to language,
  "confidence" to (candidates.firstOrNull()?.probability ?: 0.0),
  "reliability" to reliability.name.lowercase(),
  "isTooCloseToCall" to isTooCloseToCall,
  "candidates" to candidates.map {
    mapOf("language" to it.language, "probability" to it.probability)
  },
  "normalized" to normalized,
  "route" to mapOf(
    "verdict" to route.verdict.name.lowercase(),
    "candidates" to route.candidates,
    "script" to route.script,
  ),
  "processingSec" to processingSec,
  "modelRevision" to MODEL_REVISION,
)

/**
 * `TongueModel.revision` on the Apple side, which reads the catalog. The Kotlin
 * SDK exposes neither it nor the repo -- `ai.desertant:tongue` publishes
 * `Tongue`, `Detection`, `Prediction`, `Route`, `Reliability` and `Verdict` --
 * so they are constants here, pinned to the SDK version in build.gradle:
 * revision `v1.0.0` is what `ai.desertant:tongue:3.1.0` bundles.
 */
internal const val MODEL_REVISION = "v1.0.0"
internal const val MODEL_REPO = "desert-ant-labs/tongue"
