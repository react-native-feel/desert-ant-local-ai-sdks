package ai.desertant.rn.emo

import ai.desertant.emo.Emo
import android.content.Context
import expo.modules.kotlin.sharedobjects.SharedObject

/**
 * The model handle. One instance owns one LiteRT session, so an app creates it
 * once and reuses it.
 *
 * The Apple counterpart (ios/EmoModel.swift) reports real progress fractions
 * because the Swift SDK's `download` takes a handler. This one cannot:
 * `ai.desertant:emo`'s `download()` is a bare suspending function with no
 * callback, so what it emits is phase boundaries -- 0 on entering `loadingModel`,
 * 1 on leaving it. `ProgressEvent.fraction` in the TypeScript types says so, and
 * it matters less here than it does for Clear: the download is a few megabytes,
 * not a few hundred.
 */
class EmoModelObject(
  context: Context,
  options: EmoLoadOptions,
) : SharedObject() {

  private val emo = Emo(context.applicationContext, options.directory)
  private var released = false

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
   * Rank the vocabulary for [text] and return the top `limit`.
   *
   * `load` runs first even though `Emo.suggestions` would load lazily anyway, for
   * the reason the Apple half does it: upstream's lazy load happens *inside* the
   * call, so a failed download would surface as an inference failure and a caller
   * offering "retry the download" would never see the case it exists for.
   *
   * Returned as a list of plain maps rather than `Record`s: records are an
   * argument type on Android, and the return path wants maps. The keys are the
   * Apple `EmoSuggestionRecord` field names.
   */
  suspend fun suggest(
    text: String,
    options: EmoSuggestOptions,
    emit: (String, Double) -> Unit,
  ): List<Map<String, Any?>> {
    val limit = options.resolvedLimit()
    val skinTone = options.resolvedSkinTone()
    load(emit)
    return try {
      alive().suggestions(text, limit, skinTone).map {
        mapOf("emoji" to it.emoji, "confidence" to it.confidence)
      }
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
  }

  // MARK: - Results waiting to be collected
  //
  // Kotlin has no encode-on-the-wrong-thread hazard to design around; it holds
  // the result anyway so that the TypeScript above it is one implementation
  // rather than two. See the Apple module for why the async half returns
  // nothing there.

  private val results = Any()
  private val pending = HashMap<String, List<Map<String, Any?>>>()

  fun stash(jobId: String, value: List<Map<String, Any?>>) {
    synchronized(results) { pending[jobId] = value }
  }

  /** The result held for [jobId], removed as it is read. */
  fun takeSuggestions(jobId: String): List<Map<String, Any?>> = synchronized(results) {
    pending.remove(jobId)
      ?: throw InferenceFailedException("no result is waiting for job $jobId")
  }

  @Synchronized
  fun release() {
    if (released) return
    released = true
    synchronized(results) { pending.clear() }
    emo.close()
  }

  override fun sharedObjectDidRelease() = release()

  private fun alive(): Emo {
    if (released) throw ReleasedException("EmoModel")
    return emo
  }
}
