import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * A category of personal information Redact can detect.
 *
 * The string is upstream's own stable label -- `Label.rawValue` in Swift,
 * a member of `Labels.ALL` in Kotlin -- and it is what the placeholder is built
 * from: a `GIVEN_NAME` becomes `[GIVEN_NAME_1]`. Store the label, not the
 * display name.
 *
 * Twenty-two of them. Twenty are the neural head's public taxonomy, `IMEI` is
 * emitted by the deterministic layer alone, and {@link org} is the one that is
 * detected but **not redacted by default**.
 *
 * This union exists so an editor can complete a label and a typo is a type
 * error. It is not the authority: {@link Redact.labels} is, and it is read off
 * the native binary, so a label upstream adds appears there before it appears
 * here. Anything in this union that the binary does not report is rejected with
 * `ERR_INVALID_ARGUMENT` rather than silently ignored -- see
 * {@link RedactionOptions.labels}.
 */
export type RedactLabel =
  | 'GIVEN_NAME'
  | 'SURNAME'
  | 'STREET_NAME'
  | 'BUILDING_NUMBER'
  | 'SECONDARY_ADDRESS'
  | 'CITY'
  | 'STATE'
  | 'ZIP_CODE'
  | 'EMAIL'
  | 'PHONE'
  | 'CREDIT_CARD'
  | 'BANK_ACCOUNT'
  | 'ROUTING_NUMBER'
  | 'IP_ADDRESS'
  | 'URL'
  | 'GOVERNMENT_ID'
  | 'PASSPORT'
  | 'DRIVERS_LICENSE'
  | 'TAX_ID'
  | 'SSN'
  | 'IMEI'
  /**
   * An organisation or company name. **Not redacted by default** -- a company is
   * not a natural person. It is detected so that a company name is recognised as
   * one instead of being mislabelled `SURNAME`; opt in by naming it in
   * {@link RedactionOptions.labels}.
   */
  | 'ORG';

/** One detected entity and the placeholder standing in for it. */
export interface RedactionItem {
  /** The category, e.g. `'EMAIL'`. */
  label: RedactLabel;
  /** The original, sensitive text that was matched. This is the thing you are
   *  holding on device and must not send anywhere. */
  original: string;
  /** The unique, restorable placeholder, e.g. `'[EMAIL_1]'`. Bracket-delimited
   *  and numbered, so no placeholder is a prefix of another and
   *  {@link restore} is order-independent. */
  placeholder: string;
  /**
   * The model's confidence, `0` to `1`.
   *
   * **A deterministic detection always reports exactly `1` — but a `1` does not
   * mean a deterministic detection.** Email, URL, IP, card, IBAN, SSN, routing
   * number, tax id, government id, passport, driving licence and IMEI are owned
   * by a checksum-and-regex layer in front of the neural head rather than scored
   * by it, and upstream reports them as `1.0` on both platforms. The converse
   * fails in two ways, both observed: a saturated softmax rounds to exactly `1`
   * in a `Double`, and several of upstream's address post-processing stages build
   * their spans through `Span(start, end, label)`, whose `score` defaults to
   * `1.0`.
   *
   * So **the label is what says how something was found; the score never is.**
   * Do not branch on `confidence === 1` to decide whether something was
   * checksum-validated — and this package deliberately does not export the owned
   * label set to make that branch easy, because `Deterministic.owned` is
   * `internal` upstream and a copy here would be right until the next revision
   * moved a label across the line.
   *
   * What the score *is* good for is {@link RedactionOptions.minimumConfidence},
   * which filters the neural half and is what it was calibrated against.
   */
  confidence: number;
  /**
   * Where `original` starts in the text you passed in, as a **UTF-16 code-unit
   * offset** -- the same units JavaScript's `String.prototype.slice` uses, so
   * `text.slice(start, end) === original`.
   *
   * UTF-16 rather than bytes or characters because that is what both native SDKs
   * index in (`Redaction.Item.range` is converted from UTF-16 offsets in Swift,
   * and Kotlin reports the offsets directly), and because it is the one indexing
   * that needs no conversion on this side.
   */
  start: number;
  /** One past the last code unit of `original`. Exclusive. */
  end: number;
}

/** What a redaction produced: the safe text, and everything needed to undo it. */
export interface Redaction {
  /**
   * The input with each detected entity replaced by its `[LABEL_N]` placeholder.
   *
   * This is the string that may leave the device.
   */
  redactedText: string;
  /**
   * Every detection, in document order.
   *
   * This is the string that may **not**: `original` is the personal data. Keep
   * it on device, hand {@link redactedText} to whatever is doing the processing,
   * and put the originals back with {@link restore}.
   */
  items: RedactionItem[];
  /**
   * Wall-clock time the redaction took, in seconds.
   *
   * Measured around the call natively, so it excludes the bridge hop but
   * includes everything the model did. A first call on a cold model also pays
   * the download and the session build; a second does not.
   */
  processingSec: number;
  /** The published model revision this came from, so a benchmark or a telemetry
   *  event is self-identifying. */
  modelRevision: string | null;
}

/** How a `Redact` finds its weights. */
export interface RedactLoadOptions extends ModelLoadOptions {
  /**
   * Called while the model downloads and loads.
   *
   * Worth wiring less than Gist's or Voz's: the Apple artifact is ~12 MB and the
   * Android one ~25 MB, so this is one of the models that can reasonably load on
   * mount. It is still the only phase anything here reports -- see
   * {@link RedactProgressNote}.
   */
  onProgress?: (event: ProgressEvent) => void;
}

/** Tuning for one `redaction` call. Every field is per call: a model instance
 *  holds no settings, so two callers can ask one loaded model for different
 *  shapes of answer. */
export interface RedactionOptions {
  /**
   * Minimum confidence for **neural** detections, `0` to `1`. Defaults to
   * {@link Redact.defaultMinimumConfidence} (0.6).
   *
   * The deterministic recognizers are not affected by it: an email is an email
   * whatever this says, because a regex and a checksum decided it rather than a
   * score. So raising this trims names, cities and street names, not cards and
   * IBANs.
   *
   * Upstream *clamps* an out-of-range value into `0...1` and a non-finite one to
   * 0.6; this package rejects both with `ERR_INVALID_ARGUMENT` instead, because
   * a silently clamped threshold is a redaction policy that is not the one you
   * asked for.
   */
  minimumConfidence?: number;
  /**
   * Only redact these categories. Omit for {@link Redact.defaultLabels} --
   * every label except `ORG`.
   *
   * Validated against {@link Redact.labels} before it reaches native, and this
   * guard is not decoration. Upstream's binding resolves names with
   * `compactMap(Label.init(rawValue:))`, which **drops** a name it does not
   * recognise: a single typo silently widens the redaction, and a set of nothing
   * but typos silently redacts nothing at all. An empty array is rejected for
   * the same reason -- it means "redact nothing", which is never what someone
   * reaching for this option meant. Omit the option instead.
   */
  labels?: RedactLabel[];
  /** Called while the model downloads and loads. Redaction itself reports
   *  nothing -- see {@link RedactProgressNote}. */
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * A marker for the one thing this model does not report.
 *
 * `redaction` emits no progress of its own: upstream's `redaction(of:)` takes no
 * handler on either platform, unlike its `download`. So the only phase a
 * `Redact` ever emits is `loadingModel`, and it emits it from `warm`,
 * `download`, and the load the first `redaction` does implicitly. No phase was
 * added to `ModelPhase` in `packages/core` for this model, because upstream
 * reports none -- and the windowed pass over a paragraph is milliseconds, which
 * is not something a progress bar can usefully show anyway.
 */
export type RedactProgressNote = never;

export type { ModelPhase, ProgressEvent };
