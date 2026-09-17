package ai.desertant.rn.ear

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Build
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * File in, mono samples out -- the half of the SDK that Android has to write
 * itself.
 *
 * The Swift SDK exposes `Ear.identify(path:)` and `identify(contentsOf:)`, backed
 * by upstream's own `AudioIO`. `ai.desertant:ear` exposes no such thing: its only
 * entry point is `identify(samples, sampleRate, options)` (see Ear.kt in
 * desert-ant-core). So the decode lives here, and `identify({ uri })` means the
 * same thing on both platforms rather than being an iOS-only convenience.
 *
 * This is Clear's problem again, and deliberately not Clear's solution copied
 * whole. Clear needs the channels kept apart and an encoder to write a file back
 * out; Ear needs neither -- it consumes one mono buffer and returns a few
 * candidates -- so what is here is the decode half, downmixing as it goes.
 * Sharing the two would mean an Android artifact in `packages/core`, which today
 * is Apple-only; that is the right fix if a third model needs a decoder, and
 * overbuilt for the second.
 *
 * No resampling, which is the other thing Clear needs and this does not: the
 * Kotlin `Ear.identify` takes the rate as an argument and resamples internally,
 * so handing it 44.1 kHz and saying so is correct and costs nothing here.
 *
 * Like Clear's, this holds the whole decoded file in memory. A minute of 44.1 kHz
 * mono is ~10 MB of float, which is fine; a two-hour podcast is not, and that is
 * the honest limit of this implementation today. It bites slightly less than it
 * does for Clear -- Ear listens to at most three thirty-second windows -- but the
 * windows are chosen by scanning the whole file, so the whole file still has to
 * be decoded to choose them.
 */
internal object AudioFiles {

  class Decoded(val samples: FloatArray, val sampleRate: Double)

  fun decodeMono(path: String): Decoded {
    val file = File(path)
    if (!file.isFile) {
      throw AudioDecodeFailedException("no file at $path")
    }
    val decoded = if (path.substringAfterLast('.', "").lowercase() == "wav") {
      decodeWav(file)
    } else {
      decodeCompressed(path)
    }
    if (decoded.samples.isEmpty()) {
      throw AudioDecodeFailedException("$path decoded to no audio")
    }
    return decoded
  }

  // MARK: - WAV

  private fun decodeWav(file: File): Decoded {
    RandomAccessFile(file, "r").use { raf ->
      val header = ByteArray(12)
      if (raf.read(header) != 12 || String(header, 0, 4) != "RIFF" || String(header, 8, 4) != "WAVE") {
        throw AudioDecodeFailedException("${file.name} is not a RIFF/WAVE file")
      }
      var channelCount = 0
      var sampleRate = 0
      var bitsPerSample = 0
      var isFloat = false
      val chunk = ByteArray(8)
      while (raf.read(chunk) == 8) {
        val id = String(chunk, 0, 4)
        val size = ByteBuffer.wrap(chunk, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
        if (size < 0) throw AudioDecodeFailedException("${file.name} declares a chunk larger than 2 GB")
        when (id) {
          "fmt " -> {
            val fmt = ByteArray(size)
            raf.readFully(fmt)
            val b = ByteBuffer.wrap(fmt).order(ByteOrder.LITTLE_ENDIAN)
            var format = b.short.toInt() and 0xFFFF
            channelCount = b.short.toInt() and 0xFFFF
            sampleRate = b.int
            b.int // byte rate
            b.short // block align
            bitsPerSample = b.short.toInt() and 0xFFFF
            // WAVE_FORMAT_EXTENSIBLE carries the real format in its GUID's first
            // two bytes, at offset 24 of the fmt chunk.
            if (format == 0xFFFE && size >= 26) {
              format = ByteBuffer.wrap(fmt, 24, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF
            }
            isFloat = format == 3
            if (format != 1 && format != 3) {
              throw AudioDecodeFailedException("unsupported WAV format tag $format; expected PCM or IEEE float")
            }
          }
          "data" -> {
            val data = ByteArray(size)
            raf.readFully(data)
            if (channelCount <= 0 || sampleRate <= 0) {
              throw AudioDecodeFailedException("${file.name} has a data chunk before its fmt chunk")
            }
            return Decoded(
              downmix(pcmToFloat(data, bitsPerSample, isFloat), channelCount),
              sampleRate.toDouble(),
            )
          }
          else -> raf.seek(raf.filePointer + size + (size and 1))
        }
      }
      throw AudioDecodeFailedException("${file.name} has no data chunk")
    }
  }

  // MARK: - Everything MediaCodec can open

  private fun decodeCompressed(path: String): Decoded {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      extractor.setDataSource(path)
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: throw AudioDecodeFailedException("$path has no audio track")

      extractor.selectTrack(track)
      val inputFormat = extractor.getTrackFormat(track)
      val mime = inputFormat.getString(MediaFormat.KEY_MIME)
        ?: throw AudioDecodeFailedException("$path has an audio track with no MIME type")

      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(inputFormat, null, null, 0)
      codec.start()

      val pcm = java.io.ByteArrayOutputStream()
      val info = MediaCodec.BufferInfo()
      var channelCount = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var sampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var pcmEncoding = 16
      var sawInputEnd = false
      var sawOutputEnd = false

      while (!sawOutputEnd) {
        if (!sawInputEnd) {
          val index = codec.dequeueInputBuffer(TIMEOUT_US)
          if (index >= 0) {
            val buffer = codec.getInputBuffer(index)!!
            val read = extractor.readSampleData(buffer, 0)
            if (read < 0) {
              codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              sawInputEnd = true
            } else {
              codec.queueInputBuffer(index, 0, read, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        when (val index = codec.dequeueOutputBuffer(info, TIMEOUT_US)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = codec.outputFormat
            channelCount = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            pcmEncoding = pcmBitsOf(format)
          }
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          else -> if (index >= 0) {
            if (info.size > 0) {
              val buffer = codec.getOutputBuffer(index)!!
              val bytes = ByteArray(info.size)
              buffer.position(info.offset)
              buffer.get(bytes)
              pcm.write(bytes)
            }
            codec.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEnd = true
          }
        }
      }

      if (channelCount <= 0 || sampleRate <= 0) {
        throw AudioDecodeFailedException("$path decoded to $channelCount channels at $sampleRate Hz")
      }
      val interleaved = pcmToFloat(pcm.toByteArray(), pcmEncoding, isFloat = pcmEncoding == 32)
      return Decoded(downmix(interleaved, channelCount), sampleRate.toDouble())
    } catch (e: AudioDecodeFailedException) {
      throw e
    } catch (e: Exception) {
      throw AudioDecodeFailedException("${e.javaClass.simpleName}: ${e.message}")
    } finally {
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
      runCatching { extractor.release() }
    }
  }

  // MARK: - Sample conversion

  private fun pcmBitsOf(format: MediaFormat): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || !format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
      return 16
    }
    return when (format.getInteger(MediaFormat.KEY_PCM_ENCODING)) {
      android.media.AudioFormat.ENCODING_PCM_8BIT -> 8
      android.media.AudioFormat.ENCODING_PCM_FLOAT -> 32
      else -> 16
    }
  }

  private fun pcmToFloat(bytes: ByteArray, bits: Int, isFloat: Boolean): FloatArray {
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    return when {
      isFloat && bits == 32 -> FloatArray(bytes.size / 4).also { buffer.asFloatBuffer().get(it) }
      bits == 8 -> FloatArray(bytes.size) { ((bytes[it].toInt() and 0xFF) - 128) / 128f }
      bits == 16 -> FloatArray(bytes.size / 2).also { out ->
        val shorts = buffer.asShortBuffer()
        for (i in out.indices) out[i] = shorts.get(i) / 32768f
      }
      bits == 24 -> FloatArray(bytes.size / 3) { i ->
        val o = i * 3
        val v = (bytes[o].toInt() and 0xFF) or
          ((bytes[o + 1].toInt() and 0xFF) shl 8) or
          (bytes[o + 2].toInt() shl 16)
        v / 8388608f
      }
      bits == 32 -> FloatArray(bytes.size / 4).also { out ->
        val ints = buffer.asIntBuffer()
        for (i in out.indices) out[i] = ints.get(i) / 2147483648f
      }
      else -> throw AudioDecodeFailedException("unsupported sample width: $bits bits")
    }
  }

  /**
   * Interleaved frames to one mono channel, by averaging.
   *
   * Averaging rather than taking the left channel: a recording with one speaker
   * panned off-centre, or an interview with a speaker per channel, would lose
   * exactly the audio the answer depends on. It is also what the Apple path does
   * -- `AudioIO.decode` downmixes -- so the two platforms hand the model the same
   * buffer for the same file.
   */
  private fun downmix(interleaved: FloatArray, channelCount: Int): FloatArray {
    if (channelCount == 1) return interleaved
    val frames = interleaved.size / channelCount
    return FloatArray(frames) { frame ->
      var sum = 0f
      for (channel in 0 until channelCount) sum += interleaved[frame * channelCount + channel]
      sum / channelCount
    }
  }

  private const val TIMEOUT_US = 10_000L
}
