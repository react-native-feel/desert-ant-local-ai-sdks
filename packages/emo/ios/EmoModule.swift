// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other four model
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
// instead of methods on it. `src/Emo.ts` hides all of it.
//
// Clear's third limit -- returning a `SharedObject` from a `@JS async` function
// kills the process -- does not reach this module either: Emo's results are a
// short array of records, so nothing here ever has to hand a Swift-allocated
// buffer back to JavaScript.

import DesertAnt
import Emo
import ExpoModulesCore
import Foundation

@ExpoModule("DesertAntEmo", classes: [EmoModelObject.self])
public final class EmoModule: Module {
  /// Whether this build can run Emo at all.
  ///
  /// Reads the catalog rather than answering `true`. On Apple it is always true
  /// -- `EmoModel.files` lists `.apple` -- but reading it means a republished
  /// catalog that dropped the platform would be reported rather than crashed
  /// into.
  @JS
  var isSupported: Bool { EmoModelObject.isSupported }

  /// Why `isSupported` is false, or "" when it is true.
  ///
  /// Empty rather than nil so the property is a plain `String` on both platforms;
  /// `src/Emo.ts` turns "" back into null. The Android half has something real to
  /// say here (which ABIs the device reported); this one would only ever be
  /// reporting a catalog that no longer lists Apple.
  @JS
  var unsupportedReason: String {
    EmoModelObject.isSupported
      ? ""
      : "desert-ant-core ships no Emo artifact for this platform."
  }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { EmoModelObject.coreVersion }

  /// The pinned model revision this SDK resolves, so a set of suggestions can be
  /// traced to the weights that produced it.
  @JS
  var modelRevision: String { Emo.modelRevision }

  /// The Hub repository the weights come from.
  @JS
  var modelRepo: String { Emo.modelRepo }

  /// Every skin tone the wire accepts.
  ///
  /// Read off the mapping that actually decodes them (`EmoSuggestOptions`)
  /// rather than duplicated in TypeScript, so the two cannot drift: a tone this
  /// list names is a tone `resolvedSkinTone()` can return.
  @JS
  var skinTones: [String] { EmoSuggestOptions.skinToneNames }

  /// `limit: Int = 3` in `Emo.suggestions(for:limit:skinTone:)`. Surfaced so the
  /// default lives in one place rather than in a Swift signature and a
  /// TypeScript constant that are free to disagree.
  @JS
  var defaultLimit: Int { EmoSuggestOptions.defaultLimit }

  // MARK: - Construction

  @JS
  func createModel(_ options: EmoLoadOptions) throws -> EmoModelObject {
    guard EmoModelObject.isSupported else {
      throw UnsupportedPlatformException("desert-ant-core ships no Emo artifact for this platform")
    }
    return EmoModelObject(directory: options.directory)
  }

  // MARK: - Work

  /// Download the weights and build the session. ~5 MB and a session build in
  /// milliseconds, which is why -- unlike every other model in this repo -- an
  /// app can call this on mount with nothing to apologise for.
  @JS
  @JavaScriptActor
  func load(_ model: EmoModelObject, _ jobId: String) async throws {
    try await model.load(jobId: jobId)
  }

  /// Rank the vocabulary for `text` and return the top `limit`.
  ///
  /// No progress and no job to report on: this is one forward pass at about two
  /// milliseconds. `jobId` is taken anyway so the signature matches every other
  /// entry point in the family, and so a future long-running call would not be a
  /// breaking change to the wire.
  @JS
  @JavaScriptActor
  func suggest(
    _ model: EmoModelObject,
    _ text: String,
    _ options: EmoSuggestOptions,
    _ jobId: String
  ) async throws -> [EmoSuggestionRecord] {
    try await model.suggest(text: text, options: options, jobId: jobId)
  }
}
