import type { ModelLoadOptions, ModelPhase, ProgressEvent } from '@desert-ant-labs/react-native-core';

/**
 * A 2D point, in whatever coordinate space the stroke was drawn in.
 *
 * There is no unit and no origin here: the model is scale- and
 * translation-invariant, and every number it hands back is in the same space as
 * the numbers it was given. Pass view coordinates and get view coordinates back;
 * pass PDF points and get PDF points back.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * The five classes Shapes can fit.
 *
 * **The one list in this package that is written here rather than read off the
 * binary**, and the exception is upstream's rather than a shortcut. Every other
 * model here reads its vocabulary from the native SDK -- `Label.allCases` for
 * Redact, `Gist.variants`, `Uhm.fillerTypes` -- because a duplicated list is a
 * list that goes stale. Shapes publishes none to read: `ShapeKind` is `internal`
 * in `Sources/Shapes/Shape.swift`, the public `Shape` is a Swift enum with
 * associated values and so cannot be `CaseIterable`, and Kotlin's `Shape` is a
 * sealed class whose subclasses are not enumerable without reflection.
 *
 * What keeps it honest is on the native side rather than here: the `switch` that
 * flattens a fitted shape onto the wire (`ios/ShapesRecords.swift`) is exhaustive
 * over that public enum with no `default`, so a sixth class upstream fails the
 * pod's build instead of quietly going unreported. The Android half cannot get
 * that from the compiler -- it resolves a sealed class out of a Maven artifact at
 * runtime -- so it throws `ERR_INFERENCE_FAILED` naming the kind it did not know,
 * which is the same refusal one layer later.
 */
export type ShapeKind = 'line' | 'rectangle' | 'triangle' | 'ellipse' | 'star';

/** A straight segment. Snapped to the horizontal or vertical axis when it was
 *  drawn within 5 degrees of one. */
export interface LineShape {
  kind: 'line';
  from: Point;
  to: Point;
}

/**
 * A rectangle, as its four corners in order around the perimeter.
 *
 * Corners rather than an origin and a size, because the rectangle is free to be
 * rotated -- upstream snaps its rotation to 15-degree increments, so an
 * "upright" rectangle really is axis-aligned, but one drawn at 40 degrees comes
 * back at 45. It is snapped to a square when its short side is within 25% of its
 * long one.
 */
export interface RectangleShape {
  kind: 'rectangle';
  corners: Point[];
}

/** A triangle, as its three vertices. Snapped to equilateral or isosceles when it
 *  was drawn close enough to one, and its base edge to an axis within 5 degrees. */
export interface TriangleShape {
  kind: 'triangle';
  vertices: Point[];
}

/**
 * An ellipse, as a center, two semi-axes and a rotation in **radians**.
 *
 * Snapped to a circle -- `semiMajor === semiMinor` -- when the two axes were
 * within 25% of each other, which is why a hand-drawn "circle" comes back exactly
 * round rather than nearly round.
 */
export interface EllipseShape {
  kind: 'ellipse';
  center: Point;
  semiMajor: number;
  semiMinor: number;
  /** Radians. */
  rotation: number;
}

/**
 * A star, alternating between `outerRadius` and `innerRadius` across
 * `pointCount` points.
 *
 * `pointCount` is fitted, not assumed: a six-pointed star comes back with
 * `pointCount: 6`. The first outer point sits at `rotation - PI/2` -- directly
 * above the center in a y-down canvas -- and the remaining `2 * pointCount - 1`
 * vertices follow every `PI / pointCount`, alternating radius.
 */
export interface StarShape {
  kind: 'star';
  center: Point;
  outerRadius: number;
  innerRadius: number;
  /** Radians. */
  rotation: number;
  pointCount: number;
}

/**
 * A recognized, fitted shape, in the same coordinate space as the stroke that
 * produced it.
 *
 * A discriminated union on {@link ShapeKind}, so `switch (shape.kind)` narrows
 * and an unhandled class is a type error. On the wire it is flat -- a `kind` tag
 * plus that kind's fields -- because neither `@Record` nor a JS object literal
 * has a sum type, and that is also exactly what upstream's own cross-language
 * FFI binding writes. The flatness never reaches a caller.
 */
export type Shape =
  | LineShape
  | RectangleShape
  | TriangleShape
  | EllipseShape
  | StarShape;

/** What one `recognize` call produced. */
export interface Recognition {
  /**
   * The fitted shape, or **null** when the stroke was rejected.
   *
   * Null is a result rather than a failure, and for this model it is half the
   * product. Upstream rejects a stroke when the classifier's top class does not
   * clear that class's calibrated confidence gate, when the geometric fit's
   * residual is worse than that class's residual gate, when the top class is the
   * reject class, or when the stroke is too short or too small to be a stroke at
   * all. A scribble that came back as a wobbly rectangle would be worse than one
   * that came back as nothing.
   */
  shape: Shape | null;
  /**
   * Wall-clock time the recognition took, in seconds.
   *
   * Measured around the call natively, so it excludes the bridge hop but includes
   * everything the model did: preprocessing, the classifier, the geometric fit
   * and the snapping. A first call on a cold model also pays the download and the
   * session build; a second does not.
   */
  processingSec: number;
  /** The published model revision this came from, so a benchmark or a telemetry
   *  event is self-identifying. */
  modelRevision: string | null;
}

/** How a `Shapes` finds its weights. */
export interface ShapesLoadOptions extends ModelLoadOptions {
  /**
   * Called while the model downloads and loads.
   *
   * Worth wiring less than any other model here: the Apple artifact is 0.2 MB and
   * the Android one 1.3 MB, so on anything but a hostile network this fires once
   * at 1. It is still the only phase anything here reports -- see
   * {@link ShapesProgressNote}.
   */
  onProgress?: (event: ProgressEvent) => void;
}

/** Tuning for one `recognize` call. Every field is per call: a model instance
 *  holds no settings, so two callers can ask one loaded model for different
 *  shapes of answer. */
export interface RecognizeOptions {
  /**
   * An extra minimum classifier confidence, `0` to `1`. Defaults to
   * {@link Shapes.defaultMinimumConfidence} (0).
   *
   * It sits **on top of** each class's calibrated gate rather than replacing it,
   * so it can only reject more than the default does. The gates in
   * `shapes_meta.json` are what the model was tuned with; raise this when a false
   * positive costs more than a missed shape -- a whiteboard that silently
   * replaces a scribble with a triangle is worse than one that leaves it alone.
   *
   * Upstream *clamps* an out-of-range value into `0...1` and a non-finite one to
   * `0`; this package rejects both with `ERR_INVALID_ARGUMENT` instead, because
   * `95` meaning "95%" silently becoming `1.0` is a recognizer that has stopped
   * recognizing and says nothing about why.
   */
  minimumConfidence?: number;
  /** Called while the model downloads and loads. Recognition itself reports
   *  nothing -- see {@link ShapesProgressNote}. */
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * A marker for the one thing this model does not report.
 *
 * `recognize` emits no progress of its own: upstream's
 * `recognize(points:options:)` takes no handler on either platform, unlike its
 * `download`. So the only phase a `Shapes` ever emits is `loadingModel`, and it
 * emits it from `warm`, `download`, and the load the first `recognize` does
 * implicitly. No phase was added to `ModelPhase` in `packages/core` for this
 * model, because upstream reports none -- and a pass upstream advertises at under
 * ten milliseconds is not something a progress bar could usefully show anyway.
 */
export type ShapesProgressNote = never;

export type { ModelPhase, ProgressEvent };
