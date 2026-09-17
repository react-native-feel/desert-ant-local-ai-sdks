// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares -- the same set Clear, Voz,
// Clips, Uhm, Emo, Ear and Tongue raise, so an app that handles one model's
// failures handles this one's without learning a second vocabulary.
//
// There is no audio code here, and that is the whole difference between this
// model and most of the family: Gist's input is a string, so nothing can fail to
// decode.

import ExpoModulesCore

internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Gist weights are not on this device and could not be downloaded: \(param)"
  }
}

internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String { "Gist could not build a Core ML session: \(param)" }
}

internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Gist failed to tag the text: \(param)" }
}

internal final class InvalidTopKException: GenericException<Int>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a topic count. Expected a whole number of at least 1."
  }
}

internal final class InvalidThresholdException: GenericException<Double>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a threshold. Expected a probability in 0...1."
  }
}

internal final class InvalidVariantException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a Gist variant. Expected 'multilingual' or 'english'."
  }
}

internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { "This device cannot run Gist: \(param)" }
}

internal final class ReleasedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_RELEASED" }
  override var reason: String { "This \(param) was released and can no longer be used." }
}
