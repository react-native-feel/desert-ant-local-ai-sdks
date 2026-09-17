package ai.desertant.rn.clear

import ai.desertant.clear.Clear
import android.content.Context
import expo.modules.kotlin.sharedobjects.SharedObject

/**
 * The model handle. One instance owns one LiteRT session, so an app creates it
 * once and reuses it.
 *
 * The Apple counterpart (ClearModel.swift) reports real progress fractions
 * because the Swift SDK takes a `ProgressHandler`. This one cannot: neither
 * `LoadedModel.download()` nor `Clear.enhance()` in `ai.desertant:clear` accepts
 * a callback, so what it emits is phase boundaries -- 0 on entering a phase, 1 on
 * leaving it. `ProgressEvent.fraction` in the TypeScript types says so, and the
 * example app renders an indeterminate bar on Android for exactly this reason.
 */
class ClearModelObject(
  context: Context,
  private val options: ClearLoadOptions,
) : SharedObject() {

  private val clear = Clear(context.applicationContext, options.directory)
  private var released = false

  fun isDownloaded(): Boolean = alive().isDownloaded()

  suspend fun download(emit: (String, Double) -> Unit) {
    emit("loadingModel", 0.0)
    try {
      alive().download()
    } catch (e: Exception) {
      throw ModelUnavailableException("${e.javaClass.simpleName}: ${e.message}")
    }
    emit("loadingModel", 1.0)
  }

  /**
   * Decode `inputPath`, enhance it, write it to `outputPath`, and report what
   * mastering measured. The decode and encode are ours (see AudioFiles.kt); the
   * enhancement in the middle is the same native core the Apple side runs.
   */
  suspend fun enhanceFile(
    inputPath: String,
    outputPath: String,
    enhanceOptions: ClearEnhanceOptions,
    emit: (String, Double) -> Unit,
  ): Map<String, Any?> {
    val resolved = enhanceOptions.resolved()
    if (!isDownloaded()) {
      emit("loadingModel", 0.0)
    }
    emit("analyzing", 0.0)
    val decoded = AudioFiles.decode(inputPath)
    emit("analyzing", 1.0)

    emit("enhancing", 0.0)
    val result = try {
      alive().enhance(decoded.channels, decoded.sampleRate, resolved)
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    AudioFiles.encode(result.channels, result.sampleRate, outputPath)
    emit("enhancing", 1.0)

    return metricsOf(result, variant = options.variant, outputPath = outputPath)
  }

  suspend fun enhanceBuffer(
    input: ClearAudioObject,
    enhanceOptions: ClearEnhanceOptions,
    emit: (String, Double) -> Unit,
  ): ClearAudioObject {
    val resolved = enhanceOptions.resolved()
    val channels = input.channelData()
    if (channels.isEmpty() || channels[0].isEmpty()) {
      throw AudioDecodeFailedException("the input buffer is empty")
    }
    emit("enhancing", 0.0)
    val result = try {
      alive().enhance(channels, input.rate, resolved)
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    emit("enhancing", 1.0)
    return ClearAudioObject(
      result.channels.toMutableList(),
      result.sampleRate,
      metricsOf(result, variant = options.variant),
    )
  }

  // MARK: - Results waiting to be collected
  //
  // Kotlin has no encode-on-the-wrong-thread hazard to design around; it holds
  // the results anyway so that the TypeScript above it is one implementation
  // rather than two. See `ClearModule.enhanceFile` on the Apple side for why
  // the async half there returns nothing.

  private val results = Any()
  private val metrics = HashMap<String, Map<String, Any?>>()
  private val buffers = HashMap<String, ClearAudioObject>()

  fun stashMetrics(jobId: String, value: Map<String, Any?>) {
    synchronized(results) { metrics[jobId] = value }
  }

  /** The metrics held for [jobId], removed as they are read. */
  fun takeMetrics(jobId: String): Map<String, Any?> = synchronized(results) {
    metrics.remove(jobId)
      ?: throw InferenceFailedException("no metrics are waiting for job $jobId")
  }

  fun stashAudio(jobId: String, value: ClearAudioObject) {
    synchronized(results) { buffers[jobId] = value }
  }

  /** The enhanced buffer held for [jobId], removed as it is read. */
  fun takeEnhancedAudio(jobId: String): ClearAudioObject = synchronized(results) {
    buffers.remove(jobId)
      ?: throw InferenceFailedException("no audio is waiting for job $jobId")
  }

  @Synchronized
  fun release() {
    if (released) return
    released = true
    synchronized(results) {
      metrics.clear()
      buffers.clear()
    }
    clear.close()
  }

  override fun sharedObjectDidRelease() = release()

  private fun alive(): Clear {
    if (released) throw ReleasedException("ClearModel")
    return clear
  }

  companion object {
    const val DEFAULT_VARIANT = "clear-studio"

    /**
     * `ai.desertant:clear` has no variant parameter -- `Clear(context, directory)`
     * is the whole constructor -- so honouring anything but the default would be a
     * lie. Checked before the model is constructed, so a rejected variant leaks
     * nothing.
     */
    fun requireSupportedVariant(variant: String) {
      if (variant != DEFAULT_VARIANT) {
        throw InvalidArgumentException(
          "The Android SDK (ai.desertant:clear) only ships the '$DEFAULT_VARIANT' variant; " +
            "'$variant' is available on Apple platforms only."
        )
      }
    }
  }
}
