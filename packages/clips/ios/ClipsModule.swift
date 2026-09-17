// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other two model
// packages here arrived at. Two limits, both found by compiling:
//
//   * `@JS async` works on an `@ExpoModule` class but NOT on a `@SharedObject`.
//   * A `@JS init` cannot throw: the generated `_constructSharedObject` calls it
//     without `try`.
//
// Hence `createModel` instead of `new`, and free functions taking the object
// instead of methods on it. `src/Clips.ts` hides all of it.
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

import Clips
import DesertAnt
import ExpoModulesCore
import Foundation
import Transcript

@ExpoModule("DesertAntClips", classes: [ClipsModelObject.self])
public final class ClipsModule: Module {
  /// Whether this build **and this device** can run Clips.
  ///
  /// Unlike Clear's and Voz's, this is not a constant on Apple: the model's
  /// Core ML package is multifunction, an iOS 18 feature, and nothing upstream
  /// enforces the floor `ClipModel` declares. See `ClipsModelObject.isSupported`.
  @JS
  var isSupported: Bool { ClipsModelObject.isSupported }

  /// Why `isSupported` is false, or nil when it is true. Two different
  /// situations -- "no artifact for this platform" and "this OS is too old" --
  /// call for two different pieces of UI, so the reason crosses rather than
  /// being reconstructed in JavaScript.
  @JS
  var unsupportedReason: String? { ClipsModelObject.unsupportedReason }

  /// The desert-ant-core version this binary links against.
  @JS
  var nativeCoreVersion: String { ClipsModelObject.coreVersion }

  /// The pinned model revision, so a set of clips can be traced to the weights
  /// that produced it. Pinning matters more than usual here: the scorer's window
  /// is the axis the exported arms vary on, so a repo moving under an unpinned
  /// tag would hand the SDK a graph of a different width and be caught by
  /// nothing but wrong clips.
  @JS
  var modelRevision: String { ClipModel.revision }

  /// How many clips a selection returns by default. Upstream's number, read
  /// rather than duplicated -- it is a product choice that may move.
  @JS
  var defaultLimit: Int { Clips.defaultClipLimit }

  // MARK: - Construction

  @JS
  func createModel(_ options: ClipsLoadOptions) throws -> ClipsModelObject {
    guard ClipsModelObject.isSupported else {
      throw UnsupportedPlatformException(
        ClipsModelObject.unsupportedReason ?? "Clips cannot run on this device")
    }
    return ClipsModelObject(directory: options.directory,
                            computeUnits: try options.resolvedComputeUnits())
  }

  // MARK: - Work

  /// Download the weights and build the session. ~288 MB, then roughly 41 s of
  /// Neural Engine specialization on the first load; call it behind an explicit
  /// step, not on mount.
  @JS
  @JavaScriptActor
  func load(_ model: ClipsModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.load(jobId: jobId)
    }
  }

  /// Select the best non-overlapping moments in a transcript, ranked best first,
  /// and hold them on the shared object under `jobId`.
  ///
  /// Returns nothing on purpose; `takeClips` hands the array over synchronously.
  /// A `@JS async` function's return value is encoded after its last suspension,
  /// and `@JavaScriptActor` does not hop -- so the encode lands on the
  /// cooperative pool. An array of records is exactly the shape that took Emo
  /// down. See the note at the bottom of this file.
  @JS
  @JavaScriptActor
  func findClips(
    _ model: ClipsModelObject,
    _ sentences: [ClipsSentence],
    _ options: ClipsFindOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let clips = try await model.find(sentences: sentences, options: options, jobId: jobId)
      model.stash(clips, for: jobId)
    }
  }

  // MARK: - Transcript shaping

  /// Group a recognizer's timed words into sentences.
  ///
  /// Synchronous and model-free: this is `Transcript.Sentence.sentences(from:)`,
  /// pure vocabulary shared by every Desert Ant model that reads a transcript,
  /// and it needs no weights and no download.
  ///
  /// It lives on this module because it is the join between a recognizer's output
  /// and this model's input -- Voz hands back `[Word]`, Clips wants sentences --
  /// and because reimplementing it in TypeScript would be a second definition of
  /// where a sentence ends, free to drift from the one selection was trained on.
  @JS
  func sentencesFromWords(_ words: [ClipsWord], _ runOnLimit: Int) -> [ClipsSentence] {
    Sentence
      .sentences(from: words.map { $0.asTimedWord() }, runOnLimit: max(1, runOnLimit))
      .map(clipsSentenceRecord(from:))
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
