package ai.desertant.rn.gist

import ai.desertant.gist.PostTopics
import ai.desertant.gist.RollupOptions
import ai.desertant.gist.channelTopics
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of `@desert-ant-labs/react-native-gist`, written in the
 * classic Expo Modules DSL.
 *
 * The Apple half (ios/GistModule.swift) uses the Expo Modules 2.0 macros instead,
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
 * The same goes for `classify` and `scores` returning nothing and the results
 * coming back off `takeTagging`/`takeDistribution`. Kotlin has no encode-on-the
 * -wrong-thread hazard to design around; it holds results anyway so that the
 * TypeScript above it is one implementation rather than two.
 *
 * Gist is the fourth model in this repo with a working Android half, after Clear,
 * Emo and Ear: `desert-ant-core` publishes a LiteRT export of it and
 * `ai.desertant:gist` is on Maven Central. Voz, Clips and Uhm have no Android
 * build to bind to.
 */
class GistModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DesertAntGist")

    Property("isSupported") { isSupportedAbi() }
    Property("unsupportedReason") {
      if (isSupportedAbi()) "" else unsupportedAbiReason()
    }
    Property("nativeCoreVersion") { NATIVE_CORE_VERSION }
    Property("modelRevision") { MODEL_REVISION }
    Property("modelRepo") { MODEL_REPO }
    Property("defaultTopK") { DEFAULT_TOP_K }

    /**
     * One entry, where the Apple half reports two.
     *
     * The Swift SDK's `Gist(variant:directory:)` selects between the ~74 MB
     * multilingual build and the ~15 MB English one; `ai.desertant:gist`'s whole
     * constructor is `Gist(context, directory)`, and its own KDoc says so: "The
     * English-only model build is currently selectable from the Swift SDK only."
     * Reporting the truth here is what lets a variant picker be gated on this
     * list rather than on `Platform.OS`, and what makes the refusal in
     * `GistLoadOptions` legible when it happens.
     */
    Property("variants") { listOf(GistLoadOptions.MULTILINGUAL) }
    Property("defaultVariant") { GistLoadOptions.MULTILINGUAL }

    /**
     * `RollupOptions()`'s own defaults, read off the data class rather than
     * restated, so this platform and Apple cannot show different numbers for a
     * roll-up neither of them decides.
     */
    Property("defaultRollupOptions") {
      val defaults = RollupOptions()
      mapOf(
        "topN" to defaults.topN.toDouble(),
        "floor" to defaults.floor,
        "minPosts" to defaults.minPosts.toDouble(),
        "halfLifeDays" to defaults.halfLifeDays,
        "touch" to defaults.touch,
        "nowMillis" to defaults.nowMillis,
      )
    }

    // MARK: - Construction

    Function("createModel") { options: GistLoadOptions ->
      val context = appContext.reactContext
        ?: throw UnsupportedPlatformException("no Android context is available")
      if (!isSupportedAbi()) {
        throw UnsupportedPlatformException(unsupportedAbiReason())
      }
      GistModelObject(context, options)
    }

    // MARK: - Work

    AsyncFunction("load") Coroutine { model: GistModelObject, jobId: String ->
      model.load(model.progressEmitter(jobId))
    }

    AsyncFunction("classify") Coroutine {
        model: GistModelObject,
        text: String,
        options: GistClassifyOptions,
        jobId: String ->
      model.classify(text, options, jobId, model.progressEmitter(jobId))
    }

    AsyncFunction("scores") Coroutine { model: GistModelObject, text: String, jobId: String ->
      model.scores(text, jobId, model.progressEmitter(jobId))
    }

    /**
     * The roll-up, which needs no model and no download.
     *
     * A synchronous `Function` rather than an `AsyncFunction` because it is pure
     * arithmetic over a few hundred numbers, and because the Apple half is
     * synchronous for a reason that matters there (an async return value can be
     * encoded off the JavaScript thread) and the two surfaces have to match.
     */
    Function("channelTopics") { posts: List<GistPostTopics>, options: GistRollupOptions ->
      val rolled = channelTopics(
        posts.map { post ->
          PostTopics(
            topics = post.topics.associate { it.slug to it.score },
            // `0` is the wire's "no timestamp": upstream's null means the post is
            // never decayed, which is what a caller who sent none meant.
            timestampMillis = if (post.timestampMillis == 0.0) null else post.timestampMillis,
          )
        },
        RollupOptions(
          topN = options.topN,
          floor = options.floor,
          minPosts = options.minPosts,
          halfLifeDays = options.halfLifeDays,
          touch = options.touch,
          nowMillis = options.nowMillis,
        ),
      )
      rolled.map { mapOf("slug" to it.slug, "share" to it.share, "postCount" to it.postCount) }
    }

    // MARK: - State

    Class(GistModelObject::class) {
      // Matches the Apple side's `@Event var onProgress`, whose JS name is the
      // property name with the leading `on` stripped.
      Events("progress")

      Function("isDownloaded") { model: GistModelObject -> model.isDownloaded() }
      Function("takeTagging") { model: GistModelObject, jobId: String -> model.takeTagging(jobId) }
      Function("takeDistribution") { model: GistModelObject, jobId: String ->
        model.takeDistribution(jobId)
      }
      // No `release` here: `SharedObject` already has one, and defining a second
      // would shadow the built-in that actually detaches the native object.
    }
  }

  private companion object {
    /**
     * Kept in lockstep with `DESERT_ANT_CORE_VERSION` in the podspec and the
     * `ai.desertant:gist` coordinate in build.gradle.
     */
    const val NATIVE_CORE_VERSION = "3.1.0"

    /**
     * `GistModel.revision` and `GistModel.repo` on the Apple side, which read the
     * catalog. The Kotlin SDK exposes neither, so they are constants here, pinned
     * to the SDK version above: revision `v2.2.0` is what `ai.desertant:gist:3.1.0`
     * resolves.
     */
    const val MODEL_REVISION = "v2.2.0"
    const val MODEL_REPO = "desert-ant-labs/gist"

    /** `topK: Int = 3` in `Gist.classify`. A default argument rather than a
     *  constant on either platform, so it is mirrored on both. */
    const val DEFAULT_TOP_K = 3

    /**
     * LiteRT ships `arm64-v8a` and `x86_64` only, so a device reporting neither
     * has no `.so` to load. The bundled config plugin narrows the app's
     * `abiFilters` to match; this is the runtime answer for anything that got
     * through anyway.
     */
    fun isSupportedAbi(): Boolean =
      Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "x86_64" }

    fun unsupportedAbiReason(): String =
      "Gist ships arm64-v8a and x86_64 only; this device reports " +
        Build.SUPPORTED_ABIS.joinToString()
  }
}

/**
 * Progress goes out on the shared object itself, so a listener attached to one
 * model never sees another's ticks.
 */
internal fun GistModelObject.progressEmitter(jobId: String): (String, Double) -> Unit =
  { phase, fraction ->
    emit("progress", mapOf("jobId" to jobId, "phase" to phase, "fraction" to fraction))
  }
