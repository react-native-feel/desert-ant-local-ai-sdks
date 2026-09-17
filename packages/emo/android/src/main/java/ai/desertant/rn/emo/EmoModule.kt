package ai.desertant.rn.emo

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of `@desert-ant-labs/react-native-emo`, written in the classic
 * Expo Modules DSL.
 *
 * The Apple half (ios/EmoModule.swift) uses the Expo Modules 2.0 macros instead,
 * because 2.0 has no Kotlin implementation yet. The two are held to the same
 * JavaScript surface by src/native.ts, which is the contract: same function
 * names, same event name, same option keys, same property names.
 *
 * That surface puts construction and all asynchronous work on the *module* and
 * leaves only state on the shared objects. On Apple that is forced -- the 2.0
 * macros cannot bind an `async` member onto a shared object's prototype, and a
 * `@JS init` cannot throw. Kotlin could do either, but matching the shape here is
 * what keeps one TypeScript file honest about both platforms.
 *
 * Emo is the second model in this repo with an Android half at all, after Clear:
 * `desert-ant-core` publishes a LiteRT export of it and `ai.desertant:emo` is on
 * Maven Central. Voz, Clips and Uhm have no Android build to bind to.
 */
class EmoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntEmo")

    Property("isSupported") { isSupportedAbi() }
    Property("unsupportedReason") {
      if (isSupportedAbi()) "" else unsupportedAbiReason()
    }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }
    Property("modelRevision") { MODEL_REVISION }
    Property("modelRepo") { MODEL_REPO }
    Property("skinTones") { SKIN_TONE_NAMES }
    Property("defaultLimit") { DEFAULT_LIMIT }

    // MARK: - Construction

    Function("createModel") { options: EmoLoadOptions ->
      val context = appContext.reactContext
        ?: throw UnsupportedPlatformException("no Android context is available")
      if (!isSupportedAbi()) {
        throw UnsupportedPlatformException(unsupportedAbiReason())
      }
      EmoModelObject(context, options)
    }

    // MARK: - Work

    AsyncFunction("load") Coroutine { model: EmoModelObject, jobId: String ->
      model.load(model.progressEmitter(jobId))
    }

    AsyncFunction("suggest") Coroutine {
        model: EmoModelObject,
        text: String,
        options: EmoSuggestOptions,
        jobId: String ->
      model.suggest(text, options, model.progressEmitter(jobId))
    }

    // MARK: - State

    Class(EmoModelObject::class) {
      // Matches the Apple side's `@Event var onProgress`, whose JS name is the
      // property name with the leading `on` stripped.
      Events("progress")

      Function("isDownloaded") { model: EmoModelObject -> model.isDownloaded() }
      // No `release` here: `SharedObject` already has one, and defining a second
      // would shadow the built-in that actually detaches the native object.
    }
  }

  private companion object {
    /**
     * Kept in lockstep with `DESERT_ANT_CORE_VERSION` in the podspec and the
     * `ai.desertant:emo` coordinate in build.gradle.
     */
    const val NATIVE_CORE_VERSION = "3.1.0"

    /**
     * `EmoModel.revision` and `EmoModel.repo` on the Apple side, which read the
     * catalog. The Kotlin SDK exposes neither -- `ai.desertant:emo` publishes
     * `Emo`, `EmoSuggestion`, `EmojiSkinTone` and nothing else -- so they are
     * constants here, and they are pinned to the SDK version above: revision
     * `v0.7.0` is what `ai.desertant:emo:3.1.0` resolves.
     */
    const val MODEL_REVISION = "v0.7.0"
    const val MODEL_REPO = "desert-ant-labs/emo"

    /** The order `EmojiSkinTone` declares, and the wire spelling `Records.kt`
     *  decodes. Matches `EmoSuggestOptions.skinToneNames` on the Apple side. */
    val SKIN_TONE_NAMES = listOf(
      "default", "light", "mediumLight", "medium", "mediumDark", "dark"
    )

    /** `limit: Int = 3` in `Emo.suggestions`. */
    const val DEFAULT_LIMIT = 3

    /**
     * LiteRT ships `arm64-v8a` and `x86_64` only, so a device reporting neither
     * has no `.so` to load. The bundled config plugin narrows the app's
     * `abiFilters` to match; this is the runtime answer for anything that got
     * through anyway.
     */
    fun isSupportedAbi(): Boolean =
      Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }

    fun unsupportedAbiReason(): String =
      "Emo ships arm64-v8a and x86_64 only; this device reports " +
        Build.SUPPORTED_ABIS.joinToString()
  }
}

/**
 * Progress goes out on the shared object itself, so a listener attached to one
 * model never sees another's ticks.
 */
internal fun EmoModelObject.progressEmitter(jobId: String): (String, Double) -> Unit =
  { phase, fraction ->
    emit("progress", mapOf("jobId" to jobId, "phase" to phase, "fraction" to fraction))
  }
