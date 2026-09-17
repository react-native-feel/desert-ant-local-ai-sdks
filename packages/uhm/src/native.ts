import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { ProgressEvent, UhmResult, WordRange } from './types';

/**
 * The native surface. Apple only.
 *
 * That is upstream's shape rather than this package's choice, and it is two
 * separate limits stacked: `Sources/Uhm/Catalog.swift` lists `.apple` and
 * nothing else, because no LiteRT export of the detector has been published --
 * and the type labeller is a CreateML sound classifier driven through
 * SoundAnalysis, which exists on Apple platforms and nowhere else. So an Android
 * build would have neither half.
 *
 * Hence `requireOptionalNativeModule`: off iOS this resolves to `null` at import
 * time instead of throwing, so an app can ship one bundle, check
 * `Uhm.isSupported`, and hide the feature. Every other entry point throws
 * `ERR_UNSUPPORTED_PLATFORM`.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Uhm`.
 */

/** Resolved on the TypeScript side so the native record carries one
 *  representation of a threshold rather than encoding "absent" and "use the
 *  preset" in the same number. */
export interface NativeAnalyzeOptions {
  /** `precision`, `balanced` or `recall`. */
  bias: string;
  includeTypes: boolean;
  /** Ignored when `useBiasThreshold` is true. */
  minConfidence: number;
  /** True lets the preset's own threshold stand. */
  useBiasThreshold: boolean;
  minDurationSec: number;
}

export interface NativeReconcileOptions {
  minOverlapFraction: number;
  splitContainedWords: boolean;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeUhmModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
  /**
   * Hand over the result computed for `jobId`, and forget it.
   *
   * Synchronous, and that is the point rather than an optimization. An async
   * native function's return value is encoded after its last suspension, and on
   * iOS that lands on the cooperative thread pool rather than the JavaScript
   * thread -- which corrupts the Hermes heap and segfaults the process, usually
   * somewhere else entirely and some time later. A synchronous native function
   * encodes inside the host call, on the JavaScript thread, by construction.
   *
   * Keyed by job id rather than a single slot, so two concurrent calls on one
   * model cannot take each other's answer. Throws `ERR_INFERENCE_FAILED` if
   * nothing is waiting, which can only happen if it is called without a
   * completed call for that id.
   */
  takeResult(jobId: string): UhmResult;
}

interface DesertAntUhmModule extends NativeModule {
  /** False where this build cannot run Uhm. Always true on iOS; the module does
   *  not exist elsewhere, which `Uhm.isSupported` reports instead. */
  readonly isSupported: boolean;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The pinned model revision the SDK resolves. */
  readonly modelRevision: string;
  /** Each bias preset's confidence threshold, read off the Swift enum rather
   *  than duplicated here. */
  readonly biasThresholds: Record<string, number>;
  /** Every filler type the labeller can return, so a UI can enumerate them
   *  without hardcoding the set. */
  readonly fillerTypes: string[];

  createModel(options: { directory?: string; computeUnits: string }): NativeUhmModel;

  /** Download the weights and build the session. Upstream fuses the two -- see
   *  `Uhm.warm`. */
  load(model: NativeUhmModel, jobId: string): Promise<void>;

  analyzeFile(
    model: NativeUhmModel,
    path: string,
    options: NativeAnalyzeOptions,
    jobId: string
  ): Promise<void>;

  /**
   * Mono `samples` at `sampleRate`, resampled natively if it is not the model's
   * 16 kHz.
   *
   * The audio only ever travels *into* native memory, which is the easy
   * direction: `Float32Array` is a first-class convertible type, and the result
   * is a handful of spans. Clear needs a shared object to hand samples back; Uhm
   * never does.
   */
  analyzeSamples(
    model: NativeUhmModel,
    samples: Float32Array,
    sampleRate: number,
    options: NativeAnalyzeOptions,
    jobId: string
  ): Promise<void>;

  /**
   * Reconcile transcript words against detected fillers. Pure geometry, needs no
   * model and no download, so it is a module function rather than one on the
   * shared object.
   */
  reconcileWords(
    words: WordRange[],
    fillers: { start: number; end: number }[],
    options: NativeReconcileOptions
  ): WordRange[];
}

export default requireOptionalNativeModule<DesertAntUhmModule>('DesertAntUhm');
