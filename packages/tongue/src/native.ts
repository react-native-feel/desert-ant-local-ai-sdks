import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { Detection } from './types';

/**
 * The native surface. iOS and Android both, and on Android without the caveat
 * every other cross-platform model in this repo carries.
 *
 * Clear, Emo and Ear are LiteRT models, so `isSupported` off Apple is a statement
 * about the device's ABI -- `arm64-v8a` and `x86_64` have a `.so` and nothing
 * else does. Tongue has no `.so`. `ai.desertant:tongue` is a **pure Kotlin jar**:
 * an int8 gather, a sum, one 59x32 matmul and a masked softmax, using nothing
 * but `java.text.Normalizer` and `java.util.regex`. Upstream's own note is that
 * bridging the Swift core would cost ~51 MB of static Swift runtime per ABI to
 * serve 2 MB of weights. So there is no NDK, no ABI list, and no config-plugin
 * `abiFilters` block -- Tongue runs on every Android device the app runs on.
 *
 * **On Apple it is inert today**, and for a reason that is neither the platform's
 * nor this package's. desert-ant-core v3.1.0 declares a `Tongue` SwiftPM product
 * and never adds it to the manifest's `products:` array, so no consumer can link
 * the target -- `swift package dump-package` on the pinned tag lists 45 products
 * with every other model among them and no `Tongue`. The Apple sources are
 * written and compile behind `#if canImport(Tongue)`; until upstream exports the
 * product, `isSupported` is false on iOS and says so in a sentence. See
 * `ios/TongueModule.swift` and `packages/core/ios/DesertAntCore.podspec`.
 *
 * `requireOptionalNativeModule` is still right: it resolves to `null` rather than
 * throwing where the module was not built in (Expo Go, web, an app that installed
 * the package without prebuilding), so `Tongue.isSupported` can answer honestly
 * instead of the import crashing.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Tongue`.
 */

export interface NativeDetectOptions {
  /** How many candidates to rank. Validated `>= 1` before it gets here. */
  topK: number;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeTongueModel extends SharedObject<Record<string, never>> {
  /** Whether `load` has run and the weights are parsed, so `detect` will answer
   *  rather than refuse. */
  isLoaded(): boolean;
}

interface DesertAntTongueModule extends NativeModule {
  /**
   * True on Android wherever the module is present -- unlike Clear, Emo and Ear
   * there is no ABI story, because the Android half is a pure Kotlin jar.
   *
   * False on Apple until desert-ant-core exports its `Tongue` product; see the
   * note above.
   */
  readonly isSupported: boolean;
  /** Why `isSupported` is false, or `''` when it is true. */
  readonly unsupportedReason: string;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The Hub tag pinning the mirrored weights. Nothing downloads them -- see
   *  `Tongue.modelRevision`. */
  readonly modelRevision: string;
  /** The Hugging Face repo mirroring the bundled bytes. */
  readonly modelRepo: string;
  /** `detect`'s own `topK` default upstream, read rather than duplicated. */
  readonly defaultTopK: number;
  /** The gap below which `isTooCloseToCall` is true. Mirrored, not read -- see
   *  `Tongue.tieMargin`. */
  readonly tieMargin: number;
  /** `Normalizer.maxCharacters` / `Normalizer.MAX_CHARACTERS` upstream: the
   *  scalar cap the normalizer applies. Read off the binary on both platforms. */
  readonly maxCharacters: number;
  /**
   * Every UAX#24 script name the router knows, or `[]` where the platform cannot
   * say.
   *
   * A **property**, not an async call, and that is load-bearing rather than a
   * convenience. A `@JS async` function returning `[String]` encodes the array
   * off the JavaScript thread and segfaults the runtime; a synchronous property
   * getter runs on the JavaScript thread by construction. See the note on
   * `ios/TongueModule.swift`, and `packages/ear/ios/EarModel.swift` for the crash
   * that established it.
   *
   * Empty on Android: `Router` and `ScriptTables` are `internal` in
   * `ai.desertant:tongue`, so the Kotlin SDK has no list to hand over. `Tongue`
   * turns that into a coded refusal rather than an empty answer.
   */
  readonly scripts: string[];

  /** Create the handle. Parses nothing and touches no file. */
  createModel(): NativeTongueModel;

  /**
   * Read the bundled weights and build the pipeline.
   *
   * The only asynchronous function in this module, and it returns `Void`. Both
   * halves of that are deliberate: 2 MB of int8 has to be read and widened off
   * the JavaScript thread, and nothing crosses back, so the one Expo Modules 2.0
   * hazard that has cost this repo real time -- an async return encoded off the
   * JavaScript thread -- has no surface here at all.
   */
  load(model: NativeTongueModel): Promise<void>;

  /**
   * Identify the language of `text`. **Synchronous.**
   *
   * Every other model in this repo answers asynchronously because every other
   * model takes milliseconds to seconds. A detection here is an int8 gather, a
   * sum, one small matmul and a masked softmax -- upstream measures tens of
   * microseconds and says so on the main thread -- so there is nothing to get off
   * the JavaScript thread, and a promise per keystroke would cost more than the
   * model does.
   *
   * It is also the shape that cannot hit Expo Modules 2.0 limit 4: a synchronous
   * `@JS` function's return value is encoded on the JavaScript thread by
   * construction. `Tongue.detect()` still returns a promise, for a surface that
   * reads like the other six; it is this call underneath.
   *
   * Throws `ERR_MODEL_UNAVAILABLE` when `load` has not run.
   */
  detect(model: NativeTongueModel, text: string, options: NativeDetectOptions): Detection;
}

export default requireOptionalNativeModule<DesertAntTongueModule>('DesertAntTongue');
