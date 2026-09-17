import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { AlignedTranscript, ProgressEvent } from './types';

/**
 * The native surface. Apple only, and iOS 26 at that.
 *
 * Two separate limits stacked, both upstream's rather than this package's choice:
 *
 *   * `Sources/Align/Catalog.swift` declares files for `.apple` and nothing else,
 *     and `Package.swift` says why in as many words -- "Align is Apple-only (Core
 *     ML, Speech, AVFoundation), so it lives outside the `models` list: it gets
 *     no Android/Node/Web products and no NativeBindings." Upstream's manifest
 *     records its Kotlin and JS SDKs as `none`.
 *   * Within Apple, iOS 26. Not because the artifacts need it -- the catalog
 *     declares no `osFloor`, so they inherit iOS 16 -- but because the only
 *     *public* way to hand `SpeechTimestampRefiner` a transcript is
 *     `refine(_ result: SpeechTranscriber.Result)`, and `SpeechAnalyzer` is iOS
 *     26. The two overloads that take words and audio directly are `internal`.
 *
 * Hence `requireOptionalNativeModule`: off iOS this resolves to `null` at import
 * time instead of throwing, so an app can ship one bundle, check
 * `Align.isSupported`, and hide the feature. On an iOS older than 26 the module
 * *does* exist -- the pod builds at 17 -- and reports `isSupported: false` with a
 * reason, which is the second of the three routes to that answer.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Align`.
 */

export interface NativeAlignLoadOptions {
  directory?: string;
}

export interface NativeTranscribeOptions {
  /** Validated on both sides before it gets here. */
  locale: string;
  allowUnrefined: boolean;
  maxBufferedSeconds: number;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeAlignModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  /** Whether Align's own 0.7 MB is on the device. Says nothing about Apple's
   *  speech assets, which are a separate download. */
  isDownloaded(): boolean;
  /**
   * The language codes Align refines, read out of the downloaded
   * `refiner_config.json`.
   *
   * Empty before `load`, which is why it is a method on the model rather than a
   * property on the module: the list lives in a sidecar, so there is nothing to
   * answer with until the sidecar is on disk. Reading it there rather than
   * hardcoding nine strings is the same policy as `Gist.variants` and
   * `Uhm.fillerTypes`.
   */
  supportedLanguages(): string[];
  /** Where the weights were resolved to, or `''` before `load`. For bug reports. */
  resolvedDirectory(): string;
  /**
   * Hand over the transcript computed for `jobId`, and forget it.
   *
   * **Synchronous, and that is load-bearing rather than a convenience.** A `@JS
   * async` function's return value can be encoded off the JavaScript thread,
   * which segfaults the runtime -- it took Ear down through `Array<String>`,
   * Clear through `Record.encode` and Emo through
   * `JavaScriptValuesBuffer.deinit` on an array of records. This result is Emo's
   * exact shape at a larger scale: an array of `@Record`s inside a `@Record`, one
   * per word, so a minute of speech is a couple of hundred of them. A synchronous
   * `@JS` member runs on the JavaScript thread by construction, so the record is
   * encoded where it has to be. See `ios/AlignModel.swift`.
   *
   * Keyed by job id rather than a single slot, so two concurrent `transcribe`
   * calls on one model cannot take each other's answer.
   *
   * Throws `ERR_INFERENCE_FAILED` if there is nothing stored for `jobId`, which
   * can only happen if it is called without a completed `transcribe` for that id.
   */
  takeTranscript(jobId: string): AlignedTranscript;
}

interface DesertAntAlignModule extends NativeModule {
  /** False where this build or this device cannot run Align: no Apple artifact,
   *  or an iOS older than 26. */
  readonly isSupported: boolean;
  /** Why `isSupported` is false, or `''` when it is true. Computed natively
   *  because only the device knows its own OS version. */
  readonly unsupportedReason: string;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The model revision the SDK resolves. Currently `main`. */
  readonly modelRevision: string;
  /** The Hugging Face repo the weights come from. */
  readonly modelRepo: string;
  /** Whether `modelRevision` names a tag rather than a branch. Computed from the
   *  catalog, so it flips on its own when upstream tags the repo. */
  readonly revisionIsPinned: boolean;
  /** Whether Apple's on-device recognizer exists here at all. */
  readonly appleSpeechAvailable: boolean;
  /** The refiner's default context window, in seconds. */
  readonly defaultMaxBufferedSeconds: number;

  createModel(options: NativeAlignLoadOptions): NativeAlignModel;

  /** Download the weights and read the language map out of them. There is no
   *  session to build here; the refiner is per-call. */
  load(model: NativeAlignModel, jobId: string): Promise<void>;

  /** Install Apple's on-device speech model for a locale. Idempotent. */
  prepareLocale(model: NativeAlignModel, locale: string, jobId: string): Promise<void>;

  /**
   * Transcribe `path` with Apple's recognizer, refine every finalized word
   * boundary, and store the result under `jobId`, returning nothing.
   *
   * The `Promise<void>` is the point: see {@link NativeAlignModel.takeTranscript}.
   */
  transcribe(
    model: NativeAlignModel,
    path: string,
    options: NativeTranscribeOptions,
    jobId: string
  ): Promise<void>;
}

export default requireOptionalNativeModule<DesertAntAlignModule>('DesertAntAlign');
