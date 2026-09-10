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
    try await model.download(jobId: jobId)
  }

  /// Build the session now, downloading first if needed. On the first-ever launch
  /// this is where the Core ML compile happens; call it behind a splash screen.
  @JS
  @JavaScriptActor
  func load(_ model: ClearModelObject, _ jobId: String) async throws {
    try await model.load(jobId: jobId)
  }

  /// Decode `inputPath`, enhance it, and write the result to `outputPath`.
  ///
  /// The primary API. It runs the Swift SDK's streaming path, so peak memory
  /// stays flat instead of growing with the file, and no audio crosses the JS
  /// boundary at all. The output encoding follows `outputPath`'s extension:
  /// `.wav` is 16-bit PCM, `.m4a`/`.mp4`/`.aac` is AAC, `.caf`/`.aiff` is PCM,
  /// anything else is WAV.
  @JS
  @JavaScriptActor
  func enhanceFile(
    _ model: ClearModelObject,
    _ inputPath: String,
    _ outputPath: String,
    _ options: ClearEnhanceOptions,
    _ jobId: String
  ) async throws -> ClearMetrics {
    try await model.enhanceFile(inputPath: inputPath, outputPath: outputPath,
                                options: options, jobId: jobId)
  }

  /// Enhance samples already in memory. Returns the metrics; the audio itself is
  /// collected with `takeEnhancedAudio`.
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
  /// So the object is built here on the JavaScript actor, parked on the model,
  /// and collected synchronously. `src/Clear.ts` does both in one
  /// `enhanceSamples`, so the public API never sees the seam.
  @JS
  @JavaScriptActor
  func enhanceBuffer(
    _ model: ClearModelObject,
    _ input: ClearAudioObject,
    _ options: ClearEnhanceOptions,
    _ jobId: String
  ) async throws -> ClearMetrics {
    // Read the input's samples here, on the JS actor, rather than inside the
    // worker: `[[Float]]` is Sendable and a shared object is not.
    let channels = input.channels
    let sampleRate = input.sampleRate
    let result = try await model.enhance(
      channels: channels, sampleRate: sampleRate, options: options, jobId: jobId)
    let audio = ClearAudioObject(result: result, variant: model.variant)
    model.stash(audio, for: jobId)
    let metrics = audio.enhancedMetrics
    return metrics
  }

  /// Collect the buffer `enhanceBuffer` produced for `jobId`. Synchronous, and
  /// callable exactly once per job.
  @JS
  func takeEnhancedAudio(_ model: ClearModelObject, _ jobId: String) throws -> ClearAudioObject {
    try model.takeStashed(jobId)
  }
}
