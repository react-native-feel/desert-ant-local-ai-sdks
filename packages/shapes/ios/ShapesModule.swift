// The module owns every asynchronous entry point, and the shared object owns only
// state and synchronous access to it.
//
// That split is not a style choice -- it is what the Expo Modules 2.0 macros in
// expo-modules-core 57 support, and it is the same split the other nine model
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
// instead of methods on it. `src/Shapes.ts` hides all of it.
//
// The third limit -- returning a `SharedObject` from a `@JS async` function kills
// the process -- does not reach this module: nothing here hands a Swift-allocated
// buffer back to JavaScript.
//
// The fourth does, and it is the one that shaped this file. **Every `@JS async`
// function below returns `Void`**, because an async return value can be encoded
// off the JavaScript thread and segfault the runtime. It has been reproduced in
// four packages -- Ear on `[String]`, Clear in `Record.encode`, Emo in
// `JavaScriptValuesBuffer.deinit` -- so it is a property of the toolchain rather
// than of any one result's size, and this model's result carries a `[Double]`,
// which is the same shape of value that took Ear down. The recognition comes back
// through the shared object's synchronous `takeRecognition`. See the long note on
// `ShapesModelObject.recognize`.

import DesertAnt
import ExpoModulesCore
import Foundation
import Shapes

@ExpoModule("DesertAntShapes", classes: [ShapesModelObject.self])
public final class ShapesModule: Module {
  /// Whether this build can run Shapes at all.
  ///
  /// Reads the catalog rather than answering `true`. The Android half answers the
  /// same question about the device's ABI; JavaScript's `Shapes.isSupported`
  /// reports `false` by a third route where the module is not there to ask at
  /// all.
  @JS
  var isSupported: Bool { ShapesModelObject.isSupported }

  /// Why `isSupported` is false, or `""` when it is true.
  ///
  /// Always `""` in practice on Apple -- `ShapesModel.files` lists `.apple` and
  /// the artifact imposes no floor above the pod's. The property exists because
  /// the Android half genuinely has something to say here, and one TypeScript
  /// file reads both.
  @JS
  var unsupportedReason: String {
    ShapesModelObject.isSupported
      ? ""
      : "desert-ant-core ships no Shapes artifact for this platform"
  }

  /// The desert-ant-core version this binary links against. Worth surfacing: a
  /// bug report that names it is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { ShapesModelObject.coreVersion }

  /// The pinned model revision this SDK resolves, so a recognition can be traced
  /// to the weights that produced it.
  @JS
  var modelRevision: String { ShapesModel.revision }

  /// The Hugging Face repo the weights come from.
  @JS
  var modelRepo: String { ShapesModel.repo }

  /// The confidence floor a `recognize` uses when the caller does not say.
  ///
  /// Mirrored rather than read, like Redact's 0.6 and for the same reason:
  /// `minimumConfidence` is a default argument in `Options.init` rather than a
  /// constant either SDK exposes, so there is nothing to read off. Forwarded
  /// anyway so both platforms show one number.
  ///
  /// Zero means "apply only the model's own calibrated gates", which is what the
  /// classes were tuned with. It is a floor *on top of* those gates, so raising
  /// it can only reject more.
  @JS
  var defaultMinimumConfidence: Double { 0 }

  // Deliberately NOT exposed here: the list of shape classes.
  //
  // Every other model in this family reads its vocabulary off the binary --
  // `Label.allCases` for Redact, `Labels.ALL` on its Android half, `Gist.variants`,
  // `Uhm.fillerTypes` -- because duplicating a list in TypeScript is how a list
  // goes stale. Shapes cannot: upstream's `ShapeKind` is `internal` in
  // `Sources/Shapes/Shape.swift`, the public `Shape` is an enum with associated
  // values and so is not `CaseIterable`, and Kotlin's `Shape` is a sealed class
  // whose subclasses are not enumerable without reflection. There is no list on
  // either platform to read.
  //
  // Reporting a hardcoded one from here would look like it was read off the
  // binary while being exactly as stale as the TypeScript union, so it is left in
  // TypeScript where its provenance is visible. What keeps it honest instead is
  // the `switch` in `shapesRecognition(from:processingSec:)`: it is exhaustive
  // over a public enum with no `default`, so a sixth class upstream fails this
  // pod's build rather than silently going unreported.

  // MARK: - Construction

  @JS
  func createModel(_ options: ShapesLoadOptions) throws -> ShapesModelObject {
    guard ShapesModelObject.isSupported else {
      throw UnsupportedPlatformException("desert-ant-core ships no Shapes artifact for this platform")
    }
    return ShapesModelObject(directory: options.directory)
  }

  // MARK: - Work

  /// Download the weights and build the session.
  ///
  /// 0.2 MB for the Core ML export -- the smallest model in this family by a
  /// wide margin, a fiftieth of Emo and a four-hundredth of Uhm -- so there is
  /// nothing here for an app to ask permission about.
  @JS
  @JavaScriptActor
  func load(_ model: ShapesModelObject, _ jobId: String) async throws {
    try await model.load(jobId: jobId)
  }

  /// Recognize the stroke in `coordinates` and hold the result on the shared
  /// object under `jobId`.
  ///
  /// `coordinates` is a flat `[x, y, x, y, ...]` array rather than an array of
  /// point records. A stroke from a real canvas is hundreds of points and this is
  /// the one call in this family that a gesture stream can issue several times a
  /// second, so the cheapest thing that crosses is the right thing -- and it is
  /// the same layout upstream's own FFI binding uses between Kotlin and Swift.
  ///
  /// Returns nothing on purpose; `takeRecognition` hands the record over
  /// synchronously. See `ShapesModelObject.recognize`.
  @JS
  @JavaScriptActor
  func recognize(
    _ model: ShapesModelObject,
    _ coordinates: [Double],
    _ options: ShapesRecognizeOptions,
    _ jobId: String
  ) async throws {
    try await model.recognize(coordinates: coordinates, options: options, jobId: jobId)
  }
}
