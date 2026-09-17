import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { ProgressEvent } from './types';

/**
 * The native surface. iOS and Android both.
 *
 * Redact is the fifth model in this repo with two working halves, after Clear,
 * Emo, Ear and Gist: `Sources/Redact/Catalog.swift` lists `.apple`, `.android`,
 * `.linux`, `.windows` and `.web`, and `ai.desertant:redact` is published. So
 * `isSupported` off Apple is a statement about the *device* rather than about
 * the catalog -- `ai.desertant:redact` loads `libRedactAndroid.so` through JNI
 * and LiteRT ships `arm64-v8a` and `x86_64`, so an ABI outside those has no
 * `.so` to load.
 *
 * `requireOptionalNativeModule` resolves to `null` rather than throwing where the
 * module was not built in (Expo Go, web, an app that installed the package
 * without prebuilding), so `Redact.isSupported` can answer honestly instead of
 * the import crashing.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Redact`.
 */

export interface NativeRedactLoadOptions {
  directory?: string;
}

export interface NativeRedactionOptions {
  /** Validated into `0..1` before it gets here. */
  minimumConfidence: number;
  /**
   * The labels to redact, or an **empty array** meaning "use the model's own
   * default set".
   *
   * A sentinel rather than an optional because `@Record` fields and Kotlin
   * `@Field`s both want a value, and an empty list cannot collide with a
   * selection a caller meant -- `Redact.ts` rejects `labels: []` before it gets
   * here precisely so that the empty array has exactly one meaning on the wire.
   */
  labels: string[];
}

export interface NativeRedactionItem {
  label: string;
  original: string;
  placeholder: string;
  confidence: number;
  /** UTF-16 code-unit offsets into the source text. */
  start: number;
  end: number;
}

export interface NativeRedaction {
  redactedText: string;
  items: NativeRedactionItem[];
  processingSec: number;
  modelRevision: string | null;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeRedactModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
  /**
   * Hand over the redaction computed for `jobId`, and forget it.
   *
   * **Synchronous, and that is load-bearing rather than a convenience.** A `@JS
   * async` function's return value can be encoded off the JavaScript thread,
   * which segfaults the runtime -- it took Ear down through `Array<String>`,
   * Clear through `Record.encode` and Emo through
   * `JavaScriptValuesBuffer.deinit`. A synchronous `@JS` member runs on the
   * JavaScript thread by construction, so the record is encoded where it has to
   * be. See `ios/RedactModel.swift`.
   *
   * It matters more here than almost anywhere else in this family: a redaction
   * carries three strings per detection, and a paragraph of contact details can
   * carry a dozen detections.
   *
   * Keyed by job id rather than a single slot, so two concurrent `redaction`
   * calls on one model cannot take each other's answer.
   *
   * Throws `ERR_INFERENCE_FAILED` if there is nothing stored for `jobId`, which
   * can only happen if it is called without a completed `redaction` for that id.
   */
  takeRedaction(jobId: string): NativeRedaction;
}

interface DesertAntRedactModule extends NativeModule {
  /** False where this build cannot run Redact. True on iOS; on Android, false on
   *  an ABI LiteRT does not ship. */
  readonly isSupported: boolean;
  /** Why `isSupported` is false, or `''` when it is true. Computed natively
   *  because only the Android half knows which ABIs the device reported. */
  readonly unsupportedReason: string;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The pinned model revision the SDK resolves. */
  readonly modelRevision: string;
  /** The Hugging Face repo the weights come from. */
  readonly modelRepo: string;
  /**
   * Every label this build can emit, in upstream's own declaration order.
   *
   * A **property**, not an async call, for the encoding reason on
   * `takeRedaction` -- an array of bare strings off an async call is precisely
   * what crashed Ear.
   */
  readonly labels: string[];
  /** The labels redacted when the caller names none: every one except `ORG`.
   *  Read off upstream's own set rather than filtered here, so the day `ORG`
   *  stops being the exception this reports it. */
  readonly defaultLabels: string[];
  /**
   * Label to human-readable name, e.g. `IP_ADDRESS` -> `IP address`.
   *
   * **Populated on iOS and empty on Android**, and that asymmetry is upstream's:
   * `Label.displayName` is a Swift computed property and `ai.desertant:redact`
   * publishes nothing equivalent -- its `Labels` object is two sets of bare
   * strings. Reported as a map rather than hidden behind a boolean so a UI gates
   * on what is actually here; `Redact.displayName` refuses loudly where it is
   * empty rather than inventing a title-cased slug.
   *
   * A `[String: String]` dictionary from a synchronous getter, which is the
   * shape `Gist.defaultRollupOptions` already proves encodes.
   */
  readonly labelDisplayNames: Record<string, string>;
  /**
   * The confidence floor a `redaction` uses when the caller does not say.
   *
   * Mirrored rather than read: it is `minimumConfidence: Double = 0.6` in a
   * Swift initializer and `val minimumConfidence: Double = 0.6` in a Kotlin data
   * class, and a default argument is not a constant either SDK exposes. Nothing
   * branches on it natively -- it is forwarded so the two platforms show the
   * same number.
   */
  readonly defaultMinimumConfidence: number;

  createModel(options: NativeRedactLoadOptions): NativeRedactModel;

  /** Download the weights and build the session. Upstream fuses the two. */
  load(model: NativeRedactModel, jobId: string): Promise<void>;

  /**
   * Redact `text` and store the result on the shared object under `jobId`,
   * returning nothing.
   *
   * The `Void` is the point: see {@link NativeRedactModel.takeRedaction}.
   */
  redaction(
    model: NativeRedactModel,
    text: string,
    options: NativeRedactionOptions,
    jobId: string
  ): Promise<void>;
}

export default requireOptionalNativeModule<DesertAntRedactModule>('DesertAntRedact');
