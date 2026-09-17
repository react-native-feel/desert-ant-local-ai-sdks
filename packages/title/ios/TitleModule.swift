// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it -- the split the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and the same one the other eleven model packages
// here arrived at. The four limits are written up at length in
// `packages/align/ios/AlignModule.swift` and in docs/architecture.md; the ones
// that reach this file are all of them:
//
//   * `@JS async` does not compile on a `@SharedObject`, so the async entry
//     points are here and take the object as their first argument.
//   * A `@JS init` cannot throw, so construction is `createModel`.
//   * A `@SharedObject` must not come back from a `@JS async` function, so
//     `createModel` is synchronous.
//   * A `@JS async` function does its last work on the wrong thread, so **both**
//     async functions below return `Void` and the card comes back through the
//     shared object's synchronous `takeCard` -- and both also land back on the
//     JavaScript thread before returning, through `onJavaScriptThread` at the
//     bottom of this file, because the same closure destroys the call's
//     *arguments* there too.
//
// MARK: - The MLX trait, which is why this package does half of what it says
//
// Title is the only model in desert-ant-core that does not run through
// `InferenceSession`. It runs on MLX, because writing a title is short
// autoregressive decode and upstream measured that 5.7-8.3x faster on the GPU
// than on the Neural Engine (`Sources/Title/Catalog.swift` carries the numbers:
// 213 ms to first token against 55, 86 tok/s against 447, 1921 MB resident
// against 635). MLX pulls `MLXHuggingFace`, whose
// `#huggingFaceLoadModelContainer` is a macro, which pulls swift-syntax and host
// macro plugins into the graph -- so upstream put it behind a SwiftPM package
// TRAIT (SE-0450) rather than making every Linux, Android and wasm consumer build
// it. `Package.swift`:
//
//     .trait(name: "MLX", description: "MLX-backed generation (the Title model).
//             Apple platforms only; pulls mlx-swift-lm and swift-transformers
//             into the graph.")
//
// and every mlx product edge carries `condition: .when(traits: ["MLX"])`, so
// SwiftPM prunes the dependency entirely when nothing enables it. Without the
// trait the `Title` target still compiles -- `Card`, the prompt and the parser
// are outside the `#if MLX` -- but `Titles` has no public initializer, which
// upstream chose deliberately so that "a consumer that forgot the trait fails at
// compile time instead of mis-building".
//
// **There is no way to enable it from this repo.** Four things were checked
// before this file was written, and each is a dead end for a different reason:
//
//   1. React Native's SPM bridge. `scripts/cocoapods/spm.rb` in the installed
//      react-native 0.86.3 declares
//      `def dependency(pod_spec, url:, requirement:, products:)`. Four
//      parameters, no traits, and `add_spm_to_target` sets exactly
//      `repositoryURL`, `requirement` and `product_name`. There is nothing to
//      pass.
//   2. A `post_install` hook writing it into Pods.xcodeproj. The Xcode project
//      format has no field for it. `grep -ril trait` over the whole of
//      xcodeproj 1.27.0 -- the gem CocoaPods uses to write the project -- returns
//      nothing at all, so neither `XCRemoteSwiftPackageReference` nor
//      `XCSwiftPackageProductDependency` can carry one.
//   3. Xcode itself. `grep -ril enabledTraits` over Xcode 26.4.1 (17E202) matches
//      exactly two files, both of them
//      `SwiftPM.framework/.../PackageDescription.swiftmodule/*.swiftinterface` --
//      the MANIFEST api. No IDE framework mentions it, and `xcodebuild -help`
//      lists no trait flag among its fifteen package options.
//   4. The command line. `swift build --traits MLX` exists and works -- it is
//      right there in `swift build --help` under TRAIT OPTIONS -- but it applies
//      to the ROOT package of a SwiftPM build. The root here is an Xcode app
//      target, and `xcodebuild` is what builds it.
//
// So the trait is enabled in exactly two places: a consuming `Package.swift`
// (`.package(url: ..., traits: ["MLX"])`, which is what desertant.com/models/title
// tells a Swift developer to write) and `swift build --traits`. A CocoaPods app
// is neither.
//
// The one construction that could work was considered and rejected on its
// merits, not overlooked: a small local SwiftPM package vendored in this repo
// that declares `.package(url: desert-ant-core, traits: ["MLX"])` and is bridged
// by path -- spm.rb does handle `XCLocalSwiftPackageReference`, and SwiftPM
// unions the traits its dependents request. It is rejected because a trait is a
// property of the PACKAGE, not of one product: enabling `MLX` for
// `desert-ant-core` enables it for every consumer of the single `DesertAntCore`
// pod, which is all twelve models. An app that installs only Shapes -- 0.2 MB, no
// transformer anywhere near it -- would clone mlx-swift, mlx-swift-lm,
// swift-transformers and swift-syntax and build host macro plugins to link it.
// That is precisely the cost upstream's manifest says in as many words the trait
// exists to avoid, and paying it for all twelve to switch on one is the wrong
// trade for a model that, even switched on, would not run here: MLX is Metal on
// Apple silicon and an iOS Simulator is not that.
//
// The shape of the fix, when it comes, is small and is the reason this file is
// written the way it is. Enable the trait by whatever means exists then, and
// `canImport(MLXLMCommon)` turns the generating branch of `TitleModelObject` on
// by itself. Nothing else in this package changes -- not the TypeScript, not the
// records, not the podspec.
//
// MARK: - What is left, and why it is worth shipping
//
// The half that works is the catalog half: `TitleModel` is a `ModelDeclaration`,
// so its coordinates, its seven-file Apple manifest, its pinned `v0.1.0`
// revision, its OS floor and -- through the shared extension -- `resolve`,
// `isAvailable` and `distribution` are all public and all MLX-free. An app can
// download, verify and inspect the ~280 MB model folder here today, and hand its
// path to a native caller that does have the trait. That is a real thing, it is
// exercised end to end, and it is the difference between this package and Tongue,
// whose Apple half cannot be linked at all.
//
// What is NOT here, and the task brief guessed otherwise, is the parser. Upstream's
// header comment advertises the portable half as "`Card`, the prompt, and `parse`
// ... portable and tested everywhere", and it is right that they are outside
// `#if MLX` -- but `static let prompt` and `static func parse(_:)` are both
// INTERNAL to the `Title` module. `public actor Titles` has no public member at
// all without the trait. So of the portable half only `Card` is reachable from
// outside, and a `Card` with no way to make one is a struct. Porting `parse`
// into TypeScript was considered and dropped: it is a twenty-line format reader
// for raw model text, and with generation absent there is no raw model text on
// this side of the bridge for it to read. It would have been decoration.

import DesertAnt
import ExpoModulesCore
import Foundation
import Title

@ExpoModule("DesertAntTitle", classes: [TitleModelObject.self])
public final class TitleModule: Module {
  /// Whether this build can write a card. **False**, and the reason is the `MLX`
  /// package trait rather than the device. See `unsupportedReason`, and read
  /// `canDownloadWeights` beside it.
  @JS
  var isSupported: Bool { TitleModelObject.isSupported }

  /// Whether the model folder can be downloaded, verified and inspected here.
  ///
  /// True on Apple. This is the split that makes the package worth installing
  /// today, and it is why `Title.create()` in TypeScript gates on this rather
  /// than on `isSupported`: refusing to construct the model would hide a working
  /// capability behind a broken one.
  @JS
  var canDownloadWeights: Bool { TitleModelObject.canDownloadWeights }

  /// Whether this binary was built with desert-ant-core's `MLX` package trait.
  ///
  /// Reported rather than assumed, so the day it becomes true nothing here has to
  /// be edited to notice. See the note at the top of this file for why it is
  /// false and what would change it.
  @JS
  var mlxTraitEnabled: Bool { TitleModelObject.mlxTraitEnabled }

  /// Why `isSupported` is false, or `""` when it is true.
  @JS
  var unsupportedReason: String { TitleModelObject.unsupportedReason }

  /// The desert-ant-core version this binary links against, read off
  /// `TitleModel.sdkVersion`.
  @JS
  var nativeCoreVersion: String { TitleModelObject.coreVersion }

  /// The catalog id -- `title`. The Hub repo suffix, the cache directory name and
  /// the usage-event name all derive from it upstream.
  @JS
  var modelId: String { TitleModel.id }

  /// The Hugging Face repo the model folder comes from.
  @JS
  var modelRepo: String { TitleModel.repo }

  /// The model revision this SDK resolves: `v0.1.0`.
  @JS
  var modelRevision: String { TitleModel.revision }

  /// Whether `modelRevision` names a tag rather than a branch. **True**, unlike
  /// Align's.
  ///
  /// Worth surfacing here even though the answer is the good one, because the
  /// catalog note above it is a warning about the opposite: upstream records that
  /// this entry once carried a justification for an exception that had already
  /// expired, and that `ModelCatalogTests` does not cover Title, "so nothing here
  /// would have caught the staleness". Computed, so it flips on its own either
  /// way.
  @JS
  var revisionIsPinned: Bool { TitleModel.revision.hasPrefix("v") }

  /// Upstream's one-line description of the model, from the catalog rather than
  /// from this package's README.
  @JS
  var modelSummary: String { TitleModel.summary }

  /// The seven files upstream declares for Apple, in declaration order.
  ///
  /// A property rather than a call, and synchronous, for the reason Tongue's
  /// `scripts` is: an array of bare strings out of a `@JS async` function is
  /// precisely what segfaulted the runtime in Ear.
  ///
  /// Read off `TitleModel.files[.apple]`, which is the same list the downloader
  /// fetches and the same list `missingFiles()` checks -- so there is exactly one
  /// copy of it in the binary and none in TypeScript.
  @JS
  var modelFiles: [String] { TitleModelObject.declaredFiles }

  /// The runnable artifact among them: `model.safetensors`.
  ///
  /// Upstream notes that this is the one file "the shared declaration considers
  /// *the* model, though MLX loads the whole directory rather than one file" --
  /// which is the shape difference between this model and every other one in the
  /// catalog, where the artifact is a single `.mlmodelc` or `.tflite`.
  @JS
  var weightsFileName: String { TitleModel.artifact(for: .apple) }

  /// The oldest iOS the model's runtime runs on: 17.
  ///
  /// Read off `TitleModel.osFloor`, which is `OSFloor.mlx`. Unlike Clips' 18 this
  /// is a DEPENDENCY floor rather than an artifact one -- MLX has no build below
  /// it -- which is why desert-ant-core's package floor had to rise to meet it
  /// and why this pod, this plugin and the shared pod all agree on 17.
  @JS
  var osFloorIOS: Int { TitleModel.osFloor.iOS }

  /// The decode cap this SDK sends when a caller does not say: 96 tokens.
  ///
  /// Mirrored rather than read, like Align's `defaultMaxBufferedSeconds` and
  /// Redact's `defaultMinimumConfidence`: it is `maxTokens: Int = 96`, a default
  /// argument on `Titles.init`, and a default argument is not a constant any SDK
  /// exposes. Upstream's reason for the cap is worth repeating -- "the cap stops
  /// a degenerate run decoding forever, which is a real failure mode for a small
  /// instruct model given unusual input".
  @JS
  var defaultMaxTokens: Int { 96 }

  // Deliberately NOT exposed here: the prompt, and the title/description shape it
  // asks for.
  //
  // `Titles.prompt` is `static let` with no access modifier -- internal -- so it
  // cannot be read off the binary, and it is the single most load-bearing string
  // in the model. Upstream's docs on it record what happens when a copy drifts:
  // the previous version of that property "was a different string from the one
  // training used", so the shipped model "was served an unseen prompt on every
  // call" and a rule the prompt spent four lines on had never appeared in a
  // training example. Writing a second copy into this package would be the same
  // mistake with an extra language boundary in it. The product page says the same
  // thing to developers -- "use the SDK's own prompt" -- and the SDK's own prompt
  // is the one inside the module.
  //
  // The 3-8 words and 1-2 sentences are in that same internal string, so they are
  // not readable either. `cardShape` in TypeScript checks a card against them
  // without claiming to have read them: see `src/card.ts`, which cites the
  // published model page rather than pretending to a source it does not have.

  // MARK: - Construction

  @JS
  func createModel(_ options: TitleLoadOptions) throws -> TitleModelObject {
    guard TitleModelObject.canDownloadWeights else {
      throw UnsupportedPlatformException(TitleModelObject.unsupportedReason)
    }
    return TitleModelObject(
      directory: try options.resolvedDirectory(),
      maxTokens: try options.resolvedMaxTokens())
  }

  // MARK: - Work

  /// Download and verify the ~280 MB model folder, and load the generator from it
  /// where the build can.
  ///
  /// Not a call to make on mount. This is the third-largest download in the
  /// family after Voz's ~490 MB and Clips' ~288 MB, and unlike either of those the
  /// thing it buys cannot be used in this build -- so the example app puts it
  /// behind a button and says what it costs.
  @JS
  @JavaScriptActor
  func prepare(_ model: TitleModelObject, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.prepare(jobId: jobId)
    }
  }

  /// Write a title and a description for `text`, holding the card on the shared
  /// object under `jobId`.
  ///
  /// Returns nothing on purpose; `takeCard` hands the record over synchronously.
  ///
  /// **Throws `ERR_UNSUPPORTED_PLATFORM` on every call in this build**, with the
  /// sentence from `unsupportedReason`. It does not return an empty card, and it
  /// does not return a card assembled from the passage by some other means. A
  /// method that silently produced nothing would be the one outcome worse than an
  /// absent one, because an app would ship it.
  @JS
  @JavaScriptActor
  func describe(_ model: TitleModelObject, _ text: String, _ jobId: String) async throws {
    try await onJavaScriptThread(appContext) {
      try await model.describe(text: text, jobId: jobId)
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
