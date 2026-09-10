package ai.desertant.rn.clear

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * File in, file out -- the half of the SDK that Android has to write itself.
 *
 * The Swift SDK exposes `Clear.enhance(path:to:)`, backed by AVFoundation and a
 * bounded-memory streaming pass. `ai.desertant:clear` exposes no such thing: its
 * only entry point is `enhance(channels, sampleRate, options)`, samples in and
 * samples out (see Clear.kt in desert-ant-core). So the decode and the encode
 * live here, and `enhanceFile` means the same thing on both platforms.
 *
 * Unlike the Apple path this holds the whole programme in memory. A minute of
 * 48 kHz mono is ~11 MB of float, which is fine; a two-hour recording is not, and
 * that is the honest limit of this implementation today.
 */
internal object AudioFiles {

  class Decoded(val channels: List<FloatArray>, val sampleRate: Double)

  fun decode(path: String): Decoded {
    val file = File(path)
    if (!file.isFile) {
      throw AudioDecodeFailedException("no file at $path")
    }
    return if (path.substringAfterLast('.', "").lowercase() == "wav") {
      decodeWav(file)
    } else {
      decodeCompressed(path)
    }
  }

  fun encode(channels: List<FloatArray>, sampleRate: Double, path: String) {
    val parent = File(path).parentFile
    if (parent != null && !parent.exists() && !parent.mkdirs()) {
      throw AudioEncodeFailedException("could not create ${parent.absolutePath}")
    }
    when (path.substringAfterLast('.', "").lowercase()) {
      // Matches the Apple SDK's rule: the extension picks the encoding, and an
      // unrecognized one writes WAV.
      "m4a", "mp4", "aac" -> encodeAac(channels, sampleRate, path)
      else -> encodeWav(channels, sampleRate, path)
    }
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
              deinterleave(pcmToFloat(data, bitsPerSample, isFloat), channelCount),
              sampleRate.toDouble(),
            )
          }
          else -> raf.seek(raf.filePointer + size + (size and 1))
        }
      }
      throw AudioDecodeFailedException("${file.name} has no data chunk")
    }
  }

  private fun encodeWav(channels: List<FloatArray>, sampleRate: Double, path: String) {
    val channelCount = channels.size
    val frames = channels.firstOrNull()?.size ?: 0
    val dataBytes = frames * channelCount * 2
    val out = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN)
    out.put("RIFF".toByteArray()).putInt(36 + dataBytes).put("WAVE".toByteArray())
    out.put("fmt ".toByteArray()).putInt(16)
    out.putShort(1).putShort(channelCount.toShort())
    out.putInt(sampleRate.toInt())
    out.putInt(sampleRate.toInt() * channelCount * 2)
    out.putShort((channelCount * 2).toShort()).putShort(16)
    out.put("data".toByteArray()).putInt(dataBytes)
    for (frame in 0 until frames) {
      for (channel in channels) {
        out.putShort(toPcm16(channel[frame]))
      }
    }
    try {
      File(path).writeBytes(out.array())
    } catch (e: Exception) {
      throw AudioEncodeFailedException("${e.javaClass.simpleName}: ${e.message}")
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
      return Decoded(deinterleave(interleaved, channelCount), sampleRate.toDouble())
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

  private fun encodeAac(channels: List<FloatArray>, sampleRate: Double, path: String) {
    val channelCount = channels.size
    val frames = channels.firstOrNull()?.size ?: 0
    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate.toInt(), channelCount).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, if (channelCount > 1) 192_000 else 128_000)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, MAX_AAC_INPUT)
    }
    var codec: MediaCodec? = null
    var muxer: MediaMuxer? = null
    var muxerStarted = false
    try {
      codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start()
      muxer = MediaMuxer(path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      var track = -1
      val info = MediaCodec.BufferInfo()
      var frame = 0
      var sawInputEnd = false
      var sawOutputEnd = false

      while (!sawOutputEnd) {
        if (!sawInputEnd) {
          val index = codec.dequeueInputBuffer(TIMEOUT_US)
          if (index >= 0) {
            val buffer = codec.getInputBuffer(index)!!
            buffer.clear()
            val capacityFrames = buffer.capacity() / (2 * channelCount)
            val take = minOf(capacityFrames, frames - frame)
            if (take <= 0) {
              codec.queueInputBuffer(index, 0, 0, presentationUs(frame, sampleRate), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              sawInputEnd = true
            } else {
              val shorts = buffer.order(ByteOrder.nativeOrder()).asShortBuffer()
              for (i in 0 until take) {
                for (channel in channels) shorts.put(toPcm16(channel[frame + i]))
              }
              codec.queueInputBuffer(index, 0, take * 2 * channelCount, presentationUs(frame, sampleRate), 0)
              frame += take
            }
          }
        }
        when (val index = codec.dequeueOutputBuffer(info, TIMEOUT_US)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            track = muxer.addTrack(codec.outputFormat)
            muxer.start()
            muxerStarted = true
          }
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          else -> if (index >= 0) {
            val buffer = codec.getOutputBuffer(index)!!
            val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
            if (info.size > 0 && !isConfig && muxerStarted) {
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              muxer.writeSampleData(track, buffer, info)
            }
            codec.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEnd = true
          }
        }
      }
    } catch (e: Exception) {
      throw AudioEncodeFailedException("${e.javaClass.simpleName}: ${e.message}")
    } finally {
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
      if (muxerStarted) runCatching { muxer?.stop() }
      runCatching { muxer?.release() }
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

  private fun deinterleave(interleaved: FloatArray, channelCount: Int): List<FloatArray> {
    if (channelCount == 1) return listOf(interleaved)
    val frames = interleaved.size / channelCount
    return List(channelCount) { channel ->
      FloatArray(frames) { frame -> interleaved[frame * channelCount + channel] }
    }
  }

  private fun toPcm16(sample: Float): Short {
    val clamped = sample.coerceIn(-1f, 1f)
    return (clamped * 32767f).toInt().toShort()
  }

  private fun presentationUs(frame: Int, sampleRate: Double) =
    (frame * 1_000_000L / sampleRate).toLong()

  private const val TIMEOUT_US = 10_000L
  private const val MAX_AAC_INPUT = 32 * 1024
}
