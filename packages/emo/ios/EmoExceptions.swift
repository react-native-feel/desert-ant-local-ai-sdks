// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares -- the same set Clear, Voz,
// Clips and Uhm raise, so an app that handles one model's failures handles this
// one's without learning a second vocabulary.

import ExpoModulesCore

internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Emo weights are not on this device and could not be downloaded: \(param)"
  }
}

internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String { "Emo could not build a Core ML session: \(param)" }
}

internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Emo failed to suggest emoji: \(param)" }
}

internal final class InvalidLimitException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a limit. Expected a whole number of at least 1."
  }
}

internal final class InvalidSkinToneException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a skin tone. Expected 'default', 'light', 'mediumLight', 'medium', " +
      "'mediumDark' or 'dark'."
  }
}

internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { "This device cannot run Emo: \(param)" }
}

internal final class ReleasedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_RELEASED" }
  override var reason: String { "This \(param) was released and can no longer be used." }
}
