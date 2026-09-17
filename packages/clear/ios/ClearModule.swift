// The module owns every asynchronous entry point, and the shared objects own
// only state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support. Two limits, both found by compiling:
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
// Hence `createModel` / `createAudio` instead of `new`, and free functions
// taking the object instead of methods on it. `src/Clear.ts` hides all of it;
// the Android half mirrors the same surface with module-level AsyncFunctions.
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
import Clear
import Foundation

@ExpoModule("DesertAntClear", classes: [ClearModelObject.self, ClearAudioObject.self])
public final class ClearModule: Module {
  /// Whether this build can run Clear at all. Always true on Apple: the podspec's
  /// iOS 18 floor is what would otherwise be checked here, and it is enforced at
  /// install time. Android answers this for real (32-bit ABIs cannot load the
  /// native core).
  @JS
  var isSupported: Bool { true }

  /// The desert-ant-core version this binary links against. Worth surfacing: the
  /// Apple and Android halves share an FFI payload schema, and a bug report that
  /// names both versions is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { ClearModelObject.coreVersion }

  // MARK: - Construction

  @JS
  func createModel(_ options: ClearLoadOptions) throws -> ClearModelObject {
    guard let variant = ModelVariant(rawValue: options.variant) else {
      throw InvalidVariantException(options.variant)
    }
    return ClearModelObject(directory: options.directory, variant: variant)
  }

  @JS
  func createAudio(_ channelCount: Int, _ frameCount: Int, _ sampleRate: Double) throws
    -> ClearAudioObject
  {
    guard channelCount > 0, frameCount >= 0, sampleRate > 0 else {
      throw InvalidBufferShapeException((channelCount, frameCount))
    }
    return ClearAudioObject(channelCount: channelCount, frameCount: frameCount,
                            sampleRate: sampleRate)
  }

  // MARK: - Work

  /// Fetch the weights ahead of time so the first enhance is not also a download.
  /// A no-op once available.
  @JS
  @JavaScriptActor
  func download(_ model: ClearModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.download(jobId: jobId)
    }
  }

  /// Build the session now, downloading first if needed. On the first-ever launch
  /// this is where the Core ML compile happens; call it behind a splash screen.
  @JS
  @JavaScriptActor
  func load(_ model: ClearModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.load(jobId: jobId)
    }
  }

  /// Decode `inputPath`, enhance it, and write the result to `outputPath`.
  ///
  /// The primary API. It runs the Swift SDK's streaming path, so peak memory
  /// stays flat instead of growing with the file, and no audio crosses the JS
  /// boundary at all. The output encoding follows `outputPath`'s extension:
  /// `.wav` is 16-bit PCM, `.m4a`/`.mp4`/`.aac` is AAC, `.caf`/`.aiff` is PCM,
  /// anything else is WAV.
  ///
  /// Returns nothing, and the metrics come back through `takeMetrics`. That is
  /// the fourth Expo Modules 2.0 limit rather than a caching decision: the
  /// `ClearMetrics` record used to be encoded here, off the JavaScript thread,
  /// and `Record.encode` on `com.apple.root.user-initiated-qos.cooperative` is
  /// two of the crash reports that motivated this round. See the note at the
  /// bottom of this file.
  @JS
  @JavaScriptActor
  func enhanceFile(
    _ model: ClearModelObject,
    _ inputPath: String,
    _ outputPath: String,
    _ options: ClearEnhanceOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      let metrics = try await model.enhanceFile(
        inputPath: inputPath, outputPath: outputPath, options: options, jobId: jobId)
      model.stashMetrics(metrics, for: jobId)
    }
  }

  /// Enhance samples already in memory. Returns nothing: the audio is collected
  /// with `takeEnhancedAudio` and the metrics with `takeMetrics`, both
  /// synchronous.
  ///
  /// Second-class next to `enhanceFile`: it exists for audio an app synthesized
  /// or already holds, and it pays a copy in each direction. See ClearAudio.swift.
  ///
  /// The two-call shape is not a preference, and it is not a guess: returning a
  /// `SharedObject` from a `@JS async` function kills the process on device
  /// (expo-modules-core 57, iPhone 16 / iOS 26.3.1) with no catchable JS error,
  /// while the same object returned from a *synchronous* `@JS` function --
  /// `createAudio`, and `takeEnhancedAudio` below -- is fine. Measured with a
  /// throwaway `enhanceBufferDirect` probe run last in the example's self-test:
  /// everything before it logged, the probe logged neither success nor failure,
  /// and the app was gone.
  ///
  /// So the object is built here, parked on the model, and collected
  /// synchronously. The metrics go the same way now, for the *other* half of
  /// limit 4 -- `ClearMetrics.toObject` under `closure #6 in
  /// ClearModule._decorateModule` is two of this repo's crash reports.
  /// `src/Clear.ts` does all three calls in one `enhanceSamples`, so the public
  /// API never sees the seam.
  @JS
  @JavaScriptActor
  func enhanceBuffer(
    _ model: ClearModelObject,
    _ input: ClearAudioObject,
    _ options: ClearEnhanceOptions,
    _ jobId: String
  ) async throws {
    // Read the input's samples here, before the first suspension, rather than
    // inside the worker: `[[Float]]` is Sendable and a shared object is not.
    let channels = input.channels
    let sampleRate = input.sampleRate
    try await onJavaScriptThread(appContext) {
      let result = try await model.enhance(
        channels: channels, sampleRate: sampleRate, options: options, jobId: jobId)
      let audio = ClearAudioObject(result: result, variant: model.variant)
      model.stash(audio, for: jobId)
      model.stashMetrics(audio.enhancedMetrics, for: jobId)
    }
  }

  /// Collect the buffer `enhanceBuffer` produced for `jobId`. Synchronous, and
  /// callable exactly once per job.
  @JS
  func takeEnhancedAudio(_ model: ClearModelObject, _ jobId: String) throws -> ClearAudioObject {
    try model.takeStashed(jobId)
  }

  /// Collect the metrics `enhanceFile` or `enhanceBuffer` produced for `jobId`.
  /// Synchronous, and callable exactly once per job.
  ///
  /// Synchronous is the whole point: a synchronous `@JS` function's return value
  /// is encoded inside the host call, on the JavaScript thread, by construction.
  /// `src/Clear.ts` issues it immediately after the async half, so the public
  /// API never sees the seam.
  @JS
  func takeMetrics(_ model: ClearModelObject, _ jobId: String) throws -> ClearMetrics {
    try model.takeStashedMetrics(jobId)
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
