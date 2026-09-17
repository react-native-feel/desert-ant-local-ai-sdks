// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.
//
// Records nest here the way Gist's and Clips' do -- a `RedactRedaction` holds
// `[RedactItem]` -- which works because `Array: JavaScriptEncodable where
// Element: JavaScriptEncodable` and every `Record` is `JavaScriptEncodable`.
// What matters is *where* they are encoded: everything in this file is handed to
// JavaScript from a synchronous member, never returned from a `@JS async`
// function. See RedactModel.swift.

import DesertAnt
import ExpoModulesCore
import Redact

/// How a `RedactModel` finds its weights.
///
/// One field, where Gist has two: there is no variant to pick. `Catalog.swift`
/// declares a single artifact per platform -- `redact.mlmodelc` on Apple,
/// `redact.tflite` everywhere else -- so the only thing to say is where it lives.
@Record
struct RedactLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the weights itself points at the folder holding them. Nil uses the
  /// managed platform cache.
  var directory: String?
}

/// One `redaction` call's settings.
@Record
struct RedactRedactionOptions {
  /// Minimum confidence for **neural** detections. Upstream's own default is 0.6.
  ///
  /// The deterministic recognizers ignore it: `Deterministic.owned` spans are
  /// decided by a regex and a checksum and reported at 1.0, so raising this
  /// trims names and cities rather than cards and IBANs.
  var minimumConfidence: Double = 0.6

  /// The labels to redact, or an **empty array** meaning "upstream's default
  /// set" -- which is every label except `ORG`.
  ///
  /// A sentinel rather than an optional because `@Record` fields want a value,
  /// and because upstream's `Options.labels` already distinguishes nil (the
  /// default set) from a set that happens to be empty (redact nothing). The
  /// empty array maps onto nil, and the TypeScript side refuses `labels: []`
  /// before it gets here so the two cannot be confused.
  var labels: [String] = []

  func resolvedConfidence() throws -> Double {
    guard minimumConfidence.isFinite, minimumConfidence >= 0, minimumConfidence <= 1 else {
      throw InvalidConfidenceException(minimumConfidence)
    }
    return minimumConfidence
  }

  /// Into upstream's own enum, refusing a name it does not know.
  ///
  /// Upstream's cross-language binding uses `compactMap(Label.init(rawValue:))`,
  /// which drops an unknown name silently. That is the wrong behaviour for this
  /// option: dropping one name widens the redaction past what the caller asked
  /// for, and dropping all of them produces an empty set, which redacts nothing
  /// at all. Both are silent, and both are a privacy bug rather than a typo.
  func resolvedLabels() throws -> Set<PIILabel>? {
    guard !labels.isEmpty else { return nil }
    var resolved: Set<PIILabel> = []
    for name in labels {
      guard let label = PIILabel(rawValue: name) else { throw InvalidLabelException(name) }
      resolved.insert(label)
    }
    return resolved
  }
}

/// One detected entity and the placeholder standing in for it.
///
/// A `@Record` rather than a tuple or a dictionary because it is returned inside
/// an array, and an array of records encodes as a real array of real objects with
/// no per-entry boxing.
@Record
struct RedactItem {
  /// The category, e.g. `"EMAIL"`. `Label.rawValue` upstream, which is also what the
  /// placeholder is built from.
  var label: String = ""
  /// The original, sensitive text. This is the value the caller must keep on
  /// device.
  var original: String = ""
  /// The unique, restorable placeholder, e.g. `"[EMAIL_1]"`.
  var placeholder: String = ""
  /// `0...1`. Exactly 1 for a deterministic detection, which is a checksum
  /// rather than a score.
  var confidence: Double = 0
  /// UTF-16 code-unit offsets into the text that was passed in, so
  /// `text.slice(start, end) === original` in JavaScript with no conversion.
  ///
  /// Upstream's Swift type carries a `Range<String.Index>`, which does not cross
  /// a bridge; upstream's own FFI binding writes exactly these two offsets, and
  /// the Kotlin SDK's `RedactionItem` carries them directly. So this is the
  /// shape the other two platforms already agree on rather than a conversion
  /// invented here.
  var start: Int = 0
  var end: Int = 0
}

/// What a `redaction` produced.
@Record
struct RedactRedaction {
  /// The input with every entity replaced by its `[LABEL_N]` placeholder. The
  /// string that may leave the device.
  var redactedText: String = ""
  /// Every detection, in document order and non-overlapping.
  var items: [RedactItem] = []
  /// Wall clock around the whole call.
  var processingSec: Double = 0
  /// The pinned model revision this came from, so a benchmark or a telemetry
  /// event is self-identifying.
  var modelRevision: String?
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
///
/// `phase` is only ever `loadingModel`: upstream's `redaction(of:)` takes no
/// progress handler on either platform, so there is no detection fraction to
/// report and none is invented.
@Record
struct RedactProgressEvent {
  var jobId: String = ""
  var phase: String = ""
  var fraction: Double = 0
}

// MARK: - Mapping

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func redactRedaction(
  from redaction: Redaction,
  in text: String,
  processingSec: Double
) -> RedactRedaction {
  var record = RedactRedaction()
  record.redactedText = redaction.redactedText
  record.items = redaction.items.map { item in
    var entry = RedactItem()
    entry.label = item.label.rawValue
    entry.original = item.original
    entry.placeholder = item.placeholder
    entry.confidence = item.confidence
    entry.start = item.range.lowerBound.utf16Offset(in: text)
    entry.end = item.range.upperBound.utf16Offset(in: text)
    return entry
  }
  record.processingSec = processingSec
  record.modelRevision = RedactModel.revision
  return record
}

/// An untouched text: the answer for blank input, which never reaches the model.
func redactPassthrough(_ text: String) -> RedactRedaction {
  var record = RedactRedaction()
  record.redactedText = text
  record.modelRevision = RedactModel.revision
  return record
}
