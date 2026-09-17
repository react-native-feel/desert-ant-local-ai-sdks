package ai.desertant.rn.ear

import ai.desertant.ear.Ear
import ai.desertant.ear.Options
import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.sharedobjects.SharedObject

/**
 * The model handle. One instance owns one LiteRT session, so an app creates it
 * once and reuses it.
 *
 * The Apple counterpart (ios/EarModel.swift) reports real progress fractions
 * because the Swift SDK's `download` takes a handler. This one cannot:
 * `ai.desertant:ear`'s `download()` is a bare suspending function with no
 * callback, so what it emits is phase boundaries -- 0 on entering `loadingModel`,
 * 1 on leaving it. `ProgressEvent.fraction` in the TypeScript types says so, and
 * it matters less here than it does for Clear: the download is ~9 MB, not ~490.
 */
class EarModelObject(
  context: Context,
  options: EarLoadOptions,
) : SharedObject() {

  private val ear = Ear(context.applicationContext, options.directory)
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
   * Name the language of the audio file at [path].
   *
   * The decode is this package's own (see AudioFiles) because the Kotlin SDK has
   * no file entry point. It runs *before* `load` rather than after, which is the
   * one place this half deliberately differs from the Apple one: there the decode
   * is inside upstream's `identify` and cannot be reordered, while here a file the
   * app cannot read should say so without first pulling 9 MB over the network.
   */
  suspend fun identifyFile(
    path: String,
    options: EarIdentifyOptions,
    emit: (String, Double) -> Unit,
  ): Map<String, Any?> {
    val windows = options.resolvedWindows()
    val decoded = AudioFiles.decodeMono(path)
    load(emit)
    return run(decoded.samples, decoded.sampleRate, windows)
  }

  /** Name the language of mono [samples] at [sampleRate]. */
  suspend fun identifySamples(
    samples: FloatArray,
    sampleRate: Double,
    options: EarIdentifyOptions,
    emit: (String, Double) -> Unit,
  ): Map<String, Any?> {
    val windows = options.resolvedWindows()
    if (samples.isEmpty()) throw InvalidArgumentException("Ear was given no usable audio: the sample buffer is empty")
    if (sampleRate <= 0) throw InvalidArgumentException("'$sampleRate' is not a sample rate")
    load(emit)
    return run(samples, sampleRate, windows)
  }

  /**
   * Returned as a map rather than a `Record`: records are an argument type on
   * Android, and the return path wants maps. The keys are the Apple
   * `EarDetection` field names.
   *
   * `language`, `confidence` and `isReliable` are read off the Kotlin `Detection`
   * -- the first two are its own computed properties over the same candidate
   * list, and `isReliable` is decided in the shared native core -- so neither
   * platform's module reimplements the rule.
   */
  private suspend fun run(
    samples: FloatArray,
    sampleRate: Double,
    windows: Int,
  ): Map<String, Any?> {
    val model = alive()
    val started = System.nanoTime()
    val detection = try {
      model.identify(samples, sampleRate, Options(windows = windows))
    } catch (e: CodedException) {
      // Anything already classified passes through. Nothing upstream raises one
      // today; this is here so that adding a coded throw around this call does
      // not silently become an inference failure and lose the code a caller
      // branches on.
      throw e
    } catch (e: IllegalArgumentException) {
      // `Ear.identify` uses `require` for an empty buffer and a non-positive
      // rate. Both are already checked before we get here, so reaching this
      // means a case upstream added -- still an argument problem, and worth the
      // right code rather than a generic one.
      throw InvalidArgumentException("${e.message}")
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    return mapOf(
      "language" to detection.language,
      "confidence" to detection.confidence,
      "isReliable" to detection.isReliable,
      "candidates" to detection.candidates.map {
        mapOf("language" to it.language, "probability" to it.probability)
      },
      "windows" to detection.windows,
      "processingSec" to (System.nanoTime() - started) / 1_000_000_000.0,
      "modelRevision" to MODEL_REVISION,
    )
  }

  // MARK: - Results waiting to be collected
  //
  // Kotlin has no encode-on-the-wrong-thread hazard to design around; it holds
  // the result anyway so that the TypeScript above it is one implementation
  // rather than two. See the Apple module for why the async half returns
  // nothing there.

  private val results = Any()
  private val pending = HashMap<String, Map<String, Any?>>()

  fun stash(jobId: String, value: Map<String, Any?>) {
    synchronized(results) { pending[jobId] = value }
  }

  /** The result held for [jobId], removed as it is read. */
  fun takeDetection(jobId: String): Map<String, Any?> = synchronized(results) {
    pending.remove(jobId)
      ?: throw InferenceFailedException("no result is waiting for job $jobId")
  }

  @Synchronized
  fun release() {
    if (released) return
    released = true
    synchronized(results) { pending.clear() }
    ear.close()
  }

  override fun sharedObjectDidRelease() = release()

  private fun alive(): Ear {
    if (released) throw ReleasedException("EarModel")
    return ear
  }

  private companion object {
    /**
     * `EarModel.revision` on the Apple side, which reads the catalog. The Kotlin
     * SDK exposes neither it nor the repo -- `ai.desertant:ear` publishes `Ear`,
     * `Detection`, `LanguageCandidate` and `Options` -- so it is a constant here,
     * pinned to the SDK version in build.gradle: revision `v0.1.0` is what
     * `ai.desertant:ear:3.1.0` resolves.
     */
    const val MODEL_REVISION = "v0.1.0"
  }
}
