// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split
// `@desert-ant-labs/react-native-clear` arrived at. Two limits, both found by
// compiling:
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
// instead of methods on it. `src/Voz.ts` hides all of it.
//
// Clear's third limit -- returning a `SharedObject` from a `@JS async` function
// kills the process -- does not reach this module, and that is worth saying out
// loud rather than leaving as a coincidence: Voz's results are text, so nothing
// here ever has to hand a Swift-allocated buffer back to JavaScript.
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

import ExpoModulesCore
import Foundation
import Voz

@ExpoModule("DesertAntVoz", classes: [VozModelObject.self])
public final class VozModule: Module {
  /// Whether this build can run Voz at all.
  ///
  /// Reads the catalog rather than answering `true`: `VozModel.files` is the
  /// upstream statement of which platforms have an artifact, and on Apple it does
  /// have one. JavaScript's `Voz.isSupported` reports `false` off iOS by a
  /// different route -- the native module is not there to ask.
  @JS
  var isSupported: Bool { VozModel.supports(.current) }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { VozModelObject.coreVersion }

  /// The pinned model revision this SDK resolves, so a transcript can be traced
  /// to the weights that produced it.
  @JS
  var modelRevision: String { VozModel.revision }

  /// The 25 languages the model was trained on, as ISO 639-1 codes.
  ///
  /// Exposed because the failure it prevents is silent: Voz does not detect what
  /// it is hearing, and audio in a language outside this set comes back as
  /// confident nonsense rather than an error. Sorted so the array is stable
  /// across calls -- upstream holds it as a `Set`.
  @JS
  var supportedLanguages: [String] { Voz.supportedLanguages.sorted() }

  // MARK: - Construction

  @JS
  func createModel(_ options: VozLoadOptions) throws -> VozModelObject {
    guard VozModel.supports(.current) else {
      throw UnsupportedPlatformException("desert-ant-core ships no Voz artifact for this platform")
    }
    return VozModelObject(directory: options.directory)
  }

  // MARK: - Work

  /// Fetch the weights ahead of time. ~490 MB, so this is a real download with a
  /// real progress bar. A no-op once available.
  @JS
  @JavaScriptActor
  func download(_ model: VozModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.download(jobId: jobId)
    }
  }

  /// Download if needed, then build the Core ML session. On the first load after
  /// a download this is where the ~20 s Neural Engine specialization happens;
  /// call it behind a splash screen or an explicit "prepare" step.
  @JS
  @JavaScriptActor
  func load(_ model: VozModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.load(jobId: jobId)
    }
  }

  /// Transcribe the audio file at `path`, and hold the transcript on the shared
  /// object under `jobId`.
  ///
  /// The primary API. The audio never crosses the JS boundary, and upstream reads
  /// the file a chunk at a time, so a one-hour recording costs the same call as a
  /// two-second one without holding 230 MB of `Float`.
  ///
  /// Returns nothing on purpose; `takeTranscript` hands the record over
  /// synchronously. A `VozTranscript` is an array of `@Record`s inside a
  /// `@Record`, which is the largest thing this package could have tried to
  /// encode off the JavaScript thread. See the note at the top of this file.
  @JS
  @JavaScriptActor
  func transcribeFile(
    _ model: VozModelObject,
    _ path: String,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let transcript = try await model.transcribeFile(path: path, jobId: jobId)
      model.stash(transcript, for: jobId)
    }
  }

  /// Transcribe mono samples already in memory.
  ///
  /// The `Float32Array` is copied into a Swift `[Float]` **here**, before the
  /// first `await`, and deliberately so: the typed array is JavaScript-owned
  /// memory whose lifetime the native side does not control, so reading
  /// `rawPointer` after a suspension would be reading a buffer the collector is
  /// free to have moved. `[Float]` is `Sendable` and the copy is the price.
  ///
  /// That direction is the cheap one. Getting samples *back* out is what forced
  /// Clear's `ClearAudio` shared object; Voz returns text and needs no such thing.
  @JS
  @JavaScriptActor
  func transcribeSamples(
    _ model: VozModelObject,
    _ samples: Float32Array,
    _ sampleRate: Double,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let mono = [Float](
        UnsafeBufferPointer(
          start: samples.rawPointer.assumingMemoryBound(to: Float.self),
          count: samples.length
        )
      )
      let transcript = try await model.transcribeSamples(mono, sampleRate: sampleRate, jobId: jobId)
      model.stash(transcript, for: jobId)
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
