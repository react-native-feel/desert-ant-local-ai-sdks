// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares -- the same set Clear, Voz,
// Clips, Uhm, Emo, Ear, Tongue, Gist, Redact and Shapes raise, so an app that
// handles one model's failures handles this one's without learning a second
// vocabulary.
//
// Two of these are Align's own, and both exist because the thing they refuse is
// silent upstream rather than loud:
//
//   * `UnrefinedLocaleException` -- a locale the refiner has no language id for
//     makes `SpeechTimestampRefiner.refine` a *passthrough*. It returns Apple's
//     own timestamps, unchanged, with no error and no flag on the call. An app
//     that asked for `en_GB` and typo'd `eng_GB` would ship Apple's 106 ms mean
//     error believing it had bought 20 ms.
//   * `SpeechAssetsUnavailableException` -- Apple's on-device speech model for a
//     locale is a separate download from Align's weights, managed by
//     `AssetInventory` rather than by desert-ant-core. Without it there is no
//     transcript to refine, and the failure is neither Align's weights nor the
//     audio.

import ExpoModulesCore

internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Align weights are not on this device and could not be downloaded: \(param)"
  }
}

internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String {
    "Align could not build its Core ML cascade: \(param)"
  }
}

internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Align failed to refine the transcript: \(param)" }
}

internal final class AudioDecodeFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_AUDIO_DECODE_FAILED" }
  override var reason: String { "Could not read or decode the input audio: \(param)" }
}

/// Apple's speech assets for this locale are not installed and could not be.
///
/// `ERR_MODEL_UNAVAILABLE` rather than a code of its own: from a caller's side it
/// is the same situation as missing weights -- something the device needs is not
/// here and a retry with a network may fix it -- and inventing an eleventh code
/// for the second of two downloads would make every app's error switch longer
/// without making any of them more capable.
internal final class SpeechAssetsUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "Apple's on-device speech model could not be installed: \(param). Align refines "
      + "SpeechAnalyzer's timestamps, so it needs Apple's recognizer for the locale as well "
      + "as its own 0.7 MB of weights."
  }
}

internal final class InvalidLocaleException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a locale identifier Align can use. Expected something like "
      + "'en-US', 'es-ES' or 'ja-JP'."
  }
}

/// The locale parses and Apple may well transcribe it, but Align's config has no
/// language id for it, so refinement would be a silent no-op.
internal final class UnrefinedLocaleException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "Align does not refine \(param). `SpeechTimestampRefiner.refine` is a passthrough for a "
      + "language it was not trained on -- it returns Apple's own timestamps unchanged -- so "
      + "this is refused rather than answered. Pass `allowUnrefined: true` to transcribe with "
      + "Apple's timestamps anyway, and read `languageRefined` on the result."
  }
}

internal final class InvalidBufferSecondsException: GenericException<Double>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a buffer length. Expected a finite number of seconds greater than zero."
  }
}

internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { "This device cannot run Align: \(param)" }
}

internal final class NotLoadedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "Align has not resolved its weights yet, so \(param) has nothing to read. Call `load()` first."
  }
}
