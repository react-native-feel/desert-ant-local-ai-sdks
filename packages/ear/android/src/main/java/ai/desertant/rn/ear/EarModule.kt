package ai.desertant.rn.ear

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of `@desert-ant-labs/react-native-ear`, written in the classic
 * Expo Modules DSL.
 *
 * The Apple half (ios/EarModule.swift) uses the Expo Modules 2.0 macros instead,
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
 * Ear is the third model in this repo with an Android half, after Clear and Emo:
 * `desert-ant-core` publishes a LiteRT export of it and `ai.desertant:ear` is on
 * Maven Central. Voz, Clips and Uhm have no Android build to bind to.
 */
class EarModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntEar")

    Property("isSupported") { isSupportedAbi() }
    Property("unsupportedReason") {
      if (isSupportedAbi()) "" else unsupportedAbiReason()
    }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }
    Property("modelRevision") { MODEL_REVISION }
    Property("modelRepo") { MODEL_REPO }
    Property("defaultWindows") { DEFAULT_WINDOWS }
    Property("reliableMargin") { RELIABLE_MARGIN }

    // MARK: - Construction

    Function("createModel") { options: EarLoadOptions ->
      val context = appContext.reactContext
        ?: throw UnsupportedPlatformException("no Android context is available")
      if (!isSupportedAbi()) {
        throw UnsupportedPlatformException(unsupportedAbiReason())
      }
      EarModelObject(context, options)
    }

    // MARK: - Work

    AsyncFunction("load") Coroutine { model: EarModelObject, jobId: String ->
      model.load(model.progressEmitter(jobId))
    }

    AsyncFunction("identifyFile") Coroutine {
        model: EarModelObject,
        path: String,
        options: EarIdentifyOptions,
        jobId: String ->
      model.identifyFile(path, options, model.progressEmitter(jobId))
    }

    AsyncFunction("identifySamples") Coroutine {
        model: EarModelObject,
        samples: FloatArray,
        sampleRate: Double,
        options: EarIdentifyOptions,
        jobId: String ->
      model.identifySamples(samples, sampleRate, options, model.progressEmitter(jobId))
    }

    /**
     * Apple only, and this is the refusal.
     *
     * The Swift half reads the `languages.json` sidecar through the loaded model.
     * `ai.desertant:ear` publishes `Ear`, `Detection`, `LanguageCandidate` and
     * `Options`, and nothing that reads it -- so the choices here were to return
     * a list this package hardcoded, or to say plainly that this platform cannot
     * answer. A hardcoded list would be right until the next model revision and
     * then quietly wrong, which is the worse failure: a caller would have no way
     * to tell.
     */
    AsyncFunction("loadLanguages") Coroutine { _: EarModelObject, _: String ->
      throw UnsupportedPlatformException(LANGUAGES_UNAVAILABLE)
    }

    // MARK: - State

    Class(EarModelObject::class) {
      // Matches the Apple side's `@Event var onProgress`, whose JS name is the
      // property name with the leading `on` stripped.
      Events("progress")

      Function("isDownloaded") { model: EarModelObject -> model.isDownloaded() }
      // The Apple half reads its cached list here. This one never gets the
      // chance -- `loadLanguages` above refuses first -- but it is defined so the
      // shape of the shared object matches src/native.ts on both platforms, and
      // so a caller reaching it directly gets the same coded refusal.
      Function("languages") { _: EarModelObject ->
        throw UnsupportedPlatformException(LANGUAGES_UNAVAILABLE)
      }
      // No `release` here: `SharedObject` already has one, and defining a second
      // would shadow the built-in that actually detaches the native object.
    }
  }

  private companion object {
    /**
     * Kept in lockstep with `DESERT_ANT_CORE_VERSION` in the podspec and the
     * `ai.desertant:ear` coordinate in build.gradle.
     */
    const val NATIVE_CORE_VERSION = "3.1.0"

    /**
     * Why this platform cannot answer.
     *
     * The choices here were to return a list this package hardcoded, or to say
     * plainly that this platform cannot read one. A hardcoded list would be right
     * until the next model revision and then quietly wrong, which is the worse
     * failure: a caller would have no way to tell.
     */
    const val LANGUAGES_UNAVAILABLE =
      "Ear.supportedLanguages() is iOS-only: ai.desertant:ear exposes no reader for the " +
        "model's language list. Gate the call on Platform.OS, or ship the list with your app."

    /**
     * `EarModel.revision` and `EarModel.repo` on the Apple side, which read the
     * catalog. The Kotlin SDK exposes neither, so they are constants here, pinned
     * to the SDK version above: revision `v0.1.0` is what `ai.desertant:ear:3.1.0`
     * resolves.
     */
    const val MODEL_REVISION = "v0.1.0"
    const val MODEL_REPO = "desert-ant-labs/ear"

    /** `Options.windows = 3` in the Kotlin SDK; `Ear.defaultWindows` in Swift,
     *  where the Apple half reads it rather than declaring it. */
    const val DEFAULT_WINDOWS = 3

    /**
     * `Detection.reliableMargin` upstream. Swift exposes it as a public static
     * and the Apple half reads it; the Kotlin `Detection` takes `isReliable` from
     * the native core and never names the margin, so it is a constant here.
     *
     * Nothing on this side branches on it -- `isReliable` arrives already
     * decided. It is forwarded so the two platforms can display the same number.
     */
    const val RELIABLE_MARGIN = 0.25

    /**
     * LiteRT ships `arm64-v8a` and `x86_64` only, so a device reporting neither
     * has no `.so` to load. The bundled config plugin narrows the app's
     * `abiFilters` to match; this is the runtime answer for anything that got
     * through anyway.
     */
    fun isSupportedAbi(): Boolean =
      Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }

    fun unsupportedAbiReason(): String =
      "Ear ships arm64-v8a and x86_64 only; this device reports " +
        Build.SUPPORTED_ABIS.joinToString()
  }
}

/**
 * Progress goes out on the shared object itself, so a listener attached to one
 * model never sees another's ticks.
 */
internal fun EarModelObject.progressEmitter(jobId: String): (String, Double) -> Unit =
  { phase, fraction ->
    emit("progress", mapOf("jobId" to jobId, "phase" to phase, "fraction" to fraction))
  }
