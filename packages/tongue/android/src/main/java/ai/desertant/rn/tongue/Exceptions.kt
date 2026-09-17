package ai.desertant.rn.tongue

import expo.modules.kotlin.exception.CodedException

// The codes here are the ones `@desert-ant-labs/react-native-core` declares, and
// they match the Apple half one for one -- a caller branches on `error.code`
// without knowing which platform it is on.

class ModelUnavailableException(cause: String) :
  CodedException("ERR_MODEL_UNAVAILABLE", "The bundled Tongue model could not be used: $cause", null)

class ModelLoadFailedException(cause: String) :
  CodedException("ERR_MODEL_LOAD_FAILED", "Tongue could not build its pipeline: $cause", null)

class InferenceFailedException(cause: String) :
  CodedException("ERR_INFERENCE_FAILED", "Tongue failed to identify a language: $cause", null)

class InvalidArgumentException(detail: String) :
  CodedException("ERR_INVALID_ARGUMENT", detail, null)

class ReleasedException(what: String) :
  CodedException("ERR_RELEASED", "This $what was released and can no longer be used.", null)

class UnsupportedPlatformException(detail: String) :
  CodedException("ERR_UNSUPPORTED_PLATFORM", detail, null)
