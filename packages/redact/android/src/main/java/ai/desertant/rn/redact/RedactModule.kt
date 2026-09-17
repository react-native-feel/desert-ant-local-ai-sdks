package ai.desertant.rn.redact

import ai.desertant.redact.Labels
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of `@desert-ant-labs/react-native-redact`, written in the
 * classic Expo Modules DSL.
 *
 * The Apple half (ios/RedactModule.swift) uses the Expo Modules 2.0 macros
 * instead, because 2.0 has no Kotlin implementation yet. The two are held to the
 * same JavaScript surface by src/native.ts, which is the contract: same function
 * names, same event name, same option keys, same property names.
 *
 * That surface puts construction and all asynchronous work on the *module* and
 * leaves only state on the shared objects. On Apple that is forced -- the 2.0
 * macros cannot bind an `async` member onto a shared object's prototype, and a
 * `@JS init` cannot throw. Kotlin could do either, but matching the shape here is
 * what keeps one TypeScript file honest about both platforms.
 *
 * The same goes for `redaction` returning nothing and the result coming back off
 * `takeRedaction`. Kotlin has no encode-on-the-wrong-thread hazard to design
 * around; it holds the result anyway so that the TypeScript above it is one
 * implementation rather than two.
 */
class RedactModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntRedact")

    Property("isSupported") { isSupportedAbi() }
    Property("unsupportedReason") {
      if (isSupportedAbi()) "" else unsupportedAbiReason()
    }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }
    Property("modelRevision") { MODEL_REVISION }
    Property("modelRepo") { MODEL_REPO }

    /**
     * Read off `Labels.ALL` rather than restated, so a category upstream adds
     * appears here without a change. `Labels.ALL` is declared as an ordered
     * `setOf(...)` in the same order as the Swift enum's cases, so
     * `Redact.labels` reports one list on both platforms.
     */
    Property("labels") { Labels.ALL.toList() }

    /** `Labels.DEFAULT` is `ALL - "ORG"`, so filtering `ALL` preserves the
     *  order the Apple half reports. */
    Property("defaultLabels") { Labels.ALL.filter { Labels.DEFAULT.contains(it) } }

    /**
     * Empty, where the Apple half reports all twenty-two.
     *
     * `Label.displayName` is a Swift computed property; `ai.desertant:redact`
     * publishes no equivalent -- its whole `Labels` object is two sets of bare
     * strings. Reporting the truth here is what lets a privacy UI gate on
     * `Redact.labelDisplayNames` and fall back to the label itself, and what
     * makes `Redact.displayName`'s refusal legible when it happens. Deriving one
     * from the slug was the alternative and is worse: upstream's own names
     * include "IMEI", "SSN", "Organisation" and "IP address", none of which
     * title-casing produces.
     */
    Property("labelDisplayNames") { emptyMap<String, String>() }

    Property("defaultMinimumConfidence") { DEFAULT_MINIMUM_CONFIDENCE }

    // MARK: - Construction

    Function("createModel") { options: RedactLoadOptions ->
      val context = appContext.reactContext
        ?: throw UnsupportedPlatformException("no Android context is available")
      if (!isSupportedAbi()) {
        throw UnsupportedPlatformException(unsupportedAbiReason())
      }
      RedactModelObject(context, options)
    }

    // MARK: - Work

    AsyncFunction("load") Coroutine { model: RedactModelObject, jobId: String ->
      model.load(model.progressEmitter(jobId))
    }

    AsyncFunction("redaction") Coroutine {
        model: RedactModelObject,
        text: String,
        options: RedactRedactionOptions,
        jobId: String ->
      model.redaction(text, options, jobId, model.progressEmitter(jobId))
    }

    // MARK: - State

    Class(RedactModelObject::class) {
      // Matches the Apple side's `@Event var onProgress`, whose JS name is the
      // property name with the leading `on` stripped.
      Events("progress")

      Function("isDownloaded") { model: RedactModelObject -> model.isDownloaded() }
      Function("takeRedaction") { model: RedactModelObject, jobId: String ->
        model.takeRedaction(jobId)
      }
      // No `release` here: `SharedObject` already has one, and defining a second
      // would shadow the built-in that actually detaches the native object.
    }
  }

  private companion object {
    /**
     * Kept in lockstep with `DESERT_ANT_CORE_VERSION` in
     * packages/core/ios/DesertAntCore.podspec and the `ai.desertant:redact`
     * coordinate in build.gradle.
     */
    const val NATIVE_CORE_VERSION = "3.1.0"

    /**
     * `RedactModel.revision` and `RedactModel.repo` on the Apple side, which read
     * the catalog. The Kotlin SDK exposes neither, so they are constants here,
     * pinned to the SDK version above: revision `v0.4.0` is what
     * `ai.desertant:redact:3.1.0` resolves.
     */
    const val MODEL_REVISION = "v0.4.0"
    const val MODEL_REPO = "desert-ant-labs/redact"

    /** `minimumConfidence: Double = 0.6` in `Options`. A default argument rather
     *  than a constant on either platform, so it is mirrored on both. */
    const val DEFAULT_MINIMUM_CONFIDENCE = 0.6

    /**
     * LiteRT ships `arm64-v8a` and `x86_64` only, so a device reporting neither
     * has no `.so` to load -- `ai.desertant:redact` binds the shared native core
     * through JNI and `RedactNative.ensureLoaded()` loads `libRedactAndroid.so`.
     * The bundled config plugin narrows the app's `abiFilters` to match; this is
     * the runtime answer for anything that got through anyway.
     */
    fun isSupportedAbi(): Boolean =
      Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }

    fun unsupportedAbiReason(): String =
      "Redact ships arm64-v8a and x86_64 only; this device reports " +
        Build.SUPPORTED_ABIS.joinToString()
  }
}

/**
 * Progress goes out on the shared object itself, so a listener attached to one
 * model never sees another's ticks.
 */
internal fun RedactModelObject.progressEmitter(jobId: String): (String, Double) -> Unit =
  { phase, fraction ->
    emit("progress", mapOf("jobId" to jobId, "phase" to phase, "fraction" to fraction))
  }
