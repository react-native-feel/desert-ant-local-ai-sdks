import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { ProgressEvent, Transcript } from './types';

/**
 * The native surface. Apple only, and unusually that is upstream's shape rather
 * than this package's choice: `Sources/Voz` in `desert-ant-core` drives Core ML
 * directly -- preallocated buffers, `outputBackings`, a lane-batched decode loop
 * -- none of which is expressible through the generic inference session the
 * portable models share, so there is no Android, Linux or web entry to bind to.
 * `Catalog.swift` says so in `files`, which lists `.apple` and nothing else.
 *
 * Hence `requireOptionalNativeModule`: on Android this resolves to `null` at
 * import time instead of throwing, so an app can ship one bundle, check
 * `Voz.isSupported`, and hide the feature. Every other entry point throws
 * `ERR_UNSUPPORTED_PLATFORM`.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Voz`.
 */

/**
 * State and synchronous access to it -- nothing async, and no constructor.
 *
 * Both absences are the Expo Modules 2.0 macros talking, and they are the same
 * two limits `@desert-ant-labs/react-native-clear` hit: `@JS async` compiles on
 * an `@ExpoModule` class but not on a `@SharedObject` (the prototype binding is a
 * synchronous function type), and a `@JS init` is called without `try` so it
 * cannot validate. The asynchronous work and the construction are therefore
 * module functions taking the object, below.
 */
export interface NativeVozModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
}

interface DesertAntVozModule extends NativeModule {
  /** False where the platform cannot run Voz at all. Always true on iOS; the
   *  module does not exist elsewhere, which `Voz.isSupported` reports instead. */
  readonly isSupported: boolean;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The pinned model revision the SDK resolves. */
  readonly modelRevision: string;
  /** ISO 639-1 codes the model was trained on. See `Voz.supportedLanguages`. */
  readonly supportedLanguages: string[];

  createModel(options: { directory?: string }): NativeVozModel;

  download(model: NativeVozModel, jobId: string): Promise<void>;
  load(model: NativeVozModel, jobId: string): Promise<void>;
  transcribeFile(model: NativeVozModel, path: string, jobId: string): Promise<Transcript>;
  /**
   * Mono `samples` at `sampleRate`, resampled natively if it is not the model's.
   *
   * The audio only ever travels *into* native memory, which is the easy
   * direction: `Float32Array` is a first-class convertible type, and the result
   * is text. Clear needs a shared object to hand samples *back*; Voz never does.
   */
  transcribeSamples(
    model: NativeVozModel,
    samples: Float32Array,
    sampleRate: number,
    jobId: string
  ): Promise<Transcript>;
}

export default requireOptionalNativeModule<DesertAntVozModule>('DesertAntVoz');
