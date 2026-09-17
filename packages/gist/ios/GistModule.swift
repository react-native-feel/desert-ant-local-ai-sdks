// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other seven model
// packages here arrived at. Two limits, both found by compiling:
//
//   * `@JS async` works on an `@ExpoModule` class but NOT on a `@SharedObject`.
//     The `@SharedObject` macro binds members onto the JS prototype through a
//     synchronous function type, so an async member fails to compile with
//     "cannot pass function of type ... async throws ... to parameter expecting
//     synchronous function type".
//   * A `@JS init` cannot throw: the generated `_constructSharedObject` calls it
//     without `try`. So construction that needs validation is a module function
//     returning the object, not a JS constructor.
//
// Hence `createModel` instead of `new`, and free functions taking the object
// instead of methods on it. `src/Gist.ts` hides all of it.
//
// The third limit -- returning a `SharedObject` from a `@JS async` function kills
// the process -- does not reach this module: nothing here hands a Swift-allocated
// buffer back to JavaScript.
//
// The fourth is the one that shaped this file, and it is bigger than it reads.
// **A `@JS async` function does its last work on the wrong thread.**
// `@JavaScriptActor` is not a hop: `expo-modules-jsi`'s executor runs jobs
// "synchronously without hopping to the proper thread", by its own doc comment,
// so after the first suspension the closure the `@ExpoModule` macro generated
// resumes on `com.apple.root.user-initiated-qos.cooperative` -- and it does two
// things there that touch Hermes. It encodes the return value, and it destroys
// the owning copy of the call's *arguments* that `createAsyncFunction` handed it
// (`JavaScriptValuesBuffer.deinit` -> `~jsi::Value()` per argument).
//
// Hence both halves of the arrangement below. Every `@JS async` function returns
// `Void` and hands its result over through a synchronous `take...`, which takes
// care of the encode; and every one of them lands back on the JavaScript thread
// before returning, through `onJavaScriptThread` at the bottom of this file,
// which takes care of the teardown. Returning `Void` alone does not:
// `ShapesModule.load` crashed in `JavaScriptValuesBuffer.deinit` while returning
// nothing at all. The crash reports, the closure numbering that reads them, and
// what could not be settled are in docs/architecture.md under "Expo Modules 2.0
// limits".

import DesertAnt
import Gist
import ExpoModulesCore
import Foundation

@ExpoModule("DesertAntGist", classes: [GistModelObject.self])
public final class GistModule: Module {
  /// Whether this build can run Gist at all.
  ///
  /// Reads the catalog rather than answering `true`. The Android half answers the
  /// same question about the device's ABI; JavaScript's `Gist.isSupported`
  /// reports `false` by a third route where the module is not there to ask at
  /// all.
  @JS
  var isSupported: Bool { GistModelObject.isSupported }

  /// Why `isSupported` is false, or `""` when it is true.
  ///
  /// Always `""` in practice on Apple -- `GistModel.files` lists `.apple` and the
  /// artifact imposes no floor above the pod's. The property exists because the
  /// Android half genuinely has something to say here, and one TypeScript file
  /// reads both.
  @JS
  var unsupportedReason: String {
    GistModelObject.isSupported
      ? ""
      : "desert-ant-core ships no Gist artifact for this platform"
  }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { GistModelObject.coreVersion }

  /// The pinned model revision this SDK resolves, so a tagging can be traced to
  /// the weights that produced it. Both variants live at this revision --
  /// multilingual at the repo root, English under `en/`.
  @JS
  var modelRevision: String { GistModel.revision }

  /// The Hugging Face repo the weights come from.
  @JS
  var modelRepo: String { GistModel.repo }

  /// How many topics a `classify` returns when the caller does not say.
  ///
  /// Mirrored rather than read, and this is the one constant in this module that
  /// is: `topK` is a default argument in
  /// `Gist.classify(_:topK:threshold:)` rather than a constant the SDK exposes,
  /// so there is nothing to read off. Forwarded anyway so both platforms show one
  /// number -- upstream's "the right topic is in the top three 91% of the time"
  /// is measured at this value.
  @JS
  var defaultTopK: Int { 3 }

  /// Every model build this platform can load, in upstream's own order.
  ///
  /// Read off `GistVariant.allCases` rather than duplicated, so a variant
  /// upstream adds appears here without a change. The Android half reports one
  /// entry, because `ai.desertant:gist`'s constructor takes no variant.
  ///
  /// A property rather than a function: a synchronous getter's `[String]` is
  /// encoded on the JavaScript thread, and an array of bare strings off an async
  /// call is precisely what crashed Ear.
  @JS
  var variants: [String] { GistVariant.allCases.map(\.rawValue) }

  /// `GistVariant.default`: the ~74 MB, 101-language build.
  @JS
  var defaultVariant: String { GistVariant.default.rawValue }

  /// `RollupOptions()`'s own defaults, so a roll-up form can be laid out without
  /// this package restating six numbers upstream owns and is free to retune.
  ///
  /// A `[String: Double]` rather than a record because that is the shape
  /// `Uhm.biasThresholds` already proves encodes from a synchronous property, and
  /// because these six are all numbers.
  @JS
  var defaultRollupOptions: [String: Double] {
    let defaults = RollupOptions()
    return [
      "topN": Double(defaults.topN),
      "floor": defaults.floor,
      "minPosts": Double(defaults.minPosts),
      "halfLifeDays": defaults.halfLifeDays,
      "touch": defaults.touch,
      "nowMillis": defaults.nowMillis,
    ]
  }

  // MARK: - Construction

  @JS
  func createModel(_ options: GistLoadOptions) throws -> GistModelObject {
    guard GistModelObject.isSupported else {
      throw UnsupportedPlatformException("desert-ant-core ships no Gist artifact for this platform")
    }
    return GistModelObject(variant: try options.resolvedVariant(), directory: options.directory)
  }

  // MARK: - Work

  /// Download the weights and build the session.
  ///
  /// ~74 MB for the default build and ~15 MB for the English one, which is why --
  /// unlike Emo, Ear and Tongue -- this is not something an app should do on
  /// mount without asking.
  @JS
  @JavaScriptActor
  func load(_ model: GistModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.load(jobId: jobId)
    }
  }

  /// Tag `text` and hold the result on the shared object under `jobId`.
  ///
  /// Returns nothing on purpose; `takeTagging` hands the record over
  /// synchronously. See `GistModelObject.classify`.
  @JS
  @JavaScriptActor
  func classify(
    _ model: GistModelObject,
    _ text: String,
    _ options: GistClassifyOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.classify(text: text, options: options, jobId: jobId)
    }
  }

  /// The full 36-topic distribution for `text`, held under `jobId`. Same shape,
  /// same reason.
  @JS
  @JavaScriptActor
  func scores(_ model: GistModelObject, _ text: String, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.scores(text: text, jobId: jobId)
    }
  }

  /// Roll many posts' distributions up into ranked channel-level topics.
  ///
  /// **Synchronous, and it takes no model.** Upstream's `channelTopics` is a free
  /// function -- pure, deterministic, no inference -- so this is a module
  /// function rather than a member, and it answers on a device that has never
  /// downloaded a weight.
  ///
  /// Bound rather than ported. Swift and Kotlin already agree on this arithmetic
  /// field for field and default for default; a TypeScript third implementation
  /// would be a third chance to differ, on a calculation whose output nothing
  /// would flag as wrong. And synchronous is both the fast shape and the safe one
  /// -- a synchronous `@JS` function's return value is encoded on the JavaScript
  /// thread by construction.
  @JS
  func channelTopics(
    _ posts: [GistPostTopics],
    _ options: GistRollupOptions
  ) -> [GistChannelTopic] {
    let mapped = posts.map { post in
      PostTopics(
        topics: Dictionary(post.topics.map { ($0.slug, $0.score) }, uniquingKeysWith: { _, last in last }),
        // `0` is the wire's "no timestamp"; upstream's nil means the post is
        // never decayed, which is what a caller who sent none meant.
        timestampMillis: post.timestampMillis == 0 ? nil : post.timestampMillis)
    }
    return gistChannelTopics(from: rollup(mapped, options.resolved()))
  }
}

/// A file-scope hop onto upstream's free function.
///
/// Needed because `channelTopics` is a free function in the `Gist` *module* while
/// this module class has a `@JS` member of the same name, and the module and the
/// class it contains are both spelled `Gist` -- so there is no qualified spelling
/// that reaches the free function from inside the member. At file scope there is
/// no member to shadow it.
private func rollup(_ posts: [PostTopics], _ options: RollupOptions) -> [ChannelTopic] {
  channelTopics(posts, options: options)
}

// MARK: - Landing a `@JS async` call back on the JavaScript thread

/// Run `body`, then put the rest of this `@JS async` call back on the JavaScript
/// thread before returning to `createAsyncFunction`.
///
/// **`@JavaScriptActor` does not hop.** Its executor is
/// `JavaScriptExecutor.enqueue { job.runSynchronously(on:) }`, and
/// expo-modules-jsi's own doc comment says so: it "executes jobs *synchronously*
/// without hopping to the proper thread ... running these jobs on the JavaScript
/// thread must be ensured externally". So the annotation is an assertion, not a
/// hop: the moment a `@JS async` function suspends on real work, its continuation
/// resumes on `com.apple.root.user-initiated-qos.cooperative`.
///
/// Two things then happen there, inside the closure the `@ExpoModule` macro
/// generated, and both touch Hermes without the runtime's lock:
///
/// 1. the return value is encoded (`Record.encode`, `Array<String>.encode`), and
/// 2. the **arguments** are destroyed. `createAsyncFunction` hands the closure an
///    *owning* copy of the argument buffer, so leaving it runs
///    `JavaScriptValuesBuffer.deinit` -> `jsi::Value::~Value()` once per argument.
///    Every argument that is a JS string or object -- a `@Record`, an array, a
///    `Float32Array`, and the `SharedObject` every entry point here takes first --
///    is a pointer into the Hermes heap being released off-thread.
///
/// (1) is why every `@JS async` function in this package returns `Void`. (2) is
/// not fixed by that, which is what `ShapesModule.load` proved by crashing in
/// `JavaScriptValuesBuffer.deinit` while returning nothing at all.
///
/// Awaiting this last fixes both: `runtime.schedule` runs its block on the
/// JavaScript thread, and resuming a `@JavaScriptActor` continuation from inside
/// that block runs the continuation *right there* -- the same non-hopping
/// executor, used the other way round. The generated closure therefore encodes
/// and tears down on the JavaScript thread.
///
/// A lost runtime is not an error here: if there is no runtime there is nothing
/// left to protect, and the call's own result still has to be delivered.
@JavaScriptActor
private func onJavaScriptThread(
  _ appContext: AppContext?,
  _ body: @JavaScriptActor () async throws -> Void
) async throws {
  do {
    try await body()
  } catch {
    await hopToJavaScriptThread(appContext)
    throw error
  }
  await hopToJavaScriptThread(appContext)
}

@JavaScriptActor
private func hopToJavaScriptThread(_ appContext: AppContext?) async {
  guard let appContext, let runtime = try? appContext.runtime else {
    return
  }
  await withCheckedContinuation { continuation in
    runtime.schedule {
      continuation.resume()
    }
  }
}
