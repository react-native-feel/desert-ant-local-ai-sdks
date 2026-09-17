// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares -- the same set Clear, Voz,
// Clips, Uhm and Emo raise, so an app that handles one model's failures handles
// this one's without learning a second vocabulary.

import ExpoModulesCore

internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Ear weights are not on this device and could not be downloaded: \(param)"
  }
}

internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String { "Ear could not build a Core ML session: \(param)" }
}

internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Ear failed to identify a language: \(param)" }
}

internal final class AudioDecodeFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_AUDIO_DECODE_FAILED" }
  override var reason: String { "Could not read or decode the input audio: \(param)" }
}

internal final class InvalidSamplesException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String { "Ear was given no usable audio: \(param)" }
}

internal final class InvalidWindowsException: GenericException<Int>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a window count. Expected a whole number of at least 1."
  }
}

internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { "This device cannot run Ear: \(param)" }
}

internal final class ReleasedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_RELEASED" }
  override var reason: String { "This \(param) was released and can no longer be used." }
}
