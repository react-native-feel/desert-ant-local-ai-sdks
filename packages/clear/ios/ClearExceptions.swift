// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares.

import ExpoModulesCore

internal final class ModelUnavailableException: GenericException<String> {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Clear weights are not on this device and could not be downloaded: \(param)"
  }
}

internal final class ModelLoadFailedException: GenericException<String> {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String { "Clear could not build a Core ML session: \(param)" }
}

internal final class InferenceFailedException: GenericException<String> {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Clear failed to enhance the audio: \(param)" }
}

internal final class AudioDecodeFailedException: GenericException<String> {
  override var code: String { "ERR_AUDIO_DECODE_FAILED" }
  override var reason: String { "Could not read or decode the input audio: \(param)" }
}

internal final class InvalidVariantException: GenericException<String> {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a Clear variant. Expected 'clear-studio' or 'clear-natural'."
  }
}

internal final class InvalidChannelModeException: GenericException<String> {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String { "'\(param)' is not a channel mode. Expected 'mono' or 'preserve'." }
}

internal final class ChannelOutOfRangeException: GenericException<(Int, Int)> {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String { "Channel \(param.0) is out of range; the buffer has \(param.1)." }
}

internal final class FrameCountMismatchException: GenericException<(Int, Int)> {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "The Float32Array holds \(param.0) samples but the buffer's channel holds \(param.1). "
      + "Allocate it with the buffer's `frameCount`."
  }
}

internal final class ReleasedException: GenericException<String> {
  override var code: String { "ERR_RELEASED" }
  override var reason: String { "This \(param) was released and can no longer be used." }
}

internal final class MissingOutputException: GenericException<String> {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "No enhanced audio is waiting for job '\(param)'." }
}

internal final class AudioEncodeFailedException: GenericException<String> {
  override var code: String { "ERR_AUDIO_ENCODE_FAILED" }
  override var reason: String { "Could not write the enhanced audio: \(param)" }
}
