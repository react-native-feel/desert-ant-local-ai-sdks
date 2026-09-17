import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { Detection, ProgressEvent } from './types';

/**
 * The native surface. iOS and Android both.
 *
 * Ear is the third model in this repo with both halves, after Clear and Emo:
 * `Sources/Ear/Catalog.swift` lists `.apple`, `.android`, `.linux`, `.windows`
 * and `.web`, and `ai.desertant:ear` is on Maven Central. So unlike Voz, Clips
 * and Uhm this module exists on Android and `isSupported` is a statement about
 * the *device* rather than about the catalog -- LiteRT ships `arm64-v8a` and
 * `x86_64`, and an ABI outside those has no `.so` to load.
 *
 * `requireOptionalNativeModule` is still the right call: it resolves to `null`
 * rather than throwing where the module was not built in (Expo Go, web, an app
 * that installed the package without prebuilding), so `Ear.isSupported` can
 * answer honestly instead of the import crashing.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Ear`.
 */

export interface NativeIdentifyOptions {
  /** How many thirty-second windows to listen to. Validated `>= 1` before it
   *  gets here. */
  windows: number;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeEarModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
  /**
   * The language list `loadLanguages` fetched, or `[]` before it has run.
   *
   * Synchronous, and that is load-bearing rather than a convenience. A `@JS async`
   * function returning `[String]` encodes the array off the JavaScript thread and
   * segfaults the runtime -- see the note on `EarModelObject.loadLanguages` in
   * ios/EarModel.swift. A synchronous member runs on the JavaScript thread by
   * construction, so the array is encoded where it has to be.
   */
  languages(): string[];
}

interface DesertAntEarModule extends NativeModule {
  /** False where this build cannot run Ear. True on iOS; on Android, false on an
   *  ABI LiteRT does not ship. */
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
  /** `Ear.defaultWindows` upstream, read rather than duplicated. */
  readonly defaultWindows: number;
  /** `Detection.reliableMargin` upstream -- how far ahead the top candidate must
   *  be before `isReliable` is true. */
  readonly reliableMargin: number;

  createModel(options: { directory?: string }): NativeEarModel;

  /** Download the weights and build the session. Upstream fuses the two. */
  load(model: NativeEarModel, jobId: string): Promise<void>;

  identifyFile(
    model: NativeEarModel,
    path: string,
    options: NativeIdentifyOptions,
    jobId: string
  ): Promise<Detection>;

  /**
   * Mono `samples` at `sampleRate`, resampled natively if it is not the model's
   * 16 kHz.
   *
   * The audio only ever travels *into* native memory, which is the easy
   * direction: `Float32Array` is a first-class convertible type, and what comes
   * back is a short list of candidates. Ear never needs Clear's shared-object
   * dance for handing a buffer back.
   */
  identifySamples(
    model: NativeEarModel,
    samples: Float32Array,
    sampleRate: number,
    options: NativeIdentifyOptions,
    jobId: string
  ): Promise<Detection>;

  /**
   * Load the model's language list onto the shared object, and return nothing.
   *
   * The array comes back through `NativeEarModel.languages()` instead, for the
   * thread reason documented there.
   *
   * **Apple only.** It reads the `languages.json` sidecar through the loaded
   * model, and `ai.desertant:ear` publishes no equivalent -- the Kotlin SDK's
   * whole surface is `Ear`, `Detection`, `LanguageCandidate` and `Options`. The
   * Android half raises `ERR_UNSUPPORTED_PLATFORM` rather than guessing at a list
   * it cannot read.
   */
  loadLanguages(model: NativeEarModel, jobId: string): Promise<void>;
}

export default requireOptionalNativeModule<DesertAntEarModule>('DesertAntEar');
