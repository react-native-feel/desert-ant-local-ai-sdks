import { toDesertAntError, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeRedact, {
  type NativeRedactModel,
  type NativeRedaction,
  type NativeRedactionOptions,
} from './native';
import {
  type Redaction,
  type RedactLabel,
  type RedactLoadOptions,
  type RedactionItem,
  type RedactionOptions,
} from './types';

const MODEL = 'redact';

/**
 * `Label.allCases` upstream, in declaration order, for the platforms where the
 * module is not there to ask.
 *
 * The binary's own list wins wherever there is a binary: a label upstream adds
 * appears in `Redact.labels` without a release here. This exists so a UI that
 * renders a label picker has something to render in Expo Go or on web.
 */
const FALLBACK_LABELS: RedactLabel[] = [
  'GIVEN_NAME',
  'SURNAME',
  'STREET_NAME',
  'BUILDING_NUMBER',
  'SECONDARY_ADDRESS',
  'CITY',
  'STATE',
  'ZIP_CODE',
  'EMAIL',
  'PHONE',
  'CREDIT_CARD',
  'BANK_ACCOUNT',
  'ROUTING_NUMBER',
  'IP_ADDRESS',
  'URL',
  'GOVERNMENT_ID',
  'PASSPORT',
  'DRIVERS_LICENSE',
  'TAX_ID',
  'SSN',
  'IMEI',
  'ORG',
];

/** `Label.defaultEnabled` upstream: everything but `ORG`, because a company is
 *  not a natural person. */
const FALLBACK_DEFAULT_LABELS: RedactLabel[] = FALLBACK_LABELS.filter((label) => label !== 'ORG');

/** `minimumConfidence: Double = 0.6` upstream, in a Swift initializer and a
 *  Kotlin data class. A default argument in both, so it is mirrored rather than
 *  read -- but still forwarded through the native module so the two platforms
 *  cannot show different numbers. */
const FALLBACK_MINIMUM_CONFIDENCE = 0.6;

let nextJobId = 0;

/**
 * On-device PII detection and reversible redaction: text in, the same text with
 * every name, address, email, card and national ID replaced by a unique
 * placeholder out -- plus the mapping needed to put the originals back
 * afterwards. 27 languages, no server call, nothing leaves the device.
 *
 * ```ts
 * if (!Redact.isSupported) return;
 * const redact = await Redact.load();                      // ~12 MB on iOS
 * const r = await redact.redaction('Email Anna at anna@example.com.');
 * r.redactedText;      // 'Email [GIVEN_NAME_1] at [EMAIL_1].'
 * r.items[0];          // { label: 'GIVEN_NAME', original: 'Anna', ... }
 *
 * const reply = await myLLM.rewrite(r.redactedText);       // sees no personal data
 * restore(r, reply);                                       // originals filled back in
 * ```
 *
 * It is a hybrid, and the two halves behave differently enough to be worth
 * knowing about. A six-layer multilingual BIOES token classifier (~23 M
 * parameters, XLM-R lineage) finds the contextual categories -- names, cities,
 * streets, organisations -- and is what {@link RedactionOptions.minimumConfidence}
 * tunes. In front of it, a deterministic layer of regexes and real checksums
 * (Luhn, ISO-13616 IBAN, ISO-7064, per-country national IDs) *owns* the
 * structured ones -- email, URL, IP, card, IBAN, SSN, routing number, tax id,
 * government id, passport, driving licence, IMEI -- and reports them at
 * confidence `1` whatever the threshold says.
 *
 * **What it is for.** Masking personal data before text is sent somewhere it
 * should not go: an LLM, a log, an analytics event, a crash report. The
 * round trip is the point -- {@link restore} puts the originals back into what
 * comes out -- and the mapping that makes it reversible never leaves the device.
 *
 * **What it is not.** It is not a guarantee. Upstream measures 88.8% recall and
 * 99.6% precision on its own benchmark, which is the best of the on-device field
 * it publishes and is still not 100%: treat a redaction as a large reduction in
 * exposure rather than as a promise that nothing got through.
 */
export class Redact {
  /**
   * Whether this build and this device can run Redact.
   *
   * Like Clear, Emo, Ear and Gist and unlike Voz, Clips and Uhm, this is not an
   * "Apple only" flag -- upstream ships a Core ML export *and* a LiteRT one, and
   * `ai.desertant:redact` is published. It is false in two narrower cases: an
   * Android device whose ABI LiteRT does not ship (`arm64-v8a` and `x86_64` are
   * the two it does), and any build where the native module is not present at
   * all, such as Expo Go or web.
   */
  static get isSupported(): boolean {
    return NativeRedact?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. On Android it names the ABIs the device actually reported, which is
   *  why it is computed natively rather than written here. */
  static get unsupportedReason(): string | null {
    if (Redact.isSupported) {
      return null;
    }
    const native = NativeRedact?.unsupportedReason;
    if (native) {
      return native;
    }
    return (
      'Redact is not available in this build. The native module did not load -- an Expo Go ' +
      'session or a web bundle, rather than a dev build with the package prebuilt in.'
    );
  }

  /** The desert-ant-core version the native binary links against, or null where
   *  the module is absent. */
  static get nativeCoreVersion(): string | null {
    return NativeRedact?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null where the module is
   *  absent. */
  static get modelRevision(): string | null {
    return NativeRedact?.modelRevision ?? null;
  }

  /** The Hugging Face repo the weights come from, or null where the module is
   *  absent. */
  static get modelRepo(): string | null {
    return NativeRedact?.modelRepo ?? null;
  }

  /**
   * Every label this build can emit, in upstream's own declaration order.
   *
   * Read off the binary (`Label.allCases` on Apple, `Labels.ALL` on Android)
   * rather than written here, so a category upstream adds arrives with the SDK
   * rather than with a release of this package. Gate a label picker on this.
   */
  static get labels(): RedactLabel[] {
    return reported(NativeRedact?.labels) ?? [...FALLBACK_LABELS];
  }

  /**
   * The labels redacted when {@link RedactionOptions.labels} is omitted: every
   * one except `ORG`.
   *
   * Read off upstream's own `Label.defaultEnabled` / `Labels.DEFAULT` rather
   * than computed here, so the day `ORG` stops being the exception -- or gains
   * company -- this reports it.
   */
  static get defaultLabels(): RedactLabel[] {
    return reported(NativeRedact?.defaultLabels) ?? [...FALLBACK_DEFAULT_LABELS];
  }

  /**
   * Label to human-readable name, for the platform this is running on.
   *
   * **Every label on iOS, and empty on Android.** `Label.displayName` is a Swift
   * computed property; `ai.desertant:redact` publishes nothing equivalent -- its
   * whole `Labels` object is two sets of bare strings. Reported as the map it is
   * rather than hidden behind a flag, so a UI gates on what is present:
   *
   * ```ts
   * const title = Redact.labelDisplayNames[item.label] ?? item.label;
   * ```
   *
   * Never derived. Title-casing `DRIVERS_LICENSE` into "Drivers License" would
   * be right until it met `IMEI`, `SSN`, `ORG` or `IP_ADDRESS`, whose upstream
   * names are "IMEI", "SSN", "Organisation" and "IP address" -- so
   * {@link displayName} refuses rather than inventing one.
   */
  static get labelDisplayNames(): Record<string, string> {
    const native = NativeRedact?.labelDisplayNames;
    if (!native || typeof native !== 'object') {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [label, name] of Object.entries(native)) {
      if (typeof name === 'string' && name.length > 0) {
        out[label] = name;
      }
    }
    return out;
  }

  /**
   * The human-readable name for one label, e.g. `'IP_ADDRESS'` -> `'IP address'`.
   *
   * Throws `ERR_UNSUPPORTED_PLATFORM` where the platform's SDK has no display
   * names -- Android today -- rather than returning a derived one. A slug
   * title-cased into a label is a string that looks right until upstream renames
   * a category or meets an acronym, and a wrong display name is invisible in
   * exactly the place it matters, which is a privacy UI telling someone what was
   * masked. Use {@link labelDisplayNames} to branch, or fall back to the label
   * itself, which is always meaningful.
   *
   * Throws `ERR_INVALID_ARGUMENT` for a label this build does not have.
   */
  static displayName(label: RedactLabel): string {
    const names = Redact.labelDisplayNames;
    if (Object.keys(names).length === 0) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            'This platform has no Redact display names. `Label.displayName` is a Swift ' +
              'computed property and ai.desertant:redact publishes no equivalent, so Android ' +
              'reports none. Read `Redact.labelDisplayNames` and fall back to the label itself.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    const name = names[label];
    if (!name) {
      throw invalid(
        `'${String(label)}' is not a Redact label here; expected one of ${Redact.labels.join(', ')}`
      );
    }
    return name;
  }

  /**
   * The confidence floor a `redaction` uses when the caller does not say: `0.6`.
   *
   * Mirrored from upstream rather than read off it, because on both platforms it
   * is a default argument rather than a constant the SDK exposes. It is
   * forwarded through the native module anyway so the two platforms cannot show
   * different numbers -- and upstream's published 88.8% / 99.6% is measured at
   * this value.
   *
   * It applies to the neural detections only; see
   * {@link RedactionOptions.minimumConfidence}.
   */
  static get defaultMinimumConfidence(): number {
    const native = NativeRedact?.defaultMinimumConfidence;
    return typeof native === 'number' && native >= 0 && native <= 1
      ? native
      : FALLBACK_MINIMUM_CONFIDENCE;
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then build the session. Resolves when the next `redaction` will not have to
   * wait for either.
   *
   * ~12 MB on Apple and ~25 MB on Android -- the two exports are genuinely
   * different sizes -- which puts this among the models that can load on mount
   * rather than behind a tap.
   */
  static async load(options: RedactLoadOptions = {}): Promise<Redact> {
    const redact = Redact.create(options);
    try {
      await redact.warm(options.onProgress);
      return redact;
    } catch (error) {
      redact.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `redaction`, which is then as slow as a download.
   *
   * Cheap enough to do purely to ask {@link isDownloaded}, which is how an app
   * decides whether to offer the download or just do it.
   */
  static create(options: RedactLoadOptions = {}): Redact {
    const native = Redact.requireNative();
    try {
      return new Redact(native.createModel({ directory: options.directory }));
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeRedact> {
    if (!NativeRedact) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Redact.unsupportedReason ??
              'Redact is not available here. Gate the feature on `Redact.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeRedact;
  }

  private released = false;

  private constructor(private readonly native: NativeRedactModel) {}

  /** Whether the weights are on the device, so redaction needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download the weights and build the session, so the first `redaction` pays
   * neither.
   *
   * Identical to {@link download} -- upstream exposes one call that does both, so
   * unlike Clear and Voz there is no download-only step to run separately. Both
   * names exist so every model in this repo reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Redact.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. See its note. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Find the personal data in `text` and replace each entity with a unique
   * placeholder.
   *
   * ```ts
   * const r = await redact.redaction('Call Anna Kovács on +36 1 234 5678.');
   * r.redactedText;   // 'Call [GIVEN_NAME_1] [SURNAME_1] on [PHONE_1].'
   * r.items.map((i) => i.label);   // ['GIVEN_NAME', 'SURNAME', 'PHONE']
   * ```
   *
   * Items come back in document order and never overlap, so
   * `text.slice(item.start, item.end) === item.original` for every one of them
   * and the spans can be highlighted in place.
   *
   * Blank or whitespace-only text comes back unchanged with no items and **does
   * not load the model** -- so a text field wired straight to this costs nothing
   * while it is empty, on a device that has never downloaded the weights.
   */
  async redaction(text: string, options: RedactionOptions = {}): Promise<Redaction> {
    this.assertAlive();
    if (typeof text !== 'string') {
      throw invalid('redaction needs a string of text');
    }
    const native = toNativeOptions(options);
    // Two calls rather than one, and not for caching: the async half returns
    // nothing and the record is read back synchronously, because a `@JS async`
    // function's return value can be encoded off the JavaScript thread and
    // segfault the runtime. ios/RedactModel.swift carries the full account.
    return this.run(options.onProgress, async (jobId) => {
      await Redact.requireNative().redaction(this.native, text, native, jobId);
      return toRedaction(this.native.takeRedaction(jobId));
    });
  }

  /**
   * Release the model. Calling it twice is a no-op; using the instance
   * afterwards throws `ERR_RELEASED`.
   */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.native.release();
  }

  /**
   * Run one native call with a progress subscription scoped to it. Every native
   * entry point takes a job id, so concurrent calls on one model stay
   * distinguishable on the single `progress` event -- and so two of them cannot
   * take each other's stored result.
   */
  private async run<T>(
    onProgress: ((event: ProgressEvent) => void) | undefined,
    call: (jobId: string) => Promise<T>
  ): Promise<T> {
    nextJobId += 1;
    const jobId = `redact-${nextJobId}`;
    const subscription = onProgress
      ? this.native.addListener('progress', (event: ProgressEvent) => {
          if (event.jobId === jobId) {
            onProgress(event);
          }
        })
      : undefined;
    try {
      return await call(jobId);
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    } finally {
      subscription?.remove();
    }
  }

  private assertAlive(): void {
    if (this.released) {
      throw toDesertAntError(
        Object.assign(new Error('This Redact was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

/** Validate the per-call options and flatten them for the wire. */
function toNativeOptions(options: RedactionOptions): NativeRedactionOptions {
  const minimumConfidence = options.minimumConfidence ?? Redact.defaultMinimumConfidence;
  if (
    typeof minimumConfidence !== 'number' ||
    !Number.isFinite(minimumConfidence) ||
    minimumConfidence < 0 ||
    minimumConfidence > 1
  ) {
    throw invalid(
      `'${String(options.minimumConfidence)}' is not a confidence; expected a probability in 0..1`
    );
  }
  const labels = options.labels;
  if (labels === undefined) {
    // The wire's "use the model's own default set".
    return { minimumConfidence, labels: [] };
  }
  if (!Array.isArray(labels)) {
    throw invalid('`labels` needs an array of Redact labels, or nothing for the default set');
  }
  if (labels.length === 0) {
    throw invalid(
      'an empty `labels` array would redact nothing; omit the option for the default set, ' +
        `which is ${Redact.defaultLabels.join(', ')}`
    );
  }
  const available = Redact.labels;
  for (const label of labels) {
    // Checked against the binary's list, not just against the TypeScript union:
    // upstream's binding drops a name it does not recognise, so an unvalidated
    // typo silently widens the redaction and a set of nothing but typos silently
    // redacts nothing at all.
    if (typeof label !== 'string' || !available.includes(label)) {
      throw invalid(
        `'${String(label)}' is not a Redact label; expected one of ${available.join(', ')}`
      );
    }
  }
  return { minimumConfidence, labels: [...labels] };
}

/** Shape a native redaction for the caller. */
function toRedaction(native: NativeRedaction): Redaction {
  const items: RedactionItem[] = native.items.map((item) => ({
    label: item.label as RedactLabel,
    original: item.original,
    placeholder: item.placeholder,
    confidence: item.confidence,
    start: item.start,
    end: item.end,
  }));
  return {
    redactedText: native.redactedText,
    items,
    processingSec: native.processingSec,
    modelRevision: native.modelRevision ?? null,
  };
}

/**
 * A label list the native binary reported, or null when there is nothing to
 * read.
 *
 * Deliberately **not** filtered against {@link FALLBACK_LABELS}. The union in
 * `types.ts` is an editor convenience; the binary is the authority, and a
 * category upstream adds should show up in a picker and be accepted by
 * `labels:` on the day the native SDK ships it rather than on the day this
 * package is released. The cast is the honest cost of that: for one release
 * cycle a new label is a string the union does not name.
 */
function reported(value: unknown): RedactLabel[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const labels = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return labels.length > 0 ? (labels as RedactLabel[]) : null;
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
