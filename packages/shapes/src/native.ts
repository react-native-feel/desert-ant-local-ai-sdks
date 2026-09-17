import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { ProgressEvent } from './types';

/**
 * The native surface. iOS and Android both.
 *
 * Shapes is the sixth model in this repo with two working halves, after Clear,
 * Emo, Ear, Gist and Redact: `Sources/Shapes/Catalog.swift` lists `.apple`,
 * `.android`, `.linux`, `.windows` and `.web`, and `ai.desertant:shapes` is
 * published. So `isSupported` off Apple is a statement about the *device* rather
 * than about the catalog -- `ai.desertant:shapes` loads `libShapesAndroid.so`
 * through JNI and LiteRT ships `arm64-v8a` and `x86_64`, so an ABI outside those
 * has no `.so` to load.
 *
 * `requireOptionalNativeModule` resolves to `null` rather than throwing where the
 * module was not built in (Expo Go, web, an app that installed the package
 * without prebuilding), so `Shapes.isSupported` can answer honestly instead of
 * the import crashing.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Shapes`.
 */

export interface NativeShapesLoadOptions {
  directory?: string;
}

export interface NativeRecognizeOptions {
  /** Validated into `0..1` before it gets here. */
  minimumConfidence: number;
}

/**
 * One recognition, flat.
 *
 * The public {@link Shape} is a discriminated union; this is what that union
 * looks like on a wire with no sum type. `kind` is the tag, `points` carries
 * whichever points the kind has as a flat `[x, y, x, y, ...]` array, and the
 * scalar fields carry the rest. Fields belonging to other kinds are `0` and are
 * never read -- `toShape` in `Shapes.ts` reads only the ones the tag names.
 *
 * This is the same layout upstream's own cross-language binding uses between
 * Kotlin and Swift (`Sources/Shapes/Binding.swift`: `u32 present`, `u32 kind`,
 * then that kind's fields), so it is a format two implementations already agree
 * on rather than one invented here.
 */
export interface NativeRecognition {
  /** `null` when the stroke was rejected or degenerate. */
  kind: string | null;
  /** Flat x, y pairs: the kind's points. */
  points: number[];
  semiMajor: number;
  semiMinor: number;
  outerRadius: number;
  innerRadius: number;
  rotation: number;
  pointCount: number;
  processingSec: number;
  modelRevision: string | null;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeShapesModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
  /**
   * Hand over the recognition computed for `jobId`, and forget it.
   *
   * **Synchronous, and that is load-bearing rather than a convenience.** A `@JS
   * async` function's return value can be encoded off the JavaScript thread,
   * which segfaults the runtime -- it took Ear down through `Array<String>`,
   * Clear through `Record.encode` and Emo through
   * `JavaScriptValuesBuffer.deinit`. A synchronous `@JS` member runs on the
   * JavaScript thread by construction, so the record is encoded where it has to
   * be. See `ios/ShapesModel.swift`.
   *
   * This record carries a `number[]`, which is the same shape of value that
   * crashed Ear, so the split is not a precaution taken from a distance.
   *
   * Keyed by job id rather than a single slot, so two concurrent `recognize`
   * calls on one model cannot take each other's answer -- which for this model
   * is a live case rather than a hypothetical, since a canvas can finish two
   * strokes within a frame of each other.
   *
   * Throws `ERR_INFERENCE_FAILED` if there is nothing stored for `jobId`, which
   * can only happen if it is called without a completed `recognize` for that id.
   */
  takeRecognition(jobId: string): NativeRecognition;
}

interface DesertAntShapesModule extends NativeModule {
  /** False where this build cannot run Shapes. True on iOS; on Android, false on
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
   * The extra confidence floor a `recognize` uses when the caller does not say:
   * `0`, meaning "the model's own calibrated gates and nothing more".
   *
   * Mirrored rather than read: it is `minimumConfidence: Double = 0` in a Swift
   * initializer and `val minimumConfidence: Double = 0.0` in a Kotlin data
   * class, and a default argument is not a constant either SDK exposes. Nothing
   * branches on it natively -- it is forwarded so the two platforms show the
   * same number.
   */
  readonly defaultMinimumConfidence: number;

  createModel(options: NativeShapesLoadOptions): NativeShapesModel;

  /** Download the weights and build the session. Upstream fuses the two. */
  load(model: NativeShapesModel, jobId: string): Promise<void>;

  /**
   * Recognize the stroke in `coordinates` and store the result on the shared
   * object under `jobId`, returning nothing.
   *
   * `coordinates` is flat `[x, y, x, y, ...]`, not an array of `{ x, y }`
   * objects. A real stroke is hundreds of points and this is the one call in
   * this family a gesture stream can issue several times a second, so the
   * cheapest thing that crosses wins -- and it is the layout upstream's own FFI
   * already uses.
   *
   * The `Promise<void>` is the point: see {@link NativeShapesModel.takeRecognition}.
   */
  recognize(
    model: NativeShapesModel,
    coordinates: number[],
    options: NativeRecognizeOptions,
    jobId: string
  ): Promise<void>;
}

export default requireOptionalNativeModule<DesertAntShapesModule>('DesertAntShapes');
