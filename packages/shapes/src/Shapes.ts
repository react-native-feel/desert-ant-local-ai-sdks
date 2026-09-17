import { toDesertAntError, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeShapes, {
  type NativeRecognition,
  type NativeRecognizeOptions,
  type NativeShapesModel,
} from './native';
import {
  type Point,
  type Recognition,
  type RecognizeOptions,
  type Shape,
  type ShapeKind,
  type ShapesLoadOptions,
} from './types';

const MODEL = 'shapes';

/**
 * The five classes the model fits.
 *
 * Written here rather than read off the binary, which is the single exception in
 * this package and upstream's rather than a shortcut: `ShapeKind` is `internal`
 * in Swift, the public `Shape` is an enum with associated values and so cannot be
 * `CaseIterable`, and Kotlin's is a sealed class. There is no list on either
 * platform to read. See {@link ShapeKind} for what keeps it from going stale.
 */
const KINDS: readonly ShapeKind[] = ['line', 'rectangle', 'triangle', 'ellipse', 'star'];

/** How many points each kind's flat `points` array must carry. `null` for a star
 *  and an ellipse, which carry only a center. */
const POINTS_PER_KIND: Record<ShapeKind, number> = {
  line: 2,
  rectangle: 4,
  triangle: 3,
  ellipse: 1,
  star: 1,
};

/** `minimumConfidence: Double = 0` upstream, in a Swift initializer and a Kotlin
 *  data class. A default argument in both, so it is mirrored rather than read --
 *  but still forwarded through the native module so the two platforms cannot show
 *  different numbers. */
const FALLBACK_MINIMUM_CONFIDENCE = 0;

let nextJobId = 0;

/**
 * On-device sketch recognition: one hand-drawn stroke in, one clean vector shape
 * out -- a line, a rectangle, a triangle, an ellipse or a star -- or nothing,
 * when what was drawn was not a shape.
 *
 * ```ts
 * if (!Shapes.isSupported) return;
 * const shapes = await Shapes.load();                 // 0.2 MB on iOS
 * const { shape } = await shapes.recognize(strokePoints);
 * if (shape?.kind === 'ellipse') {
 *   shape.center;      // { x, y } in the same coordinates you drew in
 *   shape.semiMajor;   // === semiMinor when it snapped to a circle
 * }
 * drawPolyline(outline(shape!));                      // needs no model
 * ```
 *
 * **The first model in this repo whose input is neither audio nor text.** A
 * stroke is an ordered list of `{ x, y }` in whatever space you drew in -- view
 * coordinates, PDF points, a normalized canvas -- and everything that comes back
 * is in that same space, because the model is scale- and translation-invariant.
 * Nothing about the units reaches it.
 *
 * It is a hybrid of two stages, and knowing which one rejected a stroke explains
 * most of what it does. A small classifier reads a fixed 256-point window of
 * resampled `[distance, cos, sin]` features and proposes a class. A geometric
 * fitter then produces the clean parameters *and* a normalized residual -- RMS
 * point-to-shape distance over the bounding-box diagonal -- and the stroke is
 * accepted only if it clears that class's calibrated confidence **and** residual
 * gates. So a confident "rectangle" that does not actually fit a rectangle is
 * still rejected, which is what keeps a scribble from becoming a shape.
 *
 * After the fit comes regularization, which is why the output looks deliberate:
 * a line within 5 degrees of an axis snaps to it, an ellipse whose axes are
 * within 25% of each other becomes an exact circle, a rectangle within 25% of
 * square becomes a square, rectangles and ellipses snap their rotation to
 * 15-degree increments, and a triangle close to equilateral or isosceles becomes
 * one. None of that is configurable on any of the three SDKs -- upstream's
 * `SnapConfig` is `internal` -- so it is documented here rather than exposed.
 *
 * **One stroke at a time.** Upstream says so and means it: a multi-stroke diagram
 * has to be grouped by the app before it gets here. There is no session, no
 * incremental state, and no notion of a second stroke joining the first.
 */
export class Shapes {
  /**
   * Whether this build and this device can run Shapes.
   *
   * Like Clear, Emo, Ear, Gist and Redact and unlike Voz, Clips and Uhm, this is
   * not an "Apple only" flag -- upstream ships a Core ML export *and* a LiteRT
   * one, and `ai.desertant:shapes` is published. It is false in two narrower
   * cases: an Android device whose ABI LiteRT does not ship (`arm64-v8a` and
   * `x86_64` are the two it does), and any build where the native module is not
   * present at all, such as Expo Go or web.
   */
  static get isSupported(): boolean {
    return NativeShapes?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. On Android it names the ABIs the device actually reported, which is
   *  why it is computed natively rather than written here. */
  static get unsupportedReason(): string | null {
    if (Shapes.isSupported) {
      return null;
    }
    const native = NativeShapes?.unsupportedReason;
    if (native) {
      return native;
    }
    return (
      'Shapes is not available in this build. The native module did not load -- an Expo Go ' +
      'session or a web bundle, rather than a dev build with the package prebuilt in.'
    );
  }

  /** The desert-ant-core version the native binary links against, or null where
   *  the module is absent. */
  static get nativeCoreVersion(): string | null {
    return NativeShapes?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null where the module is
   *  absent. */
  static get modelRevision(): string | null {
    return NativeShapes?.modelRevision ?? null;
  }

  /** The Hugging Face repo the weights come from, or null where the module is
   *  absent. */
  static get modelRepo(): string | null {
    return NativeShapes?.modelRepo ?? null;
  }

  /**
   * The five classes the model can fit, for a legend or a picker.
   *
   * The only list in this package that is not read off the binary, because
   * upstream publishes none to read on either platform. See {@link ShapeKind}.
   */
  static get kinds(): ShapeKind[] {
    return [...KINDS];
  }

  /**
   * The extra confidence floor a `recognize` uses when the caller does not say:
   * `0`, meaning the model's own calibrated gates and nothing on top.
   *
   * Mirrored from upstream rather than read off it, because on both platforms it
   * is a default argument rather than a constant the SDK exposes. It is forwarded
   * through the native module anyway so the two platforms cannot show different
   * numbers.
   */
  static get defaultMinimumConfidence(): number {
    const native = NativeShapes?.defaultMinimumConfidence;
    return typeof native === 'number' && native >= 0 && native <= 1
      ? native
      : FALLBACK_MINIMUM_CONFIDENCE;
  }

  /**
   * Create the model and get it ready: download the weights if they are missing,
   * then build the session. Resolves when the next `recognize` will not have to
   * wait for either.
   *
   * 0.2 MB on Apple and 1.3 MB on Android. That is the smallest download in this
   * family by a factor of twenty-five -- Emo, the next smallest, is 5 MB -- so
   * this is the one model here where loading on mount needs no justification at
   * all.
   */
  static async load(options: ShapesLoadOptions = {}): Promise<Shapes> {
    const shapes = Shapes.create(options);
    try {
      await shapes.warm(options.onProgress);
      return shapes;
    } catch (error) {
      shapes.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `recognize`, which is then as slow as a download.
   *
   * Cheap enough to do purely to ask {@link isDownloaded}, which is how an app
   * decides whether to offer the download or just do it.
   */
  static create(options: ShapesLoadOptions = {}): Shapes {
    const native = Shapes.requireNative();
    try {
      return new Shapes(native.createModel({ directory: options.directory }));
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeShapes> {
    if (!NativeShapes) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            Shapes.unsupportedReason ??
              'Shapes is not available here. Gate the feature on `Shapes.isSupported`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeShapes;
  }

  private released = false;

  private constructor(private readonly native: NativeShapesModel) {}

  /** Whether the weights are on the device, so recognition needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download the weights and build the session, so the first `recognize` pays
   * neither.
   *
   * Identical to {@link download} -- upstream exposes one call that does both, so
   * unlike Clear and Voz there is no download-only step to run separately. Both
   * names exist so every model in this repo reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Shapes.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. See its note. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Recognize one stroke.
   *
   * ```ts
   * const { shape, processingSec } = await shapes.recognize(points);
   * switch (shape?.kind) {
   *   case 'rectangle': return shape.corners;
   *   case 'ellipse':   return shape.center;
   *   case undefined:   return null;          // rejected, which is a result
   * }
   * ```
   *
   * `points` is the stroke in drawing order, in any coordinate space you like --
   * everything that comes back is in the same one. Give it the raw samples from a
   * gesture: the model resamples to uniform arc length itself and reads a fixed
   * 256-point window, so more points than that cost the bridge hop and nothing
   * else, and thinning the stroke yourself can only lose information.
   *
   * A stroke of fewer than two points comes back as `shape: null` **without
   * loading the model**, so an empty canvas costs nothing on a device that has
   * never downloaded the weights. That is upstream's own answer rather than a
   * rule of this package's: `ai.desertant:shapes` returns null before waking the
   * model, and the Swift path reaches the same nil through its degenerate-stroke
   * check.
   *
   * Refuses, rather than silently mangling, a coordinate that is not a finite
   * number. Upstream does not check: `StrokePreprocessor`'s duplicate test is
   * `abs(dx) > epsilon`, which is `false` for `NaN`, so a poisoned point is
   * dropped instead of caught and whatever survives is classified anyway --
   * producing a real shape whose geometry is `NaN`, which renders as nothing and
   * reads as a model that stopped working. A gesture stream that briefly reported
   * no location is exactly how that happens.
   */
  async recognize(points: Point[], options: RecognizeOptions = {}): Promise<Recognition> {
    this.assertAlive();
    const coordinates = toCoordinates(points);
    const native = toNativeOptions(options);
    // Two calls rather than one, and not for caching: the async half returns
    // nothing and the record is read back synchronously, because a `@JS async`
    // function's return value can be encoded off the JavaScript thread and
    // segfault the runtime. ios/ShapesModel.swift carries the full account.
    return this.run(options.onProgress, async (jobId) => {
      await Shapes.requireNative().recognize(this.native, coordinates, native, jobId);
      return toRecognition(this.native.takeRecognition(jobId));
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
    const jobId = `shapes-${nextJobId}`;
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
        Object.assign(new Error('This Shapes was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

/**
 * Validate the stroke and flatten it for the wire.
 *
 * Flat `[x, y, x, y, ...]` rather than an array of objects: a stroke from a real
 * canvas is hundreds of points, this is the one call in this family a gesture
 * stream can issue several times a second, and it is the layout upstream's own
 * FFI binding already uses between Kotlin and Swift.
 */
function toCoordinates(points: Point[]): number[] {
  if (!Array.isArray(points)) {
    throw invalid('recognize needs an array of { x, y } points in drawing order');
  }
  const coordinates: number[] = new Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point || typeof point !== 'object') {
      throw invalid(`point ${i} is ${String(point)}; expected an { x, y } object`);
    }
    const { x, y } = point;
    // Both halves matter. `typeof` catches a string that would arrive as a
    // string-shaped number and be coerced somewhere downstream; `isFinite`
    // catches the NaN and Infinity that upstream's preprocessor drops instead of
    // rejecting, which is the failure that produces a confident answer made of
    // nothing.
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw invalid(
        `point ${i} is (${String(x)}, ${String(y)}); every coordinate must be a finite number`
      );
    }
    coordinates[i * 2] = x;
    coordinates[i * 2 + 1] = y;
  }
  return coordinates;
}

/** Validate the per-call options and flatten them for the wire. */
function toNativeOptions(options: RecognizeOptions): NativeRecognizeOptions {
  const minimumConfidence = options.minimumConfidence ?? Shapes.defaultMinimumConfidence;
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
  return { minimumConfidence };
}

/** Shape a native recognition for the caller. */
function toRecognition(native: NativeRecognition): Recognition {
  return {
    shape: toShape(native),
    processingSec: native.processingSec,
    modelRevision: native.modelRevision ?? null,
  };
}

/**
 * Narrow the flat wire record back into the discriminated union.
 *
 * The one place the wire's flatness is visible, and the reason it never reaches a
 * caller. Fields belonging to other kinds are zero on the wire and are simply not
 * read: the tag decides what is meaningful.
 */
function toShape(native: NativeRecognition): Shape | null {
  const kind = native.kind;
  if (kind === null || kind === undefined) {
    return null;
  }
  if (!KINDS.includes(kind as ShapeKind)) {
    // Loud rather than null. Returning "no shape" for a class this SDK does not
    // know would hide a real detection behind the same value a rejected scribble
    // produces, and the two mean opposite things. It cannot happen on iOS -- the
    // Swift `switch` that writes this tag is exhaustive over a public enum, so a
    // sixth class fails the pod's build -- and on Android the module refuses one
    // layer earlier, for the same reason with less help from the compiler.
    throw failed(
      `desert-ant-core reported a shape kind this SDK does not know: '${kind}'. ` +
        `Expected one of ${KINDS.join(', ')}.`
    );
  }
  const points = toPoints(native.points, kind as ShapeKind);
  switch (kind as ShapeKind) {
    case 'line':
      return { kind: 'line', from: points[0]!, to: points[1]! };
    case 'rectangle':
      return { kind: 'rectangle', corners: points };
    case 'triangle':
      return { kind: 'triangle', vertices: points };
    case 'ellipse':
      return {
        kind: 'ellipse',
        center: points[0]!,
        semiMajor: native.semiMajor,
        semiMinor: native.semiMinor,
        rotation: native.rotation,
      };
    case 'star':
      return {
        kind: 'star',
        center: points[0]!,
        outerRadius: native.outerRadius,
        innerRadius: native.innerRadius,
        rotation: native.rotation,
        pointCount: native.pointCount,
      };
  }
}

/** Unflatten the kind's points, refusing a payload that cannot be that kind. */
function toPoints(flat: number[], kind: ShapeKind): Point[] {
  const expected = POINTS_PER_KIND[kind];
  if (!Array.isArray(flat) || flat.length !== expected * 2) {
    throw failed(
      `a ${kind} came back with ${Array.isArray(flat) ? flat.length : 0} coordinates; ` +
        `expected ${expected * 2}`
    );
  }
  const points: Point[] = new Array(expected);
  for (let i = 0; i < expected; i += 1) {
    points[i] = { x: flat[i * 2]!, y: flat[i * 2 + 1]! };
  }
  return points;
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}

function failed(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INFERENCE_FAILED' }), MODEL);
}
