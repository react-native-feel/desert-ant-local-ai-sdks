// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other three model
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
// instead of methods on it. `src/Uhm.ts` hides all of it.
//
// Clear's third limit -- returning a `SharedObject` from a `@JS async` function
// kills the process -- does not reach this module either: Uhm's results are
// spans, so nothing here ever has to hand a Swift-allocated buffer back to
// JavaScript.
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
import ExpoModulesCore
import Foundation
import Uhm

@ExpoModule("DesertAntUhm", classes: [UhmModelObject.self])
public final class UhmModule: Module {
  /// Whether this build can run Uhm at all.
  ///
  /// Reads the catalog rather than answering `true`. JavaScript's
  /// `Uhm.isSupported` reports `false` off iOS by a different route -- the native
  /// module is not there to ask.
  @JS
  var isSupported: Bool { UhmModelObject.isSupported }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { UhmModelObject.coreVersion }

  /// The pinned model revision this SDK resolves, so a set of detections can be
  /// traced to the weights that produced it.
  @JS
  var modelRevision: String { UhmModel.revision }

  /// What confidence each bias preset gates at.
  ///
  /// Read off `Uhm.Bias` rather than duplicated in TypeScript. The numbers are
  /// calibrated against Desert Ant's labelled corpus and are stable across model
  /// revisions, but they are still upstream's to change -- and a second copy of
  /// them in JavaScript would be free to disagree with the one actually applied.
  @JS
  var biasThresholds: [String: Double] {
    [
      "precision": Uhm.Bias.precision.minConfidence,
      "balanced": Uhm.Bias.balanced.minConfidence,
      "recall": Uhm.Bias.recall.minConfidence,
    ]
  }

  /// Every type the labeller can return, so a UI can enumerate them without
  /// hardcoding the set.
  @JS
  var fillerTypes: [String] { Uhm.FillerType.allCases.map(\.rawValue) }

  // MARK: - Construction

  @JS
  func createModel(_ options: UhmLoadOptions) throws -> UhmModelObject {
    guard UhmModelObject.isSupported else {
      throw UnsupportedPlatformException("desert-ant-core ships no Uhm artifact for this platform")
    }
    return UhmModelObject(
      directory: options.directory,
      computeUnits: try options.resolvedComputeUnits())
  }

  // MARK: - Work

  /// Download the weights and build the session. ~45 MB and a session build
  /// measured in seconds, which is why -- unlike Voz and Clips -- an app can
  /// reasonably call this on mount.
  @JS
  @JavaScriptActor
  func load(_ model: UhmModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.load(jobId: jobId)
    }
  }

  /// Find the fillers in the audio (or video) file at `path`, and hold the result
  /// on the shared object under `jobId`.
  ///
  /// The primary API. The audio never crosses the JS boundary, and what comes
  /// back is a handful of spans however long the recording is.
  ///
  /// Returns nothing on purpose; `takeResult` hands the record over
  /// synchronously. See the note at the top of this file.
  @JS
  @JavaScriptActor
  func analyzeFile(
    _ model: UhmModelObject,
    _ path: String,
    _ options: UhmAnalyzeOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let result = try await model.analyzeFile(path: path, options: options, jobId: jobId)
      model.stash(result, for: jobId)
    }
  }

  /// Find the fillers in mono samples already in memory.
  ///
  /// The `Float32Array` is copied into a Swift `[Float]` **here**, before the
  /// first `await`, and deliberately so: the typed array is JavaScript-owned
  /// memory whose lifetime the native side does not control, so reading
  /// `rawPointer` after a suspension would be reading a buffer the collector is
  /// free to have moved. `[Float]` is `Sendable` and the copy is the price.
  @JS
  @JavaScriptActor
  func analyzeSamples(
    _ model: UhmModelObject,
    _ samples: Float32Array,
    _ sampleRate: Double,
    _ options: UhmAnalyzeOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let mono = [Float](
        UnsafeBufferPointer(
          start: samples.rawPointer.assumingMemoryBound(to: Float.self),
          count: samples.length
        )
      )
      let result = try await model.analyzeSamples(
        mono, sampleRate: sampleRate, options: options, jobId: jobId)
      model.stash(result, for: jobId)
    }
  }

  // MARK: - Transcript reconciliation

  /// Trim a transcript's words around detected fillers.
  ///
  /// Synchronous and model-free: this is `Uhm.reconcileWords`, pure geometry over
  /// two sets of spans, and it needs no weights and no download.
  ///
  /// It lives on this module because it is the join between a recognizer's output
  /// and this model's -- Voz hands back words, Uhm hands back filler spans, and
  /// an editor needs one set of ranges that respects both -- and because
  /// reimplementing it in TypeScript would be a second definition of where a cut
  /// goes, free to drift from this one. The five overlap cases are not obvious
  /// enough to want two copies of.
  @JS
  func reconcileWords(
    _ words: [UhmWord],
    _ fillers: [UhmRange],
    _ options: UhmReconcileOptions
  ) -> [UhmWord] {
    Uhm.reconcileWords(
      words.map { $0.asWordRange() },
      fillers: fillers.map { $0.asDetection() },
      options: options.resolved()
    ).map(uhmWord(from:))
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
