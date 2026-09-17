// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.

import DesertAnt
import Emo
import ExpoModulesCore

/// How an `EmoModel` finds its weights.
///
/// One field, and no `computeUnits` beside it -- unlike Uhm. That is upstream's
/// shape rather than an omission here: `Emo.init` takes `directory` alone, and
/// there is no compute-unit parameter to forward. The model is a ~5 MB two-stream
/// classifier, so the specialization a Core ML backend choice would trade against
/// is milliseconds either way.
@Record
struct EmoLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the weights itself points at the folder holding them. Nil uses the
  /// managed platform cache.
  var directory: String?
}

/// One `suggest` call's settings.
@Record
struct EmoSuggestOptions {
  var limit: Int = EmoSuggestOptions.defaultLimit
  var skinTone: String = "default"

  /// `limit: Int = 3` in `Emo.suggestions(for:limit:skinTone:)`.
  static let defaultLimit = 3

  /// The wire spelling of every tone, in the order the native enum declares them
  /// -- light to dark, with the toneless presentation first. `EmoModule` reports
  /// this to JavaScript, and `resolvedSkinTone()` below is the only thing that
  /// decodes it, so the list and the decoder cannot disagree.
  static let skinToneNames = [
    "default", "light", "mediumLight", "medium", "mediumDark", "dark",
  ]

  func resolvedLimit() throws -> Int {
    guard limit >= 1 else {
      throw InvalidLimitException(String(limit))
    }
    return limit
  }

  func resolvedSkinTone() throws -> EmojiSkinTone {
    switch skinTone {
    case "default": return .default
    case "light": return .light
    case "mediumLight": return .mediumLight
    case "medium": return .medium
    case "mediumDark": return .mediumDark
    case "dark": return .dark
    default: throw InvalidSkinToneException(skinTone)
    }
  }
}

/// One suggested emoji.
///
/// A `@Record` rather than a tuple or a dictionary because it is returned inside
/// an array: `Array` is `JavaScriptEncodable` where its `Element` is, and every
/// `Record` is, so `[EmoSuggestionRecord]` encodes as a real array of real
/// objects with no per-suggestion dictionary boxing.
///
/// Upstream's `EmoSuggestion` also carries an `id`, which is the emoji itself --
/// a `SwiftUI.Identifiable` conformance rather than data. It is dropped here
/// rather than forwarded: a JavaScript caller keying a list already has `emoji`,
/// and a second field holding the same string is a second thing to keep true.
@Record
struct EmoSuggestionRecord {
  var emoji: String = ""
  /// `0` to `1`. A softmax over the whole vocabulary, so it is a ranking score
  /// rather than a probability of being right.
  var confidence: Double = 0
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
@Record
struct EmoProgressEvent {
  var jobId: String = ""
  /// Always `loadingModel`: nothing else in this package takes long enough to
  /// report on.
  var phase: String = ""
  var fraction: Double = 0
}

// MARK: - Mapping

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func emoSuggestion(from suggestion: EmoSuggestion) -> EmoSuggestionRecord {
  var record = EmoSuggestionRecord()
  record.emoji = suggestion.emoji
  record.confidence = suggestion.confidence
  return record
}
