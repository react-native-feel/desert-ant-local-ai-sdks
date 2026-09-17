// The module owns construction, the one asynchronous entry point, and the
// detection; the shared object owns state and synchronous access to it.
//
// That split is what the Expo Modules 2.0 macros in expo-modules-core 57
// support, and it is the same split the other six model packages here arrived
// at. Two limits, both found by compiling:
//
//   * `@JS async` works on an `@ExpoModule` class but NOT on a `@SharedObject`.
//     The `@SharedObject` macro binds members onto the JS prototype through a
//     synchronous function type, so an async member fails to compile.
//   * A `@JS init` cannot throw: the generated `_constructSharedObject` calls it
//     without `try`. So construction that needs validation is a module function
//     returning the object, not a JS constructor.
//
// The other two limits are about what an asynchronous call may hand back --
// limit 3, a `SharedObject`, and limit 4, anything whose encoding can land off
// the JavaScript thread -- and this module is the first here that steps around
// both by construction rather than by care. Exactly one function is `async`,
// and it returns `Void`:
//
//   * `load` is asynchronous because reading and widening 2 MB does not belong
//     on the JavaScript thread. Nothing comes back from it.
//   * `detect` is synchronous because the model is tens of microseconds, so
//     there is nothing to get off the JavaScript thread -- and a synchronous
//     `@JS` function's return value is encoded on the JavaScript thread by
//     construction, which is the fix Ear had to arrive at the hard way.
//   * `scripts` is a property rather than a call, for the same reason: it is an
//     array of bare strings, which is precisely what segfaulted the runtime when
//     Ear returned it from an `async` function.
//
// `src/Tongue.ts` hides all of it, and still offers `detect()` as a promise so
// the seven models read alike.

import ExpoModulesCore
import Foundation

// MARK: - The one thing that is not written yet, and why
//
// `Tongue` is the only model in this family whose Swift half this SDK cannot
// link today, and the reason is two words missing from someone else's manifest.
//
// desert-ant-core v3.1.0 declares the product -- `tongueProducts` in its
// Package.swift -- and then builds the manifest from
// `products + modelProducts + alignProducts + vozProducts`, with no
// `+ tongueProducts`. `swift package dump-package` on the pinned tag lists 45
// products: `Clear`, `Voz`, `Clips`, `Uhm`, `Emo`, `Ear`, `Align`, `Title`, and
// no `Tongue`. The only thing in the package that depends on the target is the
// `ModelCatalogTests` test target, which is a target and not a product, which is
// why it builds green upstream and is invisible from there.
//
// It is not an `import` error. Naming `'Tongue'` in `DESERT_ANT_PRODUCTS` fails
// the whole build before a line is compiled: *Missing package product 'Tongue'
// (in target 'DesertAntCore' from project 'Pods')*. So the product is not named,
// this module compiles into its inert branch, and `isSupported` is false on
// Apple with a sentence that says exactly this.
//
// Everything below the guard is written, reviewed and waiting. When upstream
// adds `+ tongueProducts`, the change on this side is adding `'Tongue'` to
// `DESERT_ANT_PRODUCTS` in packages/core/ios/DesertAntCore.podspec -- one array
// entry -- and `canImport(Tongue)` does the rest.
//
// The Android half has no such problem: `ai.desertant:tongue` is a published,
// pure-Kotlin jar, and it binds normally.

#if canImport(Tongue)
import DesertAnt
import Tongue
#endif

@ExpoModule("DesertAntTongue", classes: [TongueModelObject.self])
public final class TongueModule: Module {
  /// Whether this build can run Tongue at all.
  ///
  /// Reads the catalog rather than answering `true`. Unlike Clear, Emo and Ear
  /// the Android half answers this the same way -- there is no ABI to check,
  /// because `ai.desertant:tongue` is a pure Kotlin jar with no native library.
  @JS
  var isSupported: Bool { TongueModelObject.isSupported }

  /// Why `isSupported` is false, or `""` when it is true.
  ///
  /// Always `""` in practice on both platforms. The property exists so one
  /// TypeScript file can ask the question uniformly, and so a future catalog
  /// change has somewhere to say so.
  @JS
  var unsupportedReason: String {
    TongueModelObject.isSupported ? "" : TongueModelObject.productMissingReason
  }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { TongueModelObject.coreVersion }

  /// The pinned model revision, so a detection can be traced to the weights that
  /// produced it.
  ///
  /// It names a Hub tag that **nothing in this SDK fetches**. Tongue is bundled:
  /// `desert-ant-labs/tongue` mirrors bytes that are sha256-identical to the
  /// copies in the package, for the website demo, and no `ModelStore` path in any
  /// Desert Ant SDK resolves this manifest.
  @JS
  var modelRevision: String { Self.modelRevisionValue }

  /// The Hugging Face repo mirroring the bundled weights. See `modelRevision`
  /// for why it is not a download.
  @JS
  var modelRepo: String { Self.modelRepoValue }

  /// `detect`'s own `topK` default, read off the Swift signature rather than
  /// duplicated in TypeScript.
  @JS
  var defaultTopK: Int { 3 }

  /// The gap below which `Detection.isTooCloseToCall` is true.
  ///
  /// Mirrored rather than read, and the only number in this module that is.
  /// Upstream writes `0.12` inline inside `isTooCloseToCall` on both platforms
  /// and names no constant, so there is nothing to read. It is forwarded anyway
  /// because it is the answer to the question a `true` provokes -- and nothing
  /// branches on it here or in TypeScript.
  @JS
  var tieMargin: Double { 0.12 }

  /// The scalar cap the normalizer applies. Read off `Normalizer.maxCharacters`,
  /// which is public on both platforms.
  @JS
  var maxCharacters: Int { Self.maxCharactersValue }

  /// Every UAX#24 script name the router knows.
  ///
  /// A **property**, so the `[String]` is encoded on the JavaScript thread. That
  /// is the whole reason it is not a function: an array of bare strings returned
  /// from a `@JS async` function is encoded off the JavaScript thread and
  /// segfaults the runtime, which is how Ear's `supportedLanguages` came to be
  /// split into a `Void` load and a synchronous read. Here there is nothing to
  /// load -- `Script` is a `CaseIterable` enum compiled into the binary -- so a
  /// property is the whole answer.
  ///
  /// Apple only. `ai.desertant:tongue` keeps `Router` and `ScriptTables`
  /// `internal`, so the Android half reports `[]` and `Tongue.supportedScripts()`
  /// turns that into `ERR_UNSUPPORTED_PLATFORM` rather than into an empty list a
  /// caller would have to guess about.
  @JS
  var scripts: [String] { Self.scriptNames }

  // MARK: - Construction

  /// Create the handle. Takes no options, because upstream's bundled initializer
  /// takes none: there is no directory to point at and nothing to download into
  /// one.
  @JS
  func createModel() throws -> TongueModelObject {
    guard TongueModelObject.isSupported else {
      throw UnsupportedPlatformException("desert-ant-core ships no Tongue model for this platform")
    }
    return TongueModelObject()
  }

  // MARK: - Work

  /// Read the bundled weights and build the pipeline.
  ///
  /// The only `async` function in this module, and it returns nothing. 2 MB and
  /// a widen, with no network anywhere near it.
  @JS
  @JavaScriptActor
  func load(_ model: TongueModelObject) async throws {
    try await model.load()
  }

  /// Identify the language of `text`. Synchronous -- see the note at the top.
  @JS
  func detect(
    _ model: TongueModelObject,
    _ text: String,
    _ options: TongueDetectOptions
  ) throws -> TongueDetection {
    try model.detect(text, options: options)
  }

  // MARK: - Values read from the linked module, or stated when it is not there
  //
  // Read rather than duplicated wherever there is a symbol to read: `TongueModel`
  // is the catalog declaration, `Normalizer.maxCharacters` is public, and
  // `Script` is a public `CaseIterable`. In the inert branch the first two fall
  // back to the same constants the Android half already states for the same
  // reason -- `ai.desertant:tongue` exposes neither -- and the script list falls
  // back to empty, which is the refusal `Tongue.supportedScripts()` turns into
  // `ERR_UNSUPPORTED_PLATFORM` rather than a list this package made up.

#if canImport(Tongue)
  private static var modelRevisionValue: String { TongueModel.revision }
  private static var modelRepoValue: String { TongueModel.repo }
  private static var maxCharactersValue: Int { Normalizer.maxCharacters }
  private static var scriptNames: [String] { Script.allCases.map(\.rawValue) }
#else
  private static var modelRevisionValue: String { "v1.0.0" }
  private static var modelRepoValue: String { "desert-ant-labs/tongue" }
  private static var maxCharactersValue: Int { 512 }
  private static var scriptNames: [String] { [] }
#endif
}
