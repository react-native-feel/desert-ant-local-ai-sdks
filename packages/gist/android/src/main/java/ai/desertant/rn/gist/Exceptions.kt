package ai.desertant.rn.gist

import expo.modules.kotlin.exception.CodedException

// The codes here are the ones `@desert-ant-labs/react-native-core` declares, and
// they match the Apple half one for one -- a caller branches on `error.code`
// without knowing which platform it is on.
//
// There is no audio code in this file, which is the whole difference between this
// model and most of the family: Gist's input is a string, so nothing can fail to
// decode.

class ModelUnavailableException(cause: String) :
  CodedException("ERR_MODEL_UNAVAILABLE", "The Gist weights are not on this device and could not be downloaded: $cause", null)

class ModelLoadFailedException(cause: String) :
  CodedException("ERR_MODEL_LOAD_FAILED", "Gist could not build a LiteRT session: $cause", null)

class InferenceFailedException(cause: String) :
  CodedException("ERR_INFERENCE_FAILED", "Gist failed to tag the text: $cause", null)

class InvalidArgumentException(detail: String) :
  CodedException("ERR_INVALID_ARGUMENT", detail, null)

class ReleasedException(what: String) :
  CodedException("ERR_RELEASED", "This $what was released and can no longer be used.", null)

class UnsupportedPlatformException(detail: String) :
  CodedException("ERR_UNSUPPORTED_PLATFORM", detail, null)
