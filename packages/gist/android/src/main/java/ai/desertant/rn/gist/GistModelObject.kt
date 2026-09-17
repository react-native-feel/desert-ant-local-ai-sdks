package ai.desertant.rn.gist

import ai.desertant.gist.Gist
import ai.desertant.gist.Topic
import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.sharedobjects.SharedObject

/**
 * The model handle. One instance owns one LiteRT session, so an app creates it
 * once and reuses it.
 *
 * The Apple counterpart (ios/GistModel.swift) reports real progress fractions
 * because the Swift SDK's `download` takes a handler. This one cannot:
 * `ai.desertant:gist`'s `download()` is a bare suspending function with no
 * callback, so what it emits is phase boundaries -- 0 on entering `loadingModel`,
 * 1 on leaving it. `ProgressEvent.fraction` in the TypeScript types says so, and
 * it matters more here than for Ear or Emo: the download is ~74 MB, not ~9.
 *
 * Results are held rather than returned, keyed by job id, for the same reason the
 * Apple half holds them -- see the long note on `GistModelObject.classify` there.
 * Kotlin has no such hazard; it holds them anyway so that one TypeScript file
 * describes both platforms.
 */
class GistModelObject(
  context: Context,
  options: GistLoadOptions,
) : SharedObject() {

  /** Which build this instance loads. Always `multilingual` here -- see
   *  `GistLoadOptions.resolvedVariant`. */
  val variant: String = options.resolvedVariant()

  private val gist = Gist(context.applicationContext, options.directory)
  private var released = false

  private val results = Object()
  private val taggings = HashMap<String, Map<String, Any?>>()
  private val distributions = HashMap<String, Map<String, Any?>>()

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
   * Tag [text] and hold the result under [jobId].
   *
   * Blank input returns an empty tagging without loading the model, which is
   * `ai.desertant:gist`'s own behaviour (`if (text.isBlank()) return emptyList()`)
   * and the behaviour the Apple half was given to match it. It is also why a text
   * field wired straight to `classify` costs nothing while it is empty.
   */
  suspend fun classify(
    text: String,
    options: GistClassifyOptions,
    jobId: String,
    emit: (String, Double) -> Unit,
  ) {
    val topK = options.resolvedTopK()
    val threshold = options.resolvedThreshold()
    if (text.isBlank()) {
      put(taggings, jobId, tagging(emptyList(), threshold, 0.0))
      return
    }
    load(emit)
    val started = System.nanoTime()
    val topics = try {
      alive().classify(text, topK, threshold)
    } catch (e: CodedException) {
      throw e
    } catch (e: IllegalArgumentException) {
      throw InvalidArgumentException("${e.message}")
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    put(taggings, jobId, tagging(topics, threshold, seconds(started)))
  }

  /** The full 36-topic distribution for [text], held under [jobId]. */
  suspend fun scores(text: String, jobId: String, emit: (String, Double) -> Unit) {
    if (text.isBlank()) {
      put(distributions, jobId, distribution(emptyMap(), 0.0))
      return
    }
    load(emit)
    val started = System.nanoTime()
    val scores = try {
      alive().scores(text)
    } catch (e: CodedException) {
      throw e
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    put(distributions, jobId, distribution(scores, seconds(started)))
  }

  /** The tagging held for [jobId], removed as it is read. */
  fun takeTagging(jobId: String): Map<String, Any?> =
    take(taggings, jobId, "tagging")

  /** The distribution held for [jobId], removed as it is read. */
  fun takeDistribution(jobId: String): Map<String, Any?> =
    take(distributions, jobId, "distribution")

  /**
   * Returned as maps rather than `Record`s: records are an argument type on
   * Android, and the return path wants maps. The keys are the Apple
   * `GistTagging` and `GistDistribution` field names.
   */
  private fun tagging(topics: List<Topic>, threshold: Double?, processingSec: Double) = mapOf(
    "topics" to topics.map {
      mapOf("slug" to it.slug, "name" to it.name, "score" to it.score)
    },
    // The caller's override, echoed back, and null when there was none: the
    // model's own tuned threshold is behind `Gist.tagged`, which is private, so
    // there is nothing here to read. The Apple half refuses for the mirror-image
    // reason (`Model.threshold` is internal).
    "threshold" to threshold,
    "processingSec" to processingSec,
    "modelRevision" to MODEL_REVISION,
    "variant" to variant,
  )

  private fun distribution(scores: Map<String, Double>, processingSec: Double) = mapOf(
    // Sorted by slug, matching the Apple half, so two devices' logs line up.
    "scores" to scores.entries.sortedBy { it.key }.map {
      mapOf("slug" to it.key, "score" to it.value)
    },
    "processingSec" to processingSec,
    "modelRevision" to MODEL_REVISION,
    "variant" to variant,
  )

  private fun put(into: HashMap<String, Map<String, Any?>>, jobId: String, value: Map<String, Any?>) {
    synchronized(results) { into[jobId] = value }
  }

  private fun take(
    from: HashMap<String, Map<String, Any?>>,
    jobId: String,
    what: String,
  ): Map<String, Any?> = synchronized(results) {
    from.remove(jobId) ?: throw InferenceFailedException("no $what is waiting for job $jobId")
  }

  private fun seconds(startedNanos: Long) = (System.nanoTime() - startedNanos) / 1_000_000_000.0

  @Synchronized
  fun release() {
    if (released) return
    released = true
    gist.close()
  }

  override fun sharedObjectDidRelease() = release()

  private fun alive(): Gist {
    if (released) throw ReleasedException("GistModel")
    return gist
  }

  private companion object {
    /**
     * `GistModel.revision` on the Apple side, which reads the catalog. The Kotlin
     * SDK exposes neither it nor the repo -- `ai.desertant:gist` publishes `Gist`,
     * `Topic`, `GistException`, `PostTopics`, `ChannelTopic`, `RollupOptions` and
     * `channelTopics` -- so it is a constant here, pinned to the SDK version in
     * build.gradle: revision `v2.2.0` is what `ai.desertant:gist:3.1.0` resolves.
     */
    const val MODEL_REVISION = "v2.2.0"
  }
}
