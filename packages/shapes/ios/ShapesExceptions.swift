// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares -- the same set Clear, Voz,
// Clips, Uhm, Emo, Ear, Tongue, Gist and Redact raise, so an app that handles one
// model's failures handles this one's without learning a second vocabulary.
//
// There is no audio code here, as with Emo, Tongue, Gist and Redact: Shapes'
// input is a list of numbers, so nothing can fail to decode. What replaces it is
// `InvalidStrokeException`, which is this model's equivalent worry -- a stroke is
// the one input in this family that arrives as raw geometry, and geometry has a
// silent failure mode that a string does not.

import ExpoModulesCore

internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Shapes weights are not on this device and could not be downloaded: \(param)"
  }
}

internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String { "Shapes could not build a Core ML session: \(param)" }
}

internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Shapes failed to recognize the stroke: \(param)" }
}

internal final class InvalidConfidenceException: GenericException<Double>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a confidence. Expected a probability in 0...1."
  }
}

/// Raised for a stroke that is not a stroke: an odd number of coordinates, or a
/// coordinate that is not a finite number.
///
/// This exists because upstream is silent about both, and silence is the wrong
/// answer for this input. A `NaN` coordinate is not rejected anywhere in
/// `StrokePreprocessor` -- the dedupe test is `abs(dx) > epsilon`, which is
/// `false` for `NaN`, so a poisoned point is dropped rather than caught, and the
/// features that survive it feed a classifier that returns *a* shape with
/// `NaN` geometry. A caller drawing from a gesture stream that briefly reported
/// no location gets a confident answer made of nothing. So it is refused here,
/// on both platforms, and in TypeScript before either.
internal final class InvalidStrokeException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String { "This is not a stroke: \(param)" }
}

internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { "This device cannot run Shapes: \(param)" }
}

internal final class ReleasedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_RELEASED" }
  override var reason: String { "This \(param) was released and can no longer be used." }
}
