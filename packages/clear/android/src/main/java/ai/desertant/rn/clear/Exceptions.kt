package ai.desertant.rn.clear

import expo.modules.kotlin.exception.CodedException

// The codes here are the ones `@desert-ant-labs/react-native-core` declares, and
// they match the Apple half one for one -- a caller branches on `error.code`
// without knowing which platform it is on.

class ModelUnavailableException(cause: String) :
  CodedException("ERR_MODEL_UNAVAILABLE", "The Clear weights are not on this device and could not be downloaded: $cause", null)

class ModelLoadFailedException(cause: String) :
  CodedException("ERR_MODEL_LOAD_FAILED", "Clear could not build a LiteRT session: $cause", null)

class InferenceFailedException(cause: String) :
  CodedException("ERR_INFERENCE_FAILED", "Clear failed to enhance the audio: $cause", null)

class AudioDecodeFailedException(cause: String) :
  CodedException("ERR_AUDIO_DECODE_FAILED", "Could not read or decode the input audio: $cause", null)

class AudioEncodeFailedException(cause: String) :
  CodedException("ERR_AUDIO_ENCODE_FAILED", "Could not encode or write the output audio: $cause", null)

class InvalidArgumentException(detail: String) :
  CodedException("ERR_INVALID_ARGUMENT", detail, null)

class ReleasedException(what: String) :
  CodedException("ERR_RELEASED", "This $what was released and can no longer be used.", null)

class UnsupportedPlatformException(detail: String) :
  CodedException("ERR_UNSUPPORTED_PLATFORM", detail, null)
