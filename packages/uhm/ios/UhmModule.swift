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
    try await model.load(jobId: jobId)
  }

  /// Find the fillers in the audio (or video) file at `path`.
  ///
  /// The primary API. The audio never crosses the JS boundary, and what comes
  /// back is a handful of spans however long the recording is.
  @JS
  @JavaScriptActor
  func analyzeFile(
    _ model: UhmModelObject,
    _ path: String,
    _ options: UhmAnalyzeOptions,
    _ jobId: String
  ) async throws -> UhmResult {
    try await model.analyzeFile(path: path, options: options, jobId: jobId)
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
  ) async throws -> UhmResult {
    let mono = [Float](
      UnsafeBufferPointer(
        start: samples.rawPointer.assumingMemoryBound(to: Float.self),
        count: samples.length
      )
    )
    return try await model.analyzeSamples(
      mono, sampleRate: sampleRate, options: options, jobId: jobId)
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
