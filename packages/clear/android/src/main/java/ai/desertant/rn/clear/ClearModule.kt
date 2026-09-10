package ai.desertant.rn.clear

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Float32Array

/**
 * The Android half of `@desert-ant-labs/react-native-clear`, written in the
 * classic Expo Modules DSL.
 *
 * The Apple half (ios/ClearModule.swift) uses the Expo Modules 2.0 macros
 * instead, because 2.0 has no Kotlin implementation yet. The two are held to the
 * same JavaScript surface by src/native.ts, which is the contract: same function
 * names, same event name, same option keys.
 *
 * That surface puts construction and all asynchronous work on the *module* and
 * leaves only state on the shared objects. On Apple that is forced -- the 2.0
 * macros cannot bind an `async` member onto a shared object's prototype, and a
 * `@JS init` cannot throw. Kotlin could do either, but matching the shape here
 * is what keeps one TypeScript file honest about both platforms.
 */
class ClearModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntClear")

    Property("isSupported") { isSupportedAbi() }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }

    // MARK: - Construction

    Function("createModel") { options: ClearLoadOptions ->
      val context = appContext.reactContext
        ?: throw UnsupportedPlatformException("no Android context is available")
      if (!isSupportedAbi()) {
        throw UnsupportedPlatformException(
          "Clear ships arm64-v8a and x86_64 only; this device reports " +
            Build.SUPPORTED_ABIS.joinToString()
        )
      }
      ClearModelObject.requireSupportedVariant(options.variant)
      ClearModelObject(context, options)
    }

    Function("createAudio") { channelCount: Int, frameCount: Int, sampleRate: Double ->
      ClearAudioObject.allocate(channelCount, frameCount, sampleRate)
    }

    // MARK: - Work

    AsyncFunction("download") Coroutine { model: ClearModelObject, jobId: String ->
      model.download(model.progressEmitter(jobId))
    }

    // `ai.desertant:clear` has no separate load step -- the session is built
    // lazily inside the first `enhance` -- so this downloads and stops there.
    // Warming the session itself is Apple-only today.
    AsyncFunction("load") Coroutine { model: ClearModelObject, jobId: String ->
      model.download(model.progressEmitter(jobId))
    }

    AsyncFunction("enhanceFile") Coroutine {
        model: ClearModelObject,
        inputPath: String,
        outputPath: String,
        options: ClearEnhanceOptions,
        jobId: String ->
      model.enhanceFile(inputPath, outputPath, options, model.progressEmitter(jobId))
    }

    AsyncFunction("enhanceBuffer") Coroutine {
        model: ClearModelObject,
        input: ClearAudioObject,
        options: ClearEnhanceOptions,
        jobId: String ->
      model.enhanceBuffer(input, options, model.progressEmitter(jobId))
    }

    // MARK: - State

    Class(ClearModelObject::class) {
      // Matches the Apple side's `@Event var onProgress`, whose JS name is the
      // property name with the leading `on` stripped.
      Events("progress")

      Function("isDownloaded") { model: ClearModelObject -> model.isDownloaded() }
    }

    Class(ClearAudioObject::class) {
      Property("channelCount") { audio: ClearAudioObject -> audio.channelCount }
      Property("frameCount") { audio: ClearAudioObject -> audio.frameCount }
      Property("sampleRate") { audio: ClearAudioObject -> audio.rate }
      Property("metrics") { audio: ClearAudioObject -> audio.metrics }

      // Synchronous on purpose: a typed array is only safe to touch on the JS
      // thread, so the copy happens here and the model work happens elsewhere.
      Function("write") { audio: ClearAudioObject, channel: Int, data: Float32Array ->
        audio.write(channel, data)
      }
      Function("read") { audio: ClearAudioObject, channel: Int, into: Float32Array ->
        audio.read(channel, into)
      }
      // No `release` here: `SharedObject` already has one, and defining a second
      // would shadow the built-in that actually detaches the native object.
    }
  }

  private companion object {
    /**
     * Kept in lockstep with `DESERT_ANT_CORE_VERSION` in the podspec and the
     * `ai.desertant:clear` coordinate in build.gradle.
     */
    const val NATIVE_CORE_VERSION = "3.1.0"

    fun isSupportedAbi(): Boolean =
      Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }
  }
}

/**
 * Progress goes out on the shared object itself, so a listener attached to one
 * model never sees another's ticks.
 */
internal fun ClearModelObject.progressEmitter(jobId: String): (String, Double) -> Unit =
  { phase, fraction ->
    emit("progress", mapOf("jobId" to jobId, "phase" to phase, "fraction" to fraction))
  }
