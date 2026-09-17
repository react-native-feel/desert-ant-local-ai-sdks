package ai.desertant.rn.emo

import expo.modules.kotlin.exception.CodedException

// The codes here are the ones `@desert-ant-labs/react-native-core` declares, and
// they match the Apple half one for one -- a caller branches on `error.code`
// without knowing which platform it is on.

class ModelUnavailableException(cause: String) :
  CodedException("ERR_MODEL_UNAVAILABLE", "The Emo weights are not on this device and could not be downloaded: $cause", null)

class ModelLoadFailedException(cause: String) :
  CodedException("ERR_MODEL_LOAD_FAILED", "Emo could not build a LiteRT session: $cause", null)

class InferenceFailedException(cause: String) :
  CodedException("ERR_INFERENCE_FAILED", "Emo failed to suggest emoji: $cause", null)

class InvalidArgumentException(detail: String) :
  CodedException("ERR_INVALID_ARGUMENT", detail, null)

class ReleasedException(what: String) :
  CodedException("ERR_RELEASED", "This $what was released and can no longer be used.", null)

class UnsupportedPlatformException(detail: String) :
  CodedException("ERR_UNSUPPORTED_PLATFORM", detail, null)
