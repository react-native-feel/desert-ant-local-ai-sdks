package ai.desertant.rn.shapes

import ai.desertant.shapes.Options
import ai.desertant.shapes.Point
import ai.desertant.shapes.Shape
import ai.desertant.shapes.Shapes
import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.sharedobjects.SharedObject

/**
 * The model handle. One instance owns one LiteRT session, so an app creates it
 * once and reuses it.
 *
 * The Apple counterpart (ios/ShapesModel.swift) reports real progress fractions
 * because the Swift SDK's `download` takes a handler. This one cannot:
 * `ai.desertant:shapes`'s `download()` is a bare suspending function with no
 * callback, so what it emits is phase boundaries -- 0 on entering `loadingModel`,
 * 1 on leaving it. `ProgressEvent.fraction` in the TypeScript types says so. For
 * this model in particular the difference is close to academic: the download is
 * 1.3 MB.
 *
 * Results are held rather than returned, keyed by job id, for the same reason the
 * Apple half holds them -- see the long note on `ShapesModelObject.recognize`
 * there. Kotlin has no encode-on-the-wrong-thread hazard; it holds them anyway so
 * that the TypeScript above it is one implementation rather than two.
 *
 * Shapes is the sixth model in this repo with an Android half, after Clear, Emo,
 * Ear, Gist and Redact: `desert-ant-core` publishes a LiteRT export of it and
 * `ai.desertant:shapes` is on Maven Central. Voz, Clips and Uhm have no Android
 * build to bind to.
 *
 * **This half has never been compiled.** There is no Android SDK on the machine
 * this package was written on -- `ANDROID_HOME` points at a directory with no
 * `platforms` and no `build-tools`, and there is no `sdkmanager` to fetch them --
 * so what is here is written against the published Kotlin API and reviewed
 * against it, and nothing more than that should be read into it. See the README.
 */
class ShapesModelObject(
  context: Context,
  options: ShapesLoadOptions,
) : SharedObject() {

  private val shapes = Shapes(context.applicationContext, options.directory)
  private var released = false

  private val results = Object()
  private val recognitions = HashMap<String, Map<String, Any?>>()

  fun isDownloaded(): Boolean = alive().isDownloaded()

  /**
   * Download the weights and build the session.
   *
   * The two are fused upstream on both platforms, so this is what `warm()` and
   * `download()` in TypeScript both land on. The failure is classified the same
   * way the Apple half classifies it -- the files being on disk afterwards is
   * what separates "the download failed" from "the session refused to build" --
   * so a caller's retry button means the same thing on both.
   */
  suspend fun load(emit: (String, Double) -> Unit) {
    emit("loadingModel", 0.0)
    try {
      alive().download()
    } catch (e: Exception) {
      val detail = "${e.javaClass.simpleName}: ${e.message}"
      throw if (isDownloaded()) {
        ModelLoadFailedException(detail)
      } else {
        ModelUnavailableException(detail)
      }
    }
    emit("loadingModel", 1.0)
  }

  /**
   * Recognize the stroke in [coordinates] and hold the result under [jobId].
   *
   * A stroke of fewer than two points is answered here without loading the model,
   * which is upstream's own behaviour rather than this package's: `Shapes.kt`
   * opens with `if (points.size < 2) return null` for exactly this reason, and
   * the Apple half reaches the same nil. Doing it before `load` is what makes an
   * empty canvas free on a device that has never downloaded the weights.
   */
  suspend fun recognize(
    coordinates: DoubleArray,
    options: ShapesRecognizeOptions,
    jobId: String,
    emit: (String, Double) -> Unit,
  ) {
    val points = stroke(coordinates)
    val resolved = Options(minimumConfidence = options.resolvedConfidence())
    if (points.size < 2) {
      put(jobId, recognition(null, 0.0))
      return
    }
    load(emit)
    val started = System.nanoTime()
    val shape = try {
      alive().recognize(points, resolved)
    } catch (e: CodedException) {
      throw e
    } catch (e: IllegalArgumentException) {
      throw InvalidArgumentException("${e.message}")
    } catch (e: Exception) {
      throw InferenceFailedException("${e.javaClass.simpleName}: ${e.message}")
    }
    put(jobId, recognition(shape, seconds(started)))
  }

  /** The recognition held for [jobId], removed as it is read. */
  fun takeRecognition(jobId: String): Map<String, Any?> = synchronized(results) {
    recognitions.remove(jobId)
      ?: throw InferenceFailedException("no recognition is waiting for job $jobId")
  }

  /**
   * Rebuild the stroke from the flat `[x, y, x, y, ...]` the caller sent,
   * refusing what upstream would silently mangle. Mirrors
   * `shapesStroke(from:)` in ios/ShapesRecords.swift, including which failures
   * are refusals and which are results.
   */
  private fun stroke(coordinates: DoubleArray): List<Point> {
    if (coordinates.size % 2 != 0) {
      throw InvalidStrokeException(
        "${coordinates.size} coordinates is an odd number; a stroke is flat x, y pairs"
      )
    }
    val points = ArrayList<Point>(coordinates.size / 2)
    var index = 0
    while (index < coordinates.size) {
      val x = coordinates[index]
      val y = coordinates[index + 1]
      if (!x.isFinite() || !y.isFinite()) {
        throw InvalidStrokeException(
          "point ${index / 2} is ($x, $y); every coordinate must be a finite number"
        )
      }
      points.add(Point(x, y))
      index += 2
    }
    return points
  }

  /**
   * Flatten one fitted shape onto the wire.
   *
   * Returned as maps rather than `Record`s: records are an argument type on
   * Android, and the return path wants maps. The keys are the Apple
   * `ShapesRecognition` field names.
   *
   * The `else` branch is the one thing this half has that the Apple half does
   * not need. There, the `switch` is exhaustive over a public Swift enum compiled
   * against, so a sixth class upstream breaks the build. Here the sealed class is
   * resolved out of a Maven artifact at runtime, so a `shapes` AAR newer than
   * this module can hand back a subclass that did not exist when this was
   * written. `ai.desertant:shapes`'s own FFI decoder answers that case with
   * `null` -- "report it as no shape rather than half-decoding a payload we
   * cannot read" -- which is right for a decoder and wrong here: `null` is
   * already the answer for a *rejected* stroke, and the two mean opposite things.
   * So this refuses loudly and names the class it did not know.
   */
  private fun recognition(shape: Shape?, processingSec: Double): Map<String, Any?> {
    val base = mutableMapOf<String, Any?>(
      "kind" to null,
      "points" to emptyList<Double>(),
      "semiMajor" to 0.0,
      "semiMinor" to 0.0,
      "outerRadius" to 0.0,
      "innerRadius" to 0.0,
      "rotation" to 0.0,
      "pointCount" to 0,
      "processingSec" to processingSec,
      "modelRevision" to MODEL_REVISION,
    )
    when (shape) {
      null -> Unit
      is Shape.Line -> {
        base["kind"] = "line"
        base["points"] = flatten(listOf(shape.from, shape.to))
      }
      is Shape.Rectangle -> {
        base["kind"] = "rectangle"
        base["points"] = flatten(shape.corners)
      }
      is Shape.Triangle -> {
        base["kind"] = "triangle"
        base["points"] = flatten(shape.vertices)
      }
      is Shape.Ellipse -> {
        base["kind"] = "ellipse"
        base["points"] = flatten(listOf(shape.center))
        base["semiMajor"] = shape.semiMajor
        base["semiMinor"] = shape.semiMinor
        base["rotation"] = shape.rotation
      }
      is Shape.Star -> {
        base["kind"] = "star"
        base["points"] = flatten(listOf(shape.center))
        base["outerRadius"] = shape.outerRadius
        base["innerRadius"] = shape.innerRadius
        base["rotation"] = shape.rotation
        base["pointCount"] = shape.pointCount
      }
      else -> throw InferenceFailedException(
        "ai.desertant:shapes reported a shape class this module does not know: " +
          "${shape.javaClass.simpleName}. Update @desert-ant-labs/react-native-shapes."
      )
    }
    return base
  }

  private fun flatten(points: List<Point>): List<Double> {
    val out = ArrayList<Double>(points.size * 2)
    for (p in points) {
      out.add(p.x)
      out.add(p.y)
    }
    return out
  }

  private fun put(jobId: String, value: Map<String, Any?>) {
    synchronized(results) { recognitions[jobId] = value }
  }

  private fun seconds(startedNanos: Long) = (System.nanoTime() - startedNanos) / 1_000_000_000.0

  /** Hand the native model back. */
  @Synchronized
  fun release() {
    if (released) return
    released = true
    synchronized(results) { recognitions.clear() }
    shapes.close()
  }

  override fun sharedObjectDidRelease() = release()

  private fun alive(): Shapes {
    if (released) throw ReleasedException("ShapesModel")
    return shapes
  }

  private companion object {
    /**
     * `ShapesModel.revision` on the Apple side, which reads the catalog. The
     * Kotlin SDK exposes neither it nor the repo -- `ai.desertant:shapes`
     * publishes `Shapes`, `Shape`, `Point`, `Options` and `ShapesException`, and
     * its `companion object` is empty -- so it is a constant here, pinned to the
     * SDK version in build.gradle: revision `v0.3.0` is what
     * `ai.desertant:shapes:3.1.0` resolves.
     */
    const val MODEL_REVISION = "v0.3.0"
  }
}
