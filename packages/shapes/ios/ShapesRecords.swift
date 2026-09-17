// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.
//
// What matters is *where* these are encoded: everything in this file is handed to
// JavaScript from a synchronous member, never returned from a `@JS async`
// function. See ShapesModel.swift.

import DesertAnt
import ExpoModulesCore
import Shapes

/// How a `ShapesModel` finds its weights.
///
/// One field, like Redact's and unlike Gist's: there is no variant to pick.
/// `Catalog.swift` declares a single artifact per platform -- `shapes.mlmodelc`
/// on Apple, `shapes.tflite` everywhere else -- so the only thing to say is where
/// it lives.
@Record
struct ShapesLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the weights itself points at the folder holding them. Nil uses the
  /// managed platform cache.
  var directory: String?
}

/// One `recognize` call's settings.
///
/// One field, because upstream's `Options` has one. Its other member, `snap`, is
/// `internal` in `Sources/Shapes/Shapes.swift` -- the regularization thresholds
/// (5 degrees to an axis, 15-degree rotation increments, 0.25 to a circle or a
/// square) are not a public knob on any of the three SDKs, so there is nothing
/// here to forward and nothing invented.
@Record
struct ShapesRecognizeOptions {
  /// Minimum classifier confidence, **on top of** each class's calibrated gate.
  /// Upstream's own default is `0`, which applies only the model's gates.
  var minimumConfidence: Double = 0

  /// Validated rather than clamped.
  ///
  /// Upstream's `Options.init` runs `minimumConfidence.isFinite ? min(1, max(0,
  /// minimumConfidence)) : 0`, so `95` (meaning "95%") silently becomes `1.0` and
  /// rejects every stroke the model draws, while `NaN` silently becomes `0` and
  /// rejects nothing. Both look like a working recognizer that has stopped
  /// recognizing. The Kotlin SDK does not clamp at all -- it writes the `f64`
  /// straight onto the FFI and lets the Swift initializer on the other side do
  /// it -- so the two agree only by accident. This refuses instead, on both
  /// platforms and in TypeScript before either.
  func resolvedConfidence() throws -> Double {
    guard minimumConfidence.isFinite, minimumConfidence >= 0, minimumConfidence <= 1 else {
      throw InvalidConfidenceException(minimumConfidence)
    }
    return minimumConfidence
  }
}

/// What a `recognize` call produced.
///
/// **Flat, where the model's own type is a sum.** Upstream's `Shape` is a Swift
/// enum with associated values and a Kotlin sealed class; `@Record` has no sum
/// type and neither does a JavaScript object literal, so the wire carries a
/// `kind` tag plus that kind's fields, which is exactly what upstream's own FFI
/// binding writes (`Sources/Shapes/Binding.swift`: `u32 kind` then the fields).
/// `src/Shapes.ts` narrows it back into a discriminated union, which is the type
/// a caller actually sees -- so the flatness is a wire format rather than an API.
///
/// `points` is a flat `[x, y, x, y, ...]` array rather than an array of point
/// records, for the same reason the input is: a stroke is hundreds of points, one
/// convention for both directions is one thing to get right, and a `[Double]` is
/// the cheapest thing that crosses. A fitted shape is at most four points, so the
/// saving is on the way in; the consistency is on the way out.
@Record
struct ShapesRecognition {
  /// `"line"`, `"rectangle"`, `"triangle"`, `"ellipse"`, `"star"` -- or **nil**,
  /// which is the answer for a stroke the model rejected or found degenerate.
  ///
  /// Nil is a result, not an error. Upstream's `recognize` returns `Shape?` and
  /// documents the nil: the classifier proposed a class whose calibrated
  /// confidence gate it did not clear, the geometric fit's residual was worse
  /// than that class's residual gate, the top class was the reject class, or the
  /// stroke was too short to be a stroke. Rejecting a scribble is what this model
  /// is for as much as fitting a circle is.
  var kind: String?

  /// The kind's points, flattened. `line`: from, to. `rectangle`: four corners in
  /// order around the perimeter. `triangle`: three vertices. `ellipse` and
  /// `star`: the center alone, with the rest of the geometry in the fields below.
  var points: [Double] = []

  /// `ellipse` only: the semi-axes, in canvas units.
  var semiMajor: Double = 0
  var semiMinor: Double = 0

  /// `star` only: the two radii it alternates between, in canvas units.
  var outerRadius: Double = 0
  var innerRadius: Double = 0

  /// `ellipse` and `star`: rotation in radians. Snapped to 15-degree increments
  /// for an ellipse by upstream's regularization, which is not configurable.
  var rotation: Double = 0

  /// `star` only: how many points it has.
  var pointCount: Int = 0

  /// Wall clock around the whole call.
  var processingSec: Double = 0

  /// The pinned model revision this came from, so a benchmark or a telemetry
  /// event is self-identifying.
  var modelRevision: String?
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
///
/// `phase` is only ever `loadingModel`: upstream's `recognize(points:options:)`
/// takes no progress handler on either platform, and the pass itself is under ten
/// milliseconds, so there is no recognition fraction to report and none is
/// invented.
@Record
struct ShapesProgressEvent {
  var jobId: String = ""
  var phase: String = ""
  var fraction: Double = 0
}

// MARK: - Mapping

/// Flatten one fitted shape onto the wire.
///
/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
///
/// The `switch` is exhaustive with no `default`, deliberately. `FittedShape` is a
/// public enum in a package this pod is compiled against, so a sixth case
/// upstream breaks this file at **compile** time -- which is the right place to
/// find out that the model learned a new class. The Android half cannot have
/// that guarantee (a sealed class resolved from a Maven artifact at runtime), so
/// it refuses loudly instead; see ShapesModelObject.kt.
func shapesRecognition(
  from shape: FittedShape?,
  processingSec: Double
) -> ShapesRecognition {
  var record = ShapesRecognition()
  record.processingSec = processingSec
  record.modelRevision = ShapesModel.revision
  guard let shape else {
    return record
  }
  switch shape {
  case let .line(from, to):
    record.kind = "line"
    record.points = flatten([from, to])
  case let .rectangle(corners):
    record.kind = "rectangle"
    record.points = flatten(corners)
  case let .triangle(vertices):
    record.kind = "triangle"
    record.points = flatten(vertices)
  case let .ellipse(center, semiMajor, semiMinor, rotation):
    record.kind = "ellipse"
    record.points = flatten([center])
    record.semiMajor = semiMajor
    record.semiMinor = semiMinor
    record.rotation = rotation
  case let .star(center, outerRadius, innerRadius, rotation, pointCount):
    record.kind = "star"
    record.points = flatten([center])
    record.outerRadius = outerRadius
    record.innerRadius = innerRadius
    record.rotation = rotation
    record.pointCount = pointCount
  }
  return record
}

private func flatten(_ points: [CanvasPoint]) -> [Double] {
  var out: [Double] = []
  out.reserveCapacity(points.count * 2)
  for point in points {
    out.append(point.x)
    out.append(point.y)
  }
  return out
}

/// Rebuild the stroke from the flat `[x, y, x, y, ...]` the caller sent, refusing
/// what upstream would silently mangle.
///
/// Two refusals, both of them things neither upstream SDK checks:
///
///   * an **odd** length, which means the caller's flattening lost a coordinate.
///     Upstream's FFI reads `u32 count` and then that many pairs, so a truncated
///     payload there is a buffer overrun rather than a question; here the array
///     length is the only count there is, and an odd one is a bug with no
///     defensible reading.
///   * a **non-finite** coordinate. `StrokePreprocessor` does not reject one:
///     its dedupe test is `abs(dx) > epsilon`, false for `NaN`, so the point is
///     silently dropped and whatever survives is classified anyway. The answer is
///     a real `Shape` with `NaN` in its geometry, which renders as nothing and
///     reads as a model that stopped working.
///
/// Fewer than two points is **not** refused: it is upstream's own "no shape"
/// answer on both platforms (`Shapes.kt` returns null before waking the model;
/// Swift's preprocessor raises `DegenerateStrokeError`, which `recognize`
/// converts to nil), and a result is not an error.
func shapesStroke(from coordinates: [Double]) throws -> [CanvasPoint] {
  guard coordinates.count % 2 == 0 else {
    throw InvalidStrokeException(
      "\(coordinates.count) coordinates is an odd number; a stroke is flat x, y pairs")
  }
  var points: [CanvasPoint] = []
  points.reserveCapacity(coordinates.count / 2)
  var index = 0
  while index < coordinates.count {
    let x = coordinates[index]
    let y = coordinates[index + 1]
    guard x.isFinite, y.isFinite else {
      throw InvalidStrokeException(
        "point \(index / 2) is (\(x), \(y)); every coordinate must be a finite number")
    }
    points.append(CanvasPoint(x: x, y: y))
    index += 2
  }
  return points
}
