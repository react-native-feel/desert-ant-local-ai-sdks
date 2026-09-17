// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other five model
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
// instead of methods on it. `src/Ear.ts` hides all of it.
//
// Clear's third limit -- returning a `SharedObject` from a `@JS async` function
// kills the process -- does not reach this module either: Ear's result is a short
// list of candidates, so nothing here ever has to hand a Swift-allocated buffer
// back to JavaScript.
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
import Ear
import ExpoModulesCore
import Foundation

@ExpoModule("DesertAntEar", classes: [EarModelObject.self])
public final class EarModule: Module {
  /// Whether this build can run Ear at all.
  ///
  /// Reads the catalog rather than answering `true`. The Android half answers the
  /// same question about the device's ABI; JavaScript's `Ear.isSupported` reports
  /// `false` by a third route where the module is not there to ask at all.
  @JS
  var isSupported: Bool { EarModelObject.isSupported }

  /// Why `isSupported` is false, or `""` when it is true.
  ///
  /// Always `""` in practice on Apple -- `EarModel.files` lists `.apple` and the
  /// artifact imposes no floor above the pod's. The property exists because the
  /// Android half genuinely has something to say here, and one TypeScript file
  /// reads both.
  @JS
  var unsupportedReason: String {
    EarModelObject.isSupported
      ? ""
      : "desert-ant-core ships no Ear artifact for this platform"
  }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { EarModelObject.coreVersion }

  /// The pinned model revision this SDK resolves, so a detection can be traced to
  /// the weights that produced it.
  @JS
  var modelRevision: String { EarModel.revision }

  /// The Hugging Face repo the weights come from.
  @JS
  var modelRepo: String { EarModel.repo }

  /// How many windows an identification listens to when the caller does not say.
  ///
  /// Read off `Ear.defaultWindows` rather than duplicated in TypeScript. It is a
  /// measured default -- three windows cost ~45 ms and cover the case one cannot,
  /// a file whose opening is music -- and it is upstream's to change.
  @JS
  var defaultWindows: Int { Ear.defaultWindows }

  /// How far ahead the top candidate must be before `isReliable` is true.
  ///
  /// Read off `Detection.reliableMargin` for the same reason. Exposed for display
  /// and for explaining a `false`, not for reimplementing the test: the flag is
  /// computed natively and also applies the Nordic rule, which no margin can
  /// express.
  @JS
  var reliableMargin: Double { Detection.reliableMargin }

  // MARK: - Construction

  @JS
  func createModel(_ options: EarLoadOptions) throws -> EarModelObject {
    guard EarModelObject.isSupported else {
      throw UnsupportedPlatformException("desert-ant-core ships no Ear artifact for this platform")
    }
    return EarModelObject(directory: options.directory)
  }

  // MARK: - Work

  /// Download the weights and build the session. ~9 MB, which is why -- unlike
  /// Voz and Clips -- an app can reasonably call this on mount.
  @JS
  @JavaScriptActor
  func load(_ model: EarModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.load(jobId: jobId)
    }
  }

  /// Name the language of the audio (or video) file at `path`, and hold the
  /// detection on the shared object under `jobId`.
  ///
  /// The primary API. The audio never crosses the JS boundary, and what comes
  /// back is a handful of candidates however long the recording is.
  ///
  /// Returns nothing on purpose; `takeDetection` hands the record over
  /// synchronously. See the note at the top of this file.
  @JS
  @JavaScriptActor
  func identifyFile(
    _ model: EarModelObject,
    _ path: String,
    _ options: EarIdentifyOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let detection = try await model.identifyFile(path: path, options: options, jobId: jobId)
      model.stash(detection, for: jobId)
    }
  }

  /// Name the language of mono samples already in memory.
  ///
  /// The `Float32Array` is copied into a Swift `[Float]` **here**, before the
  /// first `await`, and deliberately so: the typed array is JavaScript-owned
  /// memory whose lifetime the native side does not control, so reading
  /// `rawPointer` after a suspension would be reading a buffer the collector is
  /// free to have moved. `[Float]` is `Sendable` and the copy is the price.
  @JS
  @JavaScriptActor
  func identifySamples(
    _ model: EarModelObject,
    _ samples: Float32Array,
    _ sampleRate: Double,
    _ options: EarIdentifyOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let mono = [Float](
        UnsafeBufferPointer(
          start: samples.rawPointer.assumingMemoryBound(to: Float.self),
          count: samples.length
        )
      )
      let detection = try await model.identifySamples(
        mono, sampleRate: sampleRate, options: options, jobId: jobId)
      model.stash(detection, for: jobId)
    }
  }

  /// Fetch the model's language list and hold it on the shared object.
  ///
  /// Returns nothing on purpose. A `@JS async` function returning `[String]`
  /// encodes that array off the JavaScript thread and segfaults; the array is
  /// read back through the shared object's synchronous `languages()` instead.
  /// The full account is on `EarModelObject.loadLanguages`.
  ///
  /// Apple only. It reads the `languages.json` sidecar through the loaded model,
  /// and `ai.desertant:ear` publishes nothing equivalent -- so the Android half
  /// raises `ERR_UNSUPPORTED_PLATFORM` here rather than inventing a list.
  @JS
  @JavaScriptActor
  func loadLanguages(_ model: EarModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.loadLanguages(jobId: jobId)
    }
  }
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
