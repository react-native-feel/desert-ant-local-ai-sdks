package ai.desertant.rn.clear

import expo.modules.kotlin.sharedobjects.SharedObject
import expo.modules.kotlin.typedarray.Float32Array
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A block of PCM that lives in Kotlin and is filled or drained from JavaScript
 * one channel at a time. The Apple counterpart is ClearAudio.swift; the reason
 * for the shape is written up there, and it holds here for the same reason:
 * typed arrays are only safe to touch on the JS thread, so the transfer is a
 * synchronous memcpy and the model work happens after it.
 *
 * A minute of 48 kHz mono is ~11 MB, which is why `enhanceFile` -- not this --
 * is the primary API.
 */
class ClearAudioObject(
  private var channels: MutableList<FloatArray>,
  val rate: Double,
  val metrics: Map<String, Any?>,
) : SharedObject() {

  companion object {
    /** Allocate a silent buffer for JavaScript to fill with `write`. */
    fun allocate(channelCount: Int, frameCount: Int, sampleRate: Double): ClearAudioObject {
      if (channelCount <= 0 || frameCount < 0 || sampleRate <= 0) {
        throw InvalidArgumentException(
          "A ClearAudio needs at least one channel and a non-negative frame count; " +
            "got $channelCount x $frameCount."
        )
      }
      return ClearAudioObject(
        MutableList(channelCount) { FloatArray(frameCount) },
        sampleRate,
        emptyMetrics(),
      )
    }
  }

  val channelCount: Int get() = channels.size

  val frameCount: Int get() = channels.firstOrNull()?.size ?: 0

  /** The samples, for the model to consume. */
  fun channelData(): List<FloatArray> = channels

  fun write(channel: Int, data: Float32Array) {
    val count = checked(channel, data.length)
    if (count == 0) return
    floatsOf(data, count).get(channels[channel], 0, count)
  }

  fun read(channel: Int, into: Float32Array) {
    val count = checked(channel, into.length)
    if (count == 0) return
    if (into.byteOffset == 0) {
      into.toDirectBuffer().order(ByteOrder.nativeOrder()).asFloatBuffer()
        .put(channels[channel], 0, count)
      return
    }
    // An offset view (`new Float32Array(buffer, offset)`) does not line up with
    // the direct buffer, so go through the array's own offset-relative writer.
    val bytes = ByteBuffer.allocate(count * Float.SIZE_BYTES).order(ByteOrder.nativeOrder())
    bytes.asFloatBuffer().put(channels[channel], 0, count)
    into.write(bytes.array(), 0, count * Float.SIZE_BYTES)
  }

  /**
   * Called when JavaScript releases the shared object. A minute of audio is
   * megabytes, so drop it here rather than waiting for two garbage collectors to
   * agree.
   */
  override fun sharedObjectDidRelease() {
    channels = MutableList(channels.size) { FloatArray(0) }
  }

  override fun getAdditionalMemoryPressure(): Int =
    (channels.sumOf { it.size.toLong() } * Float.SIZE_BYTES).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()

  private fun floatsOf(data: Float32Array, count: Int) =
    if (data.byteOffset == 0) {
      data.toDirectBuffer().order(ByteOrder.nativeOrder()).asFloatBuffer()
    } else {
      val bytes = ByteArray(count * Float.SIZE_BYTES)
      data.read(bytes, 0, bytes.size)
      ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder()).asFloatBuffer()
    }

  private fun checked(channel: Int, length: Int): Int {
    if (channel < 0 || channel >= channels.size) {
      throw InvalidArgumentException("Channel $channel is out of range; the buffer has ${channels.size}.")
    }
    val expected = channels[channel].size
    if (length != expected) {
      throw InvalidArgumentException(
        "The Float32Array holds $length samples but the buffer's channel holds $expected. " +
          "Allocate it with the buffer's `frameCount`."
      )
    }
    return expected
  }
}
