// The model handle. One instance owns one loaded Core ML program, so an app
// creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `ShapesModule`
// exposes these as module-level `@JS async` functions; see the note at the top
// of ShapesModule.swift.

import DesertAnt
import ExpoModulesCore
import Foundation
import Shapes

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the
// Swift SDK invokes from its own tasks -- can capture `self`. What it touches is
// a `let` and lock-guarded state, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("ShapesModel")
final class ShapesModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Whether this build can run Shapes at all.
  ///
  /// Reads the catalog rather than answering `true`: `ShapesModel.files` is the
  /// upstream statement of which platforms have an artifact, and on Apple it
  /// does. Like Ear, Gist and Redact and unlike Clips there is no second,
  /// OS-level check to make -- `Catalog.swift` declares no `osFloor`, so the
  /// model inherits `OSFloor.packageFloor` (iOS 16) and `shapes.mlmodelc` loads
  /// anywhere the pod's own deployment target already allows.
  static var isSupported: Bool { ShapesModel.supports(.current) }

  private let shapes: Shapes
  private let progressGate = ProgressGate()

  /// Results waiting to be handed over, keyed by the job that produced them.
  ///
  /// Keyed rather than a single slot so two concurrent `recognize` calls on one
  /// model cannot take each other's answer -- the same reason every entry point
  /// in this family carries a job id. Entries are removed on read, so nothing
  /// accumulates. That matters a little more here than it reads: this is the one
  /// model in the family whose calls are plausibly issued a few per second, from
  /// a canvas that just saw three fingers lift at once.
  private let resultsLock = NSLock()
  private var recognitions: [String: ShapesRecognition] = [:]

  /// Emitted while the model downloads and loads, and at no other time.
  /// Recognition reports nothing: upstream's `recognize(points:options:)` takes
  /// no handler, and the pass is under ten milliseconds.
  @Event
  var onProgress: (ShapesProgressEvent) -> Void

  init(directory: String?) {
    // Construction does no work and starts no download; the model loads on the
    // first `load` or `recognize`, off the calling thread.
    self.shapes = Shapes(directory: directory)
    super.init()
  }

  /// Whether the weights are on the device, so recognition needs no network.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    shapes.isDownloaded()
  }

  // MARK: - Work (driven by ShapesModule)

  /// Download the weights and build the session.
  ///
  /// One call rather than two, because upstream fuses them: `Shapes.download`
  /// runs the whole loader -- resolve the files, then build the Core ML session
  /// -- reporting a fraction across the download. There is no download-only
  /// entry point to expose, so `warm()` and `download()` in TypeScript both land
  /// here.
  ///
  /// The download is 0.2 MB on Apple, which is the smallest in this family by a
  /// factor of twenty-five and small enough that the progress fraction it reports
  /// will usually be one tick. It is wired anyway, because what it costs is one
  /// closure and what it buys is the same lifecycle every other model here has.
  ///
  /// The failure is classified rather than assumed, because both stages throw out
  /// of the same call and they are different problems for a caller: a download
  /// that failed is worth a retry button, a session that refused to build is not.
  /// The files being on disk afterwards is what separates them.
  func load(jobId: String) async throws {
    do {
      try await shapes.download { [weak self] fraction in
        self?.report(jobId, fraction: fraction)
      }
    } catch {
      let downloaded = shapes.isDownloaded()
      throw Self.mapped(
        error,
        fallback: { downloaded ? ModelLoadFailedException($0) : ModelUnavailableException($0) })
    }
  }

  /// Recognize one stroke, and store the result for `jobId` rather than returning
  /// it.
  ///
  /// Returning nothing is the point, and it is the fourth Expo Modules 2.0 limit
  /// this repo has had to design around rather than a caching decision.
  ///
  /// **A `@JS async` function's return value can be encoded off the JavaScript
  /// thread.** The crash is a segfault on
  /// `com.apple.root.user-initiated-qos.cooperative` rather than on
  /// `com.facebook.react.runtime.JavaScript`, and `@JavaScriptActor` on the
  /// function does not prevent it -- the return value is encoded after the actor
  /// hop the annotation governs. Ear hit it returning `[String]`, Clear through
  /// `Record.encode` and `ClearMetrics.toObject`, and Redact designed around it
  /// from the start. "Small values are safe" is not a reading anyone should still
  /// be holding -- and a `ShapesRecognition` carries a `[Double]`, which is the
  /// *shape* of the value that took Ear down.
  ///
  /// Returning `Void` is necessary and **not sufficient**, which this model is the
  /// package that proved: `ShapesModule.load` returns nothing and still crashed in
  /// `JavaScriptValuesBuffer.deinit`, because the same closure destroys the call's
  /// *arguments* on the same thread. That half is handled by `onJavaScriptThread`
  /// in ShapesModule.swift. See docs/architecture.md, limit 4.
  ///
  /// The async half therefore returns `Void`; `takeRecognition` is synchronous
  /// and so runs on the JavaScript thread by construction.
  ///
  /// `load` is called explicitly first even though `Shapes.recognize` would load
  /// lazily anyway, and it is not belt-and-braces. Upstream's lazy load happens
  /// *inside* the call, so a failed download would come back out of the same call
  /// as an inference failure and be reported as `ERR_INFERENCE_FAILED` -- a
  /// caller offering "retry the download" would never see the case it exists for.
  /// It costs nothing once loaded: the loader single-flights and returns its
  /// cached value.
  func recognize(
    coordinates: [Double],
    options: ShapesRecognizeOptions,
    jobId: String
  ) async throws {
    let points = try shapesStroke(from: coordinates)
    let resolved = Options(minimumConfidence: try options.resolvedConfidence())

    // A stroke that cannot be a stroke is answered here rather than by waking the
    // model. This is not a refusal and not an optimization of this package's
    // invention: `ai.desertant:shapes`'s own `recognize` opens with
    // `if (points.size < 2) return null`, and the Swift path reaches the same nil
    // one layer deeper through `DegenerateStrokeError`. Doing it before `load`
    // is what makes an empty canvas free on a device that has never downloaded
    // the weights.
    guard points.count >= 2 else {
      store(shapesRecognition(from: nil, processingSec: 0), for: jobId)
      return
    }

    try await load(jobId: jobId)
    let started = ContinuousClock.now
    do {
      let shape = try await shapes.recognize(points: points, options: resolved)
      store(
        shapesRecognition(from: shape, processingSec: Self.elapsed(since: started)),
        for: jobId)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
  }

  // MARK: - Handing results over

  /// The recognition computed for `jobId`, removed as it is read.
  ///
  /// Synchronous so the record is encoded on the JavaScript thread. See
  /// `recognize` for why that is load-bearing rather than incidental.
  @JS
  func takeRecognition(_ jobId: String) throws -> ShapesRecognition {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let recognition = recognitions.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no recognition is waiting for job \(jobId)")
    }
    return recognition
  }

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an async one, and holding it across an `await` is what that
  /// rule exists to prevent.
  private func store(_ recognition: ShapesRecognition, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    recognitions[jobId] = recognition
  }

  // MARK: - Helpers

  private static func elapsed(since started: ContinuousClock.Instant) -> Double {
    let components = started.duration(to: .now).components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  ///
  /// `ShapesError` is the only typed one upstream throws from this path, and it
  /// has exactly two cases; anything else (a URLSession failure inside the
  /// download, a Core ML load failure) falls through to the caller's own default,
  /// which is why `fallback` is a parameter rather than a fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let shapesError = error as? ShapesError {
      switch shapesError {
      case .resourceMissing:
        return ModelUnavailableException("a Shapes model resource was not found")
      case .predictionFailed:
        return InferenceFailedException("on-device shape recognition failed")
      }
    }
    if error is CancellationError {
      return InferenceFailedException("cancelled")
    }
    return fallback(String(describing: error))
  }

  // MARK: - Progress

  /// Called from whatever context the download is on, so it hops to the
  /// JavaScript actor before touching the event.
  private func report(_ jobId: String, fraction: Double) {
    guard progressGate.shouldEmit(fraction: fraction) else {
      return
    }
    Task { @JavaScriptActor [weak self] in
      self?.onProgress(
        ShapesProgressEvent(jobId: jobId, phase: "loadingModel", fraction: fraction))
    }
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per chunk. The terminal `1.0` always passes.
private final class ProgressGate: @unchecked Sendable {
  private let lock = NSLock()
  private var lastEmit = Date.distantPast

  private static let interval: TimeInterval = 0.05

  func shouldEmit(fraction: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let now = Date()
    if fraction >= 1 || now.timeIntervalSince(lastEmit) >= Self.interval {
      lastEmit = now
      return true
    }
    return false
  }
}
