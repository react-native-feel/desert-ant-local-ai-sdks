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
    try await model.load(jobId: jobId)
  }

  /// Select the best non-overlapping moments in a transcript, ranked best first.
  @JS
  @JavaScriptActor
  func findClips(
    _ model: ClipsModelObject,
    _ sentences: [ClipsSentence],
    _ options: ClipsFindOptions,
    _ jobId: String
  ) async throws -> [ClipsClip] {
    try await model.find(sentences: sentences, options: options, jobId: jobId)
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
