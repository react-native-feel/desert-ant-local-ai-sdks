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
 * instead, because 2.0 has no Kotlin implementation yet -- expo-modules-core 57
 * ships `@JS`/`@ExpoModule`/`@SharedObject` for Swift only. The two halves are
 * held to the same JavaScript surface by src/types.ts, which is the contract:
 * same class names, same method names, same event name, same option keys. When
 * the Kotlin macros land, this file changes and nothing above it does.
 */
class ClearModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntClear")

    Property("isSupported") { isSupportedAbi() }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }

    Class(ClearAudioObject::class) {
      Constructor { channelCount: Int, frameCount: Int, sampleRate: Double ->
        ClearAudioObject.allocate(channelCount, frameCount, sampleRate)
      }

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

    Class(ClearModelObject::class) {
      Constructor { options: ClearLoadOptions ->
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

      // Matches the Apple side's `@Event var onProgress`, whose JS name is the
      // property name with the leading `on` stripped.
      Events("progress")

      Function("isDownloaded") { model: ClearModelObject -> model.isDownloaded() }

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
