// Coded exceptions, so `DesertAntError.code` in JavaScript is a stable string a
// caller can branch on rather than a message that is free to change. The codes
// are the ones `@desert-ant-labs/react-native-core` declares -- the same set
// Clear, Voz, Clips, Uhm, Emo, Ear, Tongue, Gist, Redact, Shapes and Align
// raise, so an app that handles one model's failures handles this one's without
// learning a second vocabulary.
//
// Two things are worth saying about the set below.
//
// The first is that `GenerationUnavailableException` is the one that fires today,
// on every call to `describe`, and it is an `ERR_UNSUPPORTED_PLATFORM` rather
// than an `ERR_MODEL_LOAD_FAILED`. That is the honest classification: nothing is
// missing from the device and nothing failed to load. The binary was built
// without the `MLX` package trait, so the generating half of the `Title` module
// was compiled out and there is no code here to run. A caller cannot fix it by
// downloading anything, which is what separates it from
// `ERR_MODEL_UNAVAILABLE`.
//
// The second is that `EmptyPassageException` and `InvalidMaxTokensException` are
// this SDK's refusals rather than upstream's. `Titles.describe` substitutes the
// caller's text into `{clip}` in a fixed prompt and generates; an empty passage
// produces a prompt asking for a title for nothing, which a small instruct model
// answers with a plausible invented one. `Titles.init` takes `maxTokens: Int =
// 96` and hands it to `GenerateParameters` unchecked, where zero caps the
// decode at no tokens and produces an empty card that is indistinguishable from
// a model that declined. Both are silent transformations of a bad argument into
// a confident-looking result, which is the failure mode this repo refuses on
// principle.

import ExpoModulesCore

/// The build cannot generate, because the `MLX` package trait is off.
internal final class GenerationUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { param }
}

/// The platform has no Title artifact at all (anything that is not Apple).
internal final class UnsupportedPlatformException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_UNSUPPORTED_PLATFORM" }
  override var reason: String { param }
}

/// The model folder is not on the device and could not be fetched.
internal final class ModelUnavailableException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_UNAVAILABLE" }
  override var reason: String {
    "The Title model folder is not on this device and could not be downloaded: \(param)"
  }
}

/// The files are present but a generator could not be built from them.
internal final class ModelLoadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String {
    "Title could not build an MLX generator from the model folder: \(param)"
  }
}

/// Generation ran and failed, or nothing is waiting for a job id.
internal final class InferenceFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INFERENCE_FAILED" }
  override var reason: String { "Title failed: \(param)" }
}

/// `describe` was called before the model folder was resolved.
internal final class NotLoadedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_MODEL_LOAD_FAILED" }
  override var reason: String {
    "\(param) needs a prepared model. Call `load()` (or `prepare()`) first."
  }
}

/// Nothing to write a title for.
internal final class EmptyPassageException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "Title needs a passage of text to title; got \(param). Upstream substitutes whatever it is "
      + "given into a fixed prompt, so an empty passage asks the model to name nothing and it "
      + "obliges with something invented."
  }
}

/// A token cap that is not a number of tokens.
internal final class InvalidMaxTokensException: GenericException<Int>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "`maxTokens` must be a positive number of tokens; got \(param). Upstream passes it straight "
      + "to `GenerateParameters`, where zero or less stops the decode before the first token and "
      + "returns an empty card rather than an error."
  }
}

/// A `directory` that is present but empty.
internal final class InvalidDirectoryException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "`directory` was \(param). Omit it to use the managed cache, or pass a real path."
  }
}
