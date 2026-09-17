package ai.desertant.rn.shapes

import expo.modules.kotlin.exception.CodedException

// The codes here are the ones `@desert-ant-labs/react-native-core` declares, and
// they match the Apple half one for one -- a caller branches on `error.code`
// without knowing which platform it is on.
//
// There is no audio code in this file, as with Emo, Tongue, Gist and Redact:
// Shapes' input is a list of numbers, so nothing can fail to decode. What
// replaces it is `InvalidStrokeException`, for the failure mode geometry has and
// a string does not.

class ModelUnavailableException(cause: String) :
  CodedException("ERR_MODEL_UNAVAILABLE", "The Shapes weights are not on this device and could not be downloaded: $cause", null)

class ModelLoadFailedException(cause: String) :
  CodedException("ERR_MODEL_LOAD_FAILED", "Shapes could not build a LiteRT session: $cause", null)

class InferenceFailedException(cause: String) :
  CodedException("ERR_INFERENCE_FAILED", "Shapes failed to recognize the stroke: $cause", null)

class InvalidArgumentException(detail: String) :
  CodedException("ERR_INVALID_ARGUMENT", detail, null)

/**
 * Raised for a stroke that is not a stroke: an odd number of coordinates, or a
 * coordinate that is not a finite number.
 *
 * Neither upstream SDK checks. The Kotlin one writes the doubles straight onto
 * the FFI, and the Swift preprocessor on the other side drops a `NaN` rather than
 * rejecting it -- its duplicate test is `abs(dx) > epsilon`, which is false for
 * `NaN` -- so the stroke is classified anyway and the answer is a real shape whose
 * geometry is `NaN`. Refused here, as on the Apple half and in TypeScript above
 * both.
 */
class InvalidStrokeException(detail: String) :
  CodedException("ERR_INVALID_ARGUMENT", "This is not a stroke: $detail", null)

class ReleasedException(what: String) :
  CodedException("ERR_RELEASED", "This $what was released and can no longer be used.", null)

class UnsupportedPlatformException(detail: String) :
  CodedException("ERR_UNSUPPORTED_PLATFORM", detail, null)
