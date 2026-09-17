import { toDesertAntError } from '@desert-ant-labs/react-native-core';

import { type Point, type Shape } from './types';

const MODEL = 'shapes';

/** Upstream's own default for `Shape.outline(samples:)`. Only an ellipse reads
 *  it; every other kind's outline is already a short list of exact points. */
export const DEFAULT_OUTLINE_SAMPLES = 96;

/**
 * The shape as a polyline you can draw: a list of points to connect in order,
 * closed for every kind except a line.
 *
 * ```ts
 * const { shape } = await shapes.recognize(stroke);
 * if (shape) drawPolyline(outline(shape), { closed: shape.kind !== 'line' });
 * ```
 *
 * **Ported rather than bound, and this is the one place in this package where
 * that choice was close.** Upstream's Swift SDK has `Shape.outline(samples:)`,
 * plus `cgOutline` and a ready `CGPath` on Apple. `ai.desertant:shapes` has
 * nothing equivalent -- its whole public surface is `Shapes`, `Shape`, `Point`,
 * `Options` and `ShapesException`. So bridging the Swift one would have made the
 * *rendering* call iOS-only, and a shape SDK whose shapes cannot be drawn on
 * Android is not a shape SDK. Writing it once in Kotlin and once in Swift is the
 * same duplication in two languages instead of one, with a bridge hop per frame
 * on top.
 *
 * What makes it safe to port is that there is almost nothing to port. A line, a
 * rectangle and a triangle *are* their outlines -- the points come straight back
 * out of the union, untouched. The only arithmetic is the ellipse and the star,
 * and both are closed-form parametrizations fully determined by the field
 * documentation upstream publishes: an ellipse sampled uniformly in its own frame
 * and rotated into place, and a star alternating outer and inner radius across
 * `2 * pointCount` evenly spaced angles from `rotation - PI/2`. The unit tests
 * pin both against values computed independently of this code.
 *
 * Pure and synchronous: no model, no handle, no bridge. It runs on a device that
 * has never downloaded a weight.
 *
 * @param shape a shape from {@link Recognition.shape}.
 * @param samples how finely to sample an ellipse. Ignored by every other kind --
 *   a rectangle has four corners whatever this says. Defaults to 96, which is
 *   upstream's default. Must be an integer of at least 3: upstream divides by it
 *   and would hand back `NaN` coordinates for 0, which is refused here instead.
 */
export function outline(shape: Shape, samples: number = DEFAULT_OUTLINE_SAMPLES): Point[] {
  if (!shape || typeof shape !== 'object' || typeof (shape as Shape).kind !== 'string') {
    throw invalid('outline needs a shape; pass the `shape` from a recognition');
  }
  if (!Number.isInteger(samples) || samples < 3) {
    throw invalid(`'${String(samples)}' is not a sample count; expected an integer of at least 3`);
  }
  switch (shape.kind) {
    case 'line':
      return [shape.from, shape.to];
    case 'rectangle':
      return [...shape.corners];
    case 'triangle':
      return [...shape.vertices];
    case 'ellipse': {
      // The ellipse in its own frame, then rotated into the canvas. Matches
      // `Shape.outline(samples:)`: x = major*cos t, y = minor*sin t, rotated by
      // (cos r, sin r).
      const cos = Math.cos(shape.rotation);
      const sin = Math.sin(shape.rotation);
      const points: Point[] = [];
      for (let i = 0; i < samples; i += 1) {
        const t = (2 * Math.PI * i) / samples;
        const x = shape.semiMajor * Math.cos(t);
        const y = shape.semiMinor * Math.sin(t);
        points.push({
          x: shape.center.x + x * cos - y * sin,
          y: shape.center.y + x * sin + y * cos,
        });
      }
      return points;
    }
    case 'star': {
      // `2 * pointCount` vertices, alternating radius, the first one at
      // `rotation - PI/2` -- straight up when the rotation is zero.
      const steps = shape.pointCount * 2;
      const points: Point[] = [];
      for (let i = 0; i < steps; i += 1) {
        const angle = shape.rotation - Math.PI / 2 + (i * Math.PI) / shape.pointCount;
        const radius = i % 2 === 0 ? shape.outerRadius : shape.innerRadius;
        points.push({
          x: shape.center.x + radius * Math.cos(angle),
          y: shape.center.y + radius * Math.sin(angle),
        });
      }
      return points;
    }
    default:
      // Not reachable through the public type, and reachable through a cast or a
      // future upstream class. Loud rather than an empty array: an outline that
      // silently draws nothing looks exactly like a model that found nothing.
      throw invalid(
        `'${String((shape as { kind: unknown }).kind)}' is not a shape kind this SDK can draw`
      );
  }
}

/**
 * Whether a shape's outline should be drawn closed.
 *
 * `true` for everything but a line, which is upstream's own rule -- the `CGPath`
 * it builds on Apple calls `closeSubpath()` for every case except `.line`.
 * Trivial, and here so that a renderer does not have to re-derive it and get the
 * line wrong.
 */
export function isClosed(shape: Shape): boolean {
  return shape.kind !== 'line';
}

function invalid(message: string) {
  return toDesertAntError(Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }), MODEL);
}
