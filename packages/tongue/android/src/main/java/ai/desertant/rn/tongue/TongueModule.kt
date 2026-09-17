package ai.desertant.rn.tongue

import ai.desertant.tongue.Normalizer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of `@desert-ant-labs/react-native-tongue`, written in the
 * classic Expo Modules DSL.
 *
 * The Apple half (ios/TongueModule.swift) uses the Expo Modules 2.0 macros
 * instead, because 2.0 has no Kotlin implementation yet. The two are held to the
 * same JavaScript surface by src/native.ts, which is the contract: same function
 * names, same option keys, same property names, same field names on the way
 * back.
 *
 * Tongue is the fourth model here with an Android half, after Clear, Emo and Ear
 * -- and the first whose Android half carries no asterisk. Those three bind
 * LiteRT, so `isSupported` off Apple is a statement about the device's ABI.
 * `ai.desertant:tongue` is a pure Kotlin jar with no native library at all, so
 * there is no ABI to check, no `abiFilters` for the config plugin to narrow, and
 * `isSupported` is simply true wherever the module is present.
 *
 * `Events` is absent for the same kind of reason: a Tongue emits nothing. There
 * is no download to report and `detect` takes no handler on either platform, so
 * no shared object here has an event to attach a listener to.
 */
class TongueModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntTongue")

    Property("isSupported") { true }
    Property("unsupportedReason") { "" }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }
    Property("modelRevision") { MODEL_REVISION }
    Property("modelRepo") { MODEL_REPO }
    Property("defaultTopK") { DEFAULT_TOP_K }
    Property("tieMargin") { TIE_MARGIN }
    // Public on both platforms, so this is read rather than duplicated.
    Property("maxCharacters") { Normalizer.MAX_CHARACTERS }

    /**
     * Apple only, and this is the refusal.
     *
     * Swift exposes `Script` as a public `CaseIterable` enum; here `Router` and
     * `ScriptTables` are `internal`, and the jar's whole public surface is
     * `Tongue`, `Detection`, `Prediction`, `Route`, `Reliability` and `Verdict`.
     * The choices were to hardcode the 32 names or to say plainly that this
     * platform cannot answer. A hardcoded list would be right until the next
     * model revision and then quietly wrong, which is the worse failure.
     *
     * Empty rather than throwing, because a property that throws is a property a
     * caller cannot safely read while rendering. `Tongue.supportedScripts()` in
     * TypeScript turns the empty list into `ERR_UNSUPPORTED_PLATFORM` with a
     * sentence, which is where a caller can actually catch it.
     *
     * Note that `detection.route.script` still works here. It is the catalogue
     * that is missing, not the field.
     */
    Property("scripts") { emptyList<String>() }

    // MARK: - Construction

    Function("createModel") {
      val context = appContext.reactContext
        ?: throw UnsupportedPlatformException("no Android context is available")
      // `applicationContext`, not the activity's: the model outlives a screen,
      // and the usage turnstile wants a context that outlives the process's
      // foreground.
      TongueModelObject(context.applicationContext)
    }

    // MARK: - Work

    /**
     * The only asynchronous function in this module, and it returns nothing.
     *
     * `Coroutine` so the 2 MB read and widen happen off the JavaScript thread,
     * exactly as the Apple half's `async` does. `load()` itself is `@Synchronized`
     * and idempotent.
     */
    AsyncFunction("load") Coroutine { model: TongueModelObject ->
      model.load()
    }

    /**
     * Synchronous, like the Apple half, and for the same two reasons: a
     * detection is tens of microseconds, and a synchronous return is encoded on
     * the JavaScript thread by construction.
     */
    Function("detect") { model: TongueModelObject, text: String, options: TongueDetectOptions ->
      model.detect(text, options)
    }

    // MARK: - State

    Class(TongueModelObject::class) {
      Function("isLoaded") { model: TongueModelObject -> model.isLoaded() }
      // No `release` here: `SharedObject` already has one, and defining a second
      // would shadow the built-in that actually detaches the native object.
    }
  }

  private companion object {
    /**
     * Kept in lockstep with `DESERT_ANT_CORE_VERSION` in the podspec and the
     * `ai.desertant:tongue` coordinate in build.gradle.
     */
    const val NATIVE_CORE_VERSION = "3.1.0"

    /** `topK = 3` in `detect`'s signature on both platforms. */
    const val DEFAULT_TOP_K = 3

    /**
     * The gap below which `Detection.isTooCloseToCall` is true.
     *
     * Mirrored rather than read, on this platform and on the other: upstream
     * writes `0.12` inline inside `isTooCloseToCall` and names no constant, so
     * there is no symbol to forward. Nothing branches on it -- the flag arrives
     * already decided -- and it is here so the two platforms display the same
     * number.
     */
    const val TIE_MARGIN = 0.12
  }
}
