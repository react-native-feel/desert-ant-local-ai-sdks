// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.

import ExpoModulesCore

// The records themselves name no upstream type, so they compile whether or not
// the `Tongue` module is linked. The *mapping* at the bottom of this file does,
// and is guarded -- see ios/TongueModule.swift for why that guard exists.
#if canImport(Tongue)
import DesertAnt
import Tongue
#endif

/// One `detect` call's settings.
///
/// The whole of it. There is no `directory` load options record beside this one,
/// unlike every other model here: `Tongue()` reads the weights bundled in the
/// package and takes no arguments, so there is nothing for a caller to point at.
@Record
struct TongueDetectOptions {
  /// How many candidates to rank. Defaults to upstream's own 3.
  var topK: Int = 3

  func resolvedTopK() throws -> Int {
    guard topK >= 1 else { throw InvalidTopKException(topK) }
    return topK
  }
}

/// One candidate language and its probability.
///
/// A `@Record` rather than a tuple or a dictionary because it is returned inside
/// an array: `Array` is `JavaScriptEncodable` where its `Element` is, and every
/// `Record` is, so `[TongueCandidate]` encodes as a real array of real objects
/// with no per-candidate dictionary boxing.
@Record
struct TongueCandidate {
  /// ISO 639-1 where one exists, otherwise 639-3.
  var language: String = ""
  var probability: Double = 0
}

/// What the script router decided, before the head ran.
///
/// Forwarded rather than hidden because it is the best available explanation of
/// an answer: a `decisive` route means the text was in a script only one language
/// uses and the model was never consulted, which is why such answers come back at
/// probability 1 and `confident` however short they are.
@Record
struct TongueRoute {
  /// `decisive`, `narrowing` or `ambiguous` -- the Swift enum's own rawValue, so
  /// the wire spelling and the TypeScript union cannot drift from it.
  var verdict: String = "ambiguous"
  /// The languages the router allowed through.
  var candidates: [String] = []
  /// The UAX#24 script name, or nil when nothing in the text was scripted.
  var script: String?
}

/// What the detector read.
///
/// `language` and `isTooCloseToCall` are computed properties on the Swift
/// `Detection` and flattened into stored fields here, because a `@Record` field is
/// a stored property. Flattening rather than making JavaScript re-derive them is
/// the point: `isTooCloseToCall` is a calibrated threshold, and a second
/// implementation of it in TypeScript would be free to drift from this one.
///
/// `confidence` is the one renaming. Upstream calls it `probability` and only
/// ever on a `Prediction`; the flattened top-level field is called `confidence`
/// here so that a caller reading `Detection` from this package and from
/// `react-native-ear` is reading the same field name for the same thing.
@Record
struct TongueDetection {
  /// The detected language, or nil when normalization left nothing to look at.
  var language: String?
  /// `language`'s probability, `0...1`.
  var confidence: Double = 0
  /// `confident`, `likely`, `tentative` or `empty` -- the Swift enum's rawValue.
  var reliability: String = "empty"
  /// Whether the top two candidates are within 0.12 of each other.
  var isTooCloseToCall: Bool = false
  /// Every candidate, most likely first.
  var candidates: [TongueCandidate] = []
  /// The text the model actually saw. See `Normalizer`.
  var normalized: String = ""
  /// What the router decided first.
  var route: TongueRoute = TongueRoute()
  /// Wall clock around the detection alone. Tens of microseconds, so expect a
  /// number with four leading zeros.
  var processingSec: Double = 0
  /// The pinned model revision this came from, so a benchmark or a telemetry
  /// event is self-identifying.
  var modelRevision: String?
}

// MARK: - Mapping

#if canImport(Tongue)

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func tongueDetection(from detection: Detection, processingSec: Double) -> TongueDetection {
  var record = TongueDetection()
  record.candidates = detection.candidates.map { prediction in
    var candidate = TongueCandidate()
    candidate.language = prediction.language
    candidate.probability = prediction.probability
    return candidate
  }
  record.language = detection.language
  record.confidence = detection.candidates.first?.probability ?? 0
  record.reliability = detection.reliability.rawValue
  record.isTooCloseToCall = detection.isTooCloseToCall
  record.normalized = detection.normalized

  var route: TongueRoute = TongueRoute()
  route.verdict = detection.route.verdict.rawValue
  route.candidates = detection.route.candidates
  route.script = detection.route.script?.rawValue
  record.route = route

  record.processingSec = processingSec
  record.modelRevision = TongueModel.revision
  return record
}
#endif
