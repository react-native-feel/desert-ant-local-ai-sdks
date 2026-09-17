// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other ten model
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
// instead of methods on it. `src/Align.ts` hides all of it.
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
//
// One extra thing this module does that none of the others need: it is gated on
// the OS twice. `@available(iOS 26, *)` on the two Speech entry points is the
// compile-time half -- this pod's deployment target is 17, so the Speech
// framework's types are only nameable inside an availability scope -- and
// `AlignModelObject.isSupported` is the runtime half a caller reads.

import Align
import DesertAnt
import ExpoModulesCore
import Foundation
import Speech

@ExpoModule("DesertAntAlign", classes: [AlignModelObject.self])
public final class AlignModule: Module {
  /// Whether this build and this device can run Align at all.
  ///
  /// Unlike Ear, Gist, Redact and Shapes -- where the Apple answer is always true
  /// and only the Android half has something to say -- this one genuinely varies
  /// on Apple. See `AlignModelObject.apiFloor`.
  @JS
  var isSupported: Bool { AlignModelObject.isSupported }

  /// Why `isSupported` is false, or `""` when it is true.
  @JS
  var unsupportedReason: String { AlignModelObject.unsupportedReason }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { AlignModelObject.coreVersion }

  /// The model revision this SDK resolves.
  ///
  /// Read it, and read `revisionIsPinned` beside it.
  @JS
  var modelRevision: String { AlignModel.revision }

  /// The Hugging Face repo the weights come from.
  @JS
  var modelRepo: String { AlignModel.repo }

  /// **False, today, and that is a risk a consumer inherits rather than a
  /// curiosity.**
  ///
  /// Every other model in this repo pins a `v`-prefixed tag, and `Sources/Ear/
  /// Catalog.swift` writes down why in as many words: *"Pinned to a tag rather
  /// than a branch. A branch means a push to the Hub silently changes what
  /// already-shipped SDKs download, which is the kind of change nobody is looking
  /// for when something starts behaving differently."*
  ///
  /// `Sources/Align/Catalog.swift` pins `"main"`, with upstream's own
  /// `// TODO: pin to a tag once the align model repo is tagged` above it. So an
  /// app that shipped against Align today and whose users install it tomorrow can
  /// get different weights, with no version number anywhere changing -- not this
  /// package's, not desert-ant-core's, not the one in `AlignTranscript.
  /// modelRevision`, which would read `main` in both cases.
  ///
  /// This is computed from the catalog rather than hardcoded, so it flips to true
  /// on its own the day upstream tags the repo. Until then an app that cares
  /// about reproducibility should pass `directory` to `load`, ship the weights it
  /// tested against itself, and never let the download run.
  @JS
  var revisionIsPinned: Bool { AlignModel.revision.hasPrefix("v") }

  /// Whether Apple's on-device speech recognition exists on this device at all.
  ///
  /// Separate from `isSupported`, because they fail for different reasons and
  /// have different fixes: `isSupported` is about the OS and the catalog,
  /// this is about `SpeechTranscriber` itself. Both must be true.
  @JS
  var appleSpeechAvailable: Bool {
    if #available(iOS 26, *) {
      return SpeechTranscriber.isAvailable
    }
    return false
  }

  /// How much audio the refiner keeps for context when the caller does not say,
  /// in seconds.
  ///
  /// Mirrored rather than read, like Redact's 0.6 and Shapes' 0: it is
  /// `maxBufferedSeconds: Double = 30` -- a default argument in four
  /// `SpeechTimestampRefiner` initializers -- and a default argument is not a
  /// constant any SDK exposes. Forwarded so one number is shown in one place.
  @JS
  var defaultMaxBufferedSeconds: Double { 30 }

  // Deliberately NOT exposed here: the list of languages Align refines.
  //
  // Not because it cannot be read -- it can, and `AlignModelObject.
  // supportedLanguages()` reads it -- but because it cannot be read *yet* at this
  // point in the lifecycle. The map lives in `refiner_config.json`, which is one
  // of the three sidecars the model downloads, so there is nothing to answer with
  // before `load`. Putting a hardcoded nine-element list on the module would make
  // it look like a property of the binary while being exactly as stale as a
  // TypeScript constant, which is the mistake `packages/shapes` wrote up at
  // length and declined to make.

  // MARK: - Construction

  @JS
  func createModel(_ options: AlignLoadOptions) throws -> AlignModelObject {
    guard AlignModelObject.isSupported else {
      throw UnsupportedPlatformException(AlignModelObject.unsupportedReason)
    }
    return AlignModelObject(directory: options.directory)
  }

  // MARK: - Work

  /// Download Align's weights and read the language map out of them.
  ///
  /// 0.7 MB in two Core ML stages plus three sidecars -- the second-smallest
  /// download in this family after Shapes' 0.2 MB, and about a seven-hundredth of
  /// Voz's. There is nothing here for an app to ask permission about.
  @JS
  @JavaScriptActor
  func load(_ model: AlignModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.load(jobId: jobId)
    }
  }

  /// Install Apple's on-device speech model for a locale.
  ///
  /// Align's *other* download, and the one desert-ant-core does not manage. See
  /// `AlignModelObject.installSpeechAssets`.
  @JS
  @JavaScriptActor
  func prepareLocale(_ model: AlignModelObject, _ locale: String, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      guard #available(iOS 26, *) else {
        throw UnsupportedPlatformException(AlignModelObject.unsupportedReason)
      }
      try await model.installSpeechAssets(identifier: locale, jobId: jobId)
    }
  }

  /// Transcribe an audio file with Apple's recognizer and refine every word
  /// boundary, holding the result on the shared object under `jobId`.
  ///
  /// Returns nothing on purpose; `takeTranscript` hands the record over
  /// synchronously. See `AlignModelObject.transcribe`.
  @JS
  @JavaScriptActor
  func transcribe(
    _ model: AlignModelObject,
    _ path: String,
    _ options: AlignTranscribeOptions,
    _ jobId: String
  ) async throws {
    try await onJavaScriptThread(appContext) {
      guard #available(iOS 26, *) else {
        throw UnsupportedPlatformException(AlignModelObject.unsupportedReason)
      }
      try await model.transcribe(path: path, options: options, jobId: jobId)
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
