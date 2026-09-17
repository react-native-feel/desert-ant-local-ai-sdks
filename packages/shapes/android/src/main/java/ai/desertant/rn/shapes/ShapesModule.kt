package ai.desertant.rn.shapes

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of `@desert-ant-labs/react-native-shapes`, written in the
 * classic Expo Modules DSL.
 *
 * The Apple half (ios/ShapesModule.swift) uses the Expo Modules 2.0 macros
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
 * The same goes for `recognize` returning nothing and the result coming back off
 * `takeRecognition`. Kotlin has no encode-on-the-wrong-thread hazard to design
 * around; it holds the result anyway so that the TypeScript above it is one
 * implementation rather than two.
 *
 * **Never compiled.** See the note on `ShapesModelObject` and the README.
 */
class ShapesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntShapes")

    Property("isSupported") { isSupportedAbi() }
    Property("unsupportedReason") {
      if (isSupportedAbi()) "" else unsupportedAbiReason()
    }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }
    Property("modelRevision") { MODEL_REVISION }
    Property("modelRepo") { MODEL_REPO }
    Property("defaultMinimumConfidence") { DEFAULT_MINIMUM_CONFIDENCE }

    // No `kinds` property here, and none on the Apple half either. Every other
    // model in this family reads its vocabulary off the binary; this one cannot,
    // because neither SDK publishes an enumerable list of shape classes --
    // `ShapeKind` is internal in Swift and Kotlin's `Shape` is a sealed class.
    // Reporting a hardcoded list from here would look like it was read off the
    // binary while being exactly as stale as the TypeScript union, so the list
    // lives in TypeScript where its provenance is visible. See src/types.ts.

    // MARK: - Construction

    Function("createModel") { options: ShapesLoadOptions ->
      val context = appContext.reactContext
        ?: throw UnsupportedPlatformException("no Android context is available")
      if (!isSupportedAbi()) {
        throw UnsupportedPlatformException(unsupportedAbiReason())
      }
      ShapesModelObject(context, options)
    }

    // MARK: - Work

    AsyncFunction("load") Coroutine { model: ShapesModelObject, jobId: String ->
      model.load(model.progressEmitter(jobId))
    }

    AsyncFunction("recognize") Coroutine {
        model: ShapesModelObject,
        coordinates: DoubleArray,
        options: ShapesRecognizeOptions,
        jobId: String ->
      model.recognize(coordinates, options, jobId, model.progressEmitter(jobId))
    }

    // MARK: - State

    Class(ShapesModelObject::class) {
      // Matches the Apple side's `@Event var onProgress`, whose JS name is the
      // property name with the leading `on` stripped.
      Events("progress")

      Function("isDownloaded") { model: ShapesModelObject -> model.isDownloaded() }
      Function("takeRecognition") { model: ShapesModelObject, jobId: String ->
        model.takeRecognition(jobId)
      }
      // No `release` here: `SharedObject` already has one, and defining a second
      // would shadow the built-in that actually detaches the native object.
    }
  }

  private companion object {
    /**
     * Kept in lockstep with `DESERT_ANT_CORE_VERSION` in
     * packages/core/ios/DesertAntCore.podspec and the `ai.desertant:shapes`
     * coordinate in build.gradle.
     */
    const val NATIVE_CORE_VERSION = "3.1.0"

    /**
     * `ShapesModel.revision` and `ShapesModel.repo` on the Apple side, which read
     * the catalog. The Kotlin SDK exposes neither, so they are constants here,
     * pinned to the SDK version above: revision `v0.3.0` is what
     * `ai.desertant:shapes:3.1.0` resolves.
     */
    const val MODEL_REVISION = "v0.3.0"
    const val MODEL_REPO = "desert-ant-labs/shapes"

    /** `minimumConfidence: Double = 0.0` in `Options`. A default argument rather
     *  than a constant on either platform, so it is mirrored on both. */
    const val DEFAULT_MINIMUM_CONFIDENCE = 0.0

    /**
     * LiteRT ships `arm64-v8a` and `x86_64` only, so a device reporting neither
     * has no `.so` to load -- `ai.desertant:shapes` binds the shared native core
     * through JNI and `ShapesNative.ensureLoaded()` loads `libShapesAndroid.so`.
     * The bundled config plugin narrows the app's `abiFilters` to match; this is
     * the runtime answer for anything that got through anyway.
     */
    fun isSupportedAbi(): Boolean =
      Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }

    fun unsupportedAbiReason(): String =
      "Shapes ships arm64-v8a and x86_64 only; this device reports " +
        Build.SUPPORTED_ABIS.joinToString()
  }
}

/**
 * Progress goes out on the shared object itself, so a listener attached to one
 * model never sees another's ticks.
 */
internal fun ShapesModelObject.progressEmitter(jobId: String): (String, Double) -> Unit =
  { phase, fraction ->
    emit("progress", mapOf("jobId" to jobId, "phase" to phase, "fraction" to fraction))
  }
