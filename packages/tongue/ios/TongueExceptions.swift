// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares -- the same set Clear, Voz,
// Clips, Uhm, Emo and Ear raise, so an app that handles one model's failures
// handles this one's without learning a second vocabulary.
//
// Two of the family's codes never appear here, and their absence is the shape of
// this model: there is no `ERR_MODEL_UNAVAILABLE` for a failed *download*
// (nothing downloads) and no `ERR_AUDIO_DECODE_FAILED` (nothing is audio).
// `ERR_MODEL_UNAVAILABLE` is reused for the one thing that can genuinely be
// missing -- the bundled resources, if a build dropped them.

import ExpoModulesCore

internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String { "The bundled Tongue model could not be used: \(param)" }
}

internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String { "Tongue could not build its pipeline: \(param)" }
}

internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Tongue failed to identify a language: \(param)" }
}

internal final class InvalidTopKException: GenericException<Int>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a candidate count. Expected a whole number of at least 1."
  }
}

internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { "This device cannot run Tongue: \(param)" }
}

internal final class ReleasedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_RELEASED" }
  override var reason: String { "This \(param) was released and can no longer be used." }
}
