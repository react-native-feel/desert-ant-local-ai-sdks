package ai.desertant.rn.redact

import ai.desertant.redact.Options
import ai.desertant.redact.Redact
import ai.desertant.redact.Redaction
import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.sharedobjects.SharedObject

/**
 * The model handle. One instance owns one LiteRT session, so an app creates it
 * once and reuses it.
 *
 * The Apple counterpart (ios/RedactModel.swift) reports real progress fractions
 * because the Swift SDK's `download` takes a handler. This one cannot:
 * `ai.desertant:redact`'s `download()` is a bare suspending function with no
 * callback, so what it emits is phase boundaries -- 0 on entering `loadingModel`,
 * 1 on leaving it. `ProgressEvent.fraction` in the TypeScript types says so.
 *
 * Results are held rather than returned, keyed by job id, for the same reason the
 * Apple half holds them -- see the long note on `RedactModelObject.redaction`
 * there. Kotlin has no encode-on-the-wrong-thread hazard; it holds them anyway so
 * that the TypeScript above it is one implementation rather than two.
 *
 * Redact is the fifth model in this repo with a working Android half, after
 * Clear, Emo, Ear and Gist: `desert-ant-core` publishes a LiteRT export of it and
 * `ai.desertant:redact` is on Maven Central. Voz, Clips and Uhm have no Android
 * build to bind to.
 */
class RedactModelObject(
  context: Context,
  options: RedactLoadOptions,
) : SharedObject() {

  private val redact = Redact(context.applicationContext, options.directory)
  private var released = false

  private val results = Object()
  private val redactions = HashMap<String, Map<String, Any?>>()

  fun isDownloaded(): Boolean = alive().isDownloaded()

  /**
   * Download the weights and build the session.
   *
   * The two are fused upstream on both platforms, so this is what `warm()` and
   * `download()` in TypeScript both land on. The failure is classified the same
   * way the Apple half classifies it -- the files being on disk afterwards is
   * what separates "the download failed" from "the session refused to build" --
   * so a caller's retry button means the same thing on both.
   */
  suspend fun load(emit: (String, Double) -> Unit) {
    emit("loadingModel", 0.0)
    try {
      alive().download()
    } catch (e: Exception) {
      val detail = "${e.javaClass.simpleName}: ${e.message}"
      throw if (isDownloaded()) {
        ModelLoadFailedException(detail)
      } else {
        ModelUnavailableException(detail)
      }
    }
    emit("loadingModel", 1.0)
  }

  /**
   * Redact [text] and hold the result under [jobId].
   *
   * Blank input returns the text unchanged with no items and without loading the
   * model. Neither upstream SDK guards this -- unlike Gist, where the two
   * disagree and one of them had to be picked -- so it is straightforwardly this
   * package's decision, taken on both platforms together. It is a safe one: the
   * deterministic recognizers match nothing in whitespace and the tagger has no
   * token to label. What it buys is a text field wired straight to `redaction`
   * costing nothing while it is empty, which for this model is the ordinary way
   * to use it.
   */
  suspend fun redaction(
    text: String,
    options: RedactRedactionOptions,
    jobId: String,
    emit: (String, Double) -> Unit,
  ) {
    val resolved = Options(
      minimumConfidence = options.resolvedConfidence(),
      labels = options.resolvedLabels(),
    )
    if (text.isBlank()) {
      put(jobId, passthrough(text))
      return
    }
    load(emit)
    val started = System.nanoTime()
    val result = try {
      alive().redaction(text, resolved)
    } catch (e: CodedException) {
      throw e
    } catch (e: IllegalArgumentException) {
      throw InvalidArgumentException("${e.message}")
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    put(jobId, redaction(result, seconds(started)))
  }

  /** The redaction held for [jobId], removed as it is read. */
  fun takeRedaction(jobId: String): Map<String, Any?> = synchronized(results) {
    redactions.remove(jobId)
      ?: throw InferenceFailedException("no redaction is waiting for job $jobId")
  }

  /**
   * Returned as maps rather than `Record`s: records are an argument type on
   * Android, and the return path wants maps. The keys are the Apple
   * `RedactRedaction` and `RedactItem` field names.
   */
  private fun redaction(result: Redaction, processingSec: Double) = mapOf(
    "redactedText" to result.redactedText,
    "items" to result.items.map {
      mapOf(
        "label" to it.label,
        "original" to it.original,
        "placeholder" to it.placeholder,
        "confidence" to it.confidence,
        // Already UTF-16 offsets here. The Apple half converts a
        // `Range<String.Index>` into the same two numbers, because that is what
        // upstream's own FFI binding writes.
        "start" to it.start,
        "end" to it.end,
      )
    },
    "processingSec" to processingSec,
    "modelRevision" to MODEL_REVISION,
  )

  private fun passthrough(text: String) = mapOf(
    "redactedText" to text,
    "items" to emptyList<Map<String, Any?>>(),
    "processingSec" to 0.0,
    "modelRevision" to MODEL_REVISION,
  )

  private fun put(jobId: String, value: Map<String, Any?>) {
    synchronized(results) { redactions[jobId] = value }
  }

  private fun seconds(startedNanos: Long) = (System.nanoTime() - startedNanos) / 1_000_000_000.0

  /**
   * Hand the native model back.
   *
   * It also drops any redaction still waiting to be read, which for this model
   * is worth doing explicitly rather than leaving to the garbage collector: what
   * is in that map is the caller's personal data in the clear.
   */
  @Synchronized
  fun release() {
    if (released) return
    released = true
    synchronized(results) { redactions.clear() }
    redact.close()
  }

  override fun sharedObjectDidRelease() = release()

  private fun alive(): Redact {
    if (released) throw ReleasedException("RedactModel")
    return redact
  }

  private companion object {
    /**
     * `RedactModel.revision` on the Apple side, which reads the catalog. The
     * Kotlin SDK exposes neither it nor the repo -- `ai.desertant:redact`
     * publishes `Redact`, `Redaction`, `RedactionItem`, `Options`, `Labels` and
     * `RedactException` -- so it is a constant here, pinned to the SDK version
     * in build.gradle: revision `v0.4.0` is what `ai.desertant:redact:3.1.0`
     * resolves.
     */
    const val MODEL_REVISION = "v0.4.0"
  }
}
