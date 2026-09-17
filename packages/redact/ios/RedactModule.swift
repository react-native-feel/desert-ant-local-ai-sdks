// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other eight model
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
// instead of methods on it. `src/Redact.ts` hides all of it.
//
// The third limit -- returning a `SharedObject` from a `@JS async` function kills
// the process -- does not reach this module: nothing here hands a Swift-allocated
// buffer back to JavaScript.
//
// The fourth does, and it is the one that shaped this file. **Every `@JS async`
// function below returns `Void`**, because an async return value can be encoded
// off the JavaScript thread and segfault the runtime. It has now been reproduced
// in four packages -- Ear on `[String]`, Clear in `Record.encode`, Emo in
// `JavaScriptValuesBuffer.deinit` -- so it is a property of the toolchain rather
// than of any one result's size. The redaction comes back through the shared
// object's synchronous `takeRedaction`. See the long note on
// `RedactModelObject.redaction`.

import DesertAnt
import ExpoModulesCore
import Foundation
import Redact

@ExpoModule("DesertAntRedact", classes: [RedactModelObject.self])
public final class RedactModule: Module {
  /// Whether this build can run Redact at all.
  ///
  /// Reads the catalog rather than answering `true`. The Android half answers the
  /// same question about the device's ABI; JavaScript's `Redact.isSupported`
  /// reports `false` by a third route where the module is not there to ask at
  /// all.
  @JS
  var isSupported: Bool { RedactModelObject.isSupported }

  /// Why `isSupported` is false, or `""` when it is true.
  ///
  /// Always `""` in practice on Apple -- `RedactModel.files` lists `.apple` and
  /// the artifact imposes no floor above the pod's. The property exists because
  /// the Android half genuinely has something to say here, and one TypeScript
  /// file reads both.
  @JS
  var unsupportedReason: String {
    RedactModelObject.isSupported
      ? ""
      : "desert-ant-core ships no Redact artifact for this platform"
  }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { RedactModelObject.coreVersion }

  /// The pinned model revision this SDK resolves, so a redaction can be traced
  /// to the weights that produced it.
  @JS
  var modelRevision: String { RedactModel.revision }

  /// The Hugging Face repo the weights come from.
  @JS
  var modelRepo: String { RedactModel.repo }

  /// Every label this build can emit, in upstream's own declaration order.
  ///
  /// Read off `Label.allCases` rather than duplicated, so a category upstream
  /// adds appears here without a change. Order matters and is why this is
  /// `allCases` rather than a set: a label picker should not reshuffle between
  /// launches.
  ///
  /// A property rather than a function: a synchronous getter's `[String]` is
  /// encoded on the JavaScript thread, and an array of bare strings off an async
  /// call is precisely what crashed Ear.
  @JS
  var labels: [String] { PIILabel.allCases.map(\.rawValue) }

  /// The labels redacted when the caller names none.
  ///
  /// `Label.defaultEnabled` is a `Set`, whose iteration order is not stable, so
  /// it is filtered through `allCases` to come out in the same order as
  /// `labels`. The membership is upstream's; only the ordering is imposed here.
  @JS
  var defaultLabels: [String] {
    PIILabel.allCases.filter { PIILabel.defaultEnabled.contains($0) }.map(\.rawValue)
  }

  /// Label to human-readable name, e.g. `IP_ADDRESS` -> `IP address`.
  ///
  /// Read off `Label.displayName`, which exists in Swift and has no Kotlin
  /// equivalent -- `ai.desertant:redact`'s whole `Labels` object is two sets of
  /// bare strings. The Android half reports an empty map, and `Redact.displayName`
  /// in TypeScript refuses there rather than title-casing a slug: upstream's own
  /// names are "IMEI", "SSN", "Organisation" and "IP address", none of which a
  /// derivation would produce.
  ///
  /// A `[String: String]` from a synchronous property, which is the shape
  /// `Gist.defaultRollupOptions` and `Uhm.biasThresholds` already prove encodes.
  @JS
  var labelDisplayNames: [String: String] {
    Dictionary(uniqueKeysWithValues: PIILabel.allCases.map { ($0.rawValue, $0.displayName) })
  }

  /// The confidence floor a `redaction` uses when the caller does not say.
  ///
  /// Mirrored rather than read, and this is the one constant in this module that
  /// is: `minimumConfidence` is a default argument in `Options.init` rather than
  /// a constant the SDK exposes, so there is nothing to read off. Forwarded
  /// anyway so both platforms show one number -- upstream's published 88.8% /
  /// 99.6% is measured at this value.
  @JS
  var defaultMinimumConfidence: Double { 0.6 }

  // MARK: - Construction

  @JS
  func createModel(_ options: RedactLoadOptions) throws -> RedactModelObject {
    guard RedactModelObject.isSupported else {
      throw UnsupportedPlatformException("desert-ant-core ships no Redact artifact for this platform")
    }
    return RedactModelObject(directory: options.directory)
  }

  // MARK: - Work

  /// Download the weights and build the session.
  ///
  /// ~12 MB for the Core ML export, which is small enough that an app can
  /// reasonably do this on mount -- unlike Gist, Clips or Voz.
  @JS
  @JavaScriptActor
  func load(_ model: RedactModelObject, _ jobId: String) async throws {
    try await model.load(jobId: jobId)
  }

  /// Redact `text` and hold the result on the shared object under `jobId`.
  ///
  /// Returns nothing on purpose; `takeRedaction` hands the record over
  /// synchronously. See `RedactModelObject.redaction`.
  @JS
  @JavaScriptActor
  func redaction(
    _ model: RedactModelObject,
    _ text: String,
    _ options: RedactRedactionOptions,
    _ jobId: String
  ) async throws {
    try await model.redaction(text: text, options: options, jobId: jobId)
  }
}
