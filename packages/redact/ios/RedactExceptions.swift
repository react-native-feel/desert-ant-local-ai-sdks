// Coded exceptions, so `DesertAntError.code` in JS is a stable string a caller
// can branch on rather than a message that is free to change. The codes are the
// ones `@desert-ant-labs/react-native-core` declares -- the same set Clear, Voz,
// Clips, Uhm, Emo, Ear, Tongue and Gist raise, so an app that handles one
// model's failures handles this one's without learning a second vocabulary.
//
// There is no audio code here, as with Emo, Tongue and Gist: Redact's input is a
// string, so nothing can fail to decode.

import ExpoModulesCore
// For `PIILabel` -- Redact's own `Label`, aliased in RedactLabel.swift because
// SwiftUI has one too -- so the message a bad name produces lists what this
// binary actually has rather than a list retyped here.
import Redact

internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Redact weights are not on this device and could not be downloaded: \(param)"
  }
}

internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String { "Redact could not build a Core ML session: \(param)" }
}

internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Redact failed to detect the personal data in the text: \(param)" }
}

internal final class InvalidConfidenceException: GenericException<Double>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a confidence. Expected a probability in 0...1."
  }
}

/// Raised for a label name the binary does not have.
///
/// This exists because upstream's own binding is forgiving in a way that is
/// dangerous here: `Set(names.compactMap(Label.init(rawValue:)))` silently drops
/// a name it does not recognise, so a typo widens the redaction and a set of
/// nothing but typos redacts nothing at all. The TypeScript side refuses first;
/// this is the native half of the same refusal, for a caller that reached the
/// module some other way.
internal final class InvalidLabelException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "'\(param)' is not a Redact label. Expected one of \(PIILabel.allCases.map(\.rawValue).joined(separator: ", "))."
  }
}

internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { "This device cannot run Redact: \(param)" }
}

internal final class ReleasedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_RELEASED" }
  override var reason: String { "This \(param) was released and can no longer be used." }
}
