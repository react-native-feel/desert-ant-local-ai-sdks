// The model handle. One instance owns one parsed copy of the weights, so an app
// creates it once and reuses it.
//
// The one asynchronous thing here is `load`, and it is `internal` rather than
// `@JS` -- the `@SharedObject` macro can only bind synchronous members onto the
// JS prototype. `TongueModule` exposes it as a module-level `@JS async` function;
// see the note at the top of TongueModule.swift.
//
// Everything else is synchronous, including the detection, which is the whole
// character of this model: 2 MB of int8 read once, and thereafter an embedding
// gather, a sum, one 59x32 matmul and a masked softmax per call.

import ExpoModulesCore
import Foundation

#if canImport(Tongue)
import DesertAnt
import Tongue
#endif

/// `@unchecked Sendable` because the parsed pipeline is guarded by a lock the
/// compiler cannot see through `SharedObject`. What it protects is one optional
/// `let`-once value; everything else on this class is immutable.
@SharedObject("TongueModel")
final class TongueModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// Why the Apple half is inert, when it is.
  ///
  /// Not a platform limitation and not a missing artifact: one line in
  /// desert-ant-core's package manifest. See `TongueModule.unsupportedReason`
  /// and packages/core/ios/DesertAntCore.podspec.
  static let productMissingReason =
    "desert-ant-core v3.1.0 declares a `Tongue` SwiftPM product and never adds it to the "
    + "package's `products:` array, so no consumer can link the target. The Apple half of "
    + "this SDK is written and waiting behind `#if canImport(Tongue)`; the Android half, "
    + "which binds the pure-Kotlin `ai.desertant:tongue` jar, is unaffected."

#if canImport(Tongue)

  /// Whether this build can run Tongue at all.
  ///
  /// Reads the catalog rather than answering `true`, the way every other model
  /// here does -- but for Tongue the catalog says yes on every platform it lists
  /// (`.apple`, `.android`, `.linux`, `.web`) and there is no second, OS-level
  /// check to make. Tongue declares no `osFloor` above the package's, and there
  /// is no compiled artifact whose real floor could disagree with the declared
  /// one: the "artifact" is a table of bytes.
  static var isSupported: Bool { TongueModel.supports(.current) }

  /// The parsed pipeline, or nil before `load` has run.
  ///
  /// `Tongue` is a `Sendable` struct of two immutable arrays, so the lock guards
  /// the *assignment*, not the use: once stored it is read without contention
  /// from the JavaScript thread on every `detect`.
  private let lock = NSLock()
  private var tongue: Tongue?
  private var released = false

  override init() {
    // Construction reads nothing. The 2 MB is read by `load`, off the calling
    // thread -- it is a fast read and a slow-ish widen, and neither belongs on
    // the JavaScript thread.
    super.init()
  }

  /// Whether the weights are parsed, so `detect` will answer rather than refuse.
  ///
  /// This is where every other model in this repo has `isDownloaded()`. The
  /// question does not exist for Tongue -- nothing is ever absent from the device
  /// -- so the useful question is whether the read has happened yet.
  @JS
  func isLoaded() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return tongue != nil
  }

  // MARK: - Work (driven by TongueModule)

  /// Read the bundled weights and build the pipeline. Idempotent.
  ///
  /// `async` for one reason, and it is not I/O concurrency: this runs off the
  /// JavaScript thread. `Weights.init` widens 2,097,152 bytes into `[Int8]` and
  /// decodes ~7,500 fp32s without assuming alignment, which is milliseconds
  /// rather than microseconds and is the only part of this model that is.
  func load() async throws {
    if isLoaded() { return }
    let built = try Self.makeTongue()
    lock.lock()
    defer { lock.unlock() }
    // A second `load` racing the first is harmless -- the value is deterministic
    // -- so the loser simply drops its copy rather than the two contending.
    if tongue == nil { tongue = built }
  }

  /// Identify the language of `text`.
  ///
  /// Synchronous, and called from the JavaScript thread on purpose. Upstream
  /// measures a detection in tens of microseconds and documents it as a main
  /// thread call; hopping to another executor and back would cost more than the
  /// model, and would put the encode of the result off the JavaScript thread --
  /// which is the Expo Modules 2.0 hazard (limit 4) that cost this repo a day
  /// during Ear.
  ///
  /// Refuses rather than loading lazily. A lazy load here would read 2 MB on the
  /// JavaScript thread behind the caller's back; `TongueModule` has an async
  /// `load` for exactly that, and `Tongue.detect()` in TypeScript awaits it.
  func detect(_ text: String, options: TongueDetectOptions) throws -> TongueDetection {
    let topK = try options.resolvedTopK()
    guard let model = loaded() else {
      throw ModelUnavailableException(
        "the weights have not been read yet -- await `Tongue.load()` or `warm()` first")
    }
    let started = ContinuousClock.now
    let detection = model.detect(text, topK: topK)
    let components = started.duration(to: .now).components
    let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
    return tongueDetection(from: detection, processingSec: seconds)
  }

  private func loaded() -> Tongue? {
    lock.lock()
    defer { lock.unlock() }
    return released ? nil : tongue
  }

  override func sharedObjectDidRelease() {
    lock.lock()
    defer { lock.unlock() }
    released = true
    tongue = nil
  }

  // MARK: - Finding the bundled weights

  /// Build a `Tongue` from the weights shipped inside the package.
  ///
  /// Upstream's own `Tongue()` does this through `Bundle.module`, and this does
  /// not call it, for two reasons.
  ///
  /// The first is that `Bundle.module` **traps**. Its generated accessor calls
  /// `fatalError("unable to find bundle named DesertAnt_Tongue")`, which is not
  /// something a coded exception can be made out of: a missing resource would
  /// take the app down with no JavaScript error and no way for a caller to
  /// report it.
  ///
  /// The second is that the layout it assumes is not obviously the one this SDK
  /// gets. Tongue is the first product in `DESERT_ANT_PRODUCTS` to ship SwiftPM
  /// resources at all, and the package here is linked into a *pod* rather than
  /// into the app target -- React Native's `spm_dependency` adds the package
  /// product to `libDesertAntCore.a`, and CocoaPods then links that into the
  /// app. Whether the `.bundle` rides along to the same place `Bundle.module`
  /// looks is a property of that pipeline, not of the package.
  ///
  /// So this searches instead: every bundle the process has loaded, plus any
  /// nested `.bundle` inside them, for the two files by name. That is a superset
  /// of what `Bundle.module` checks, so anything it would have found is found
  /// here -- and when nothing is found the result is `ERR_MODEL_UNAVAILABLE`
  /// with a sentence, not a trap.
  private static func makeTongue() throws -> Tongue {
    guard let urls = bundledModelURLs() else {
      throw ModelUnavailableException(
        "tongue_int8.bin and tongue_meta.json were not found in any loaded bundle. They are "
          + "SwiftPM resources of the desert-ant-core `Tongue` target; a build that drops the "
          + "package's resource bundle drops the model with it.")
    }
    do {
      return try Tongue(weightsURL: urls.weights, metadataURL: urls.metadata)
    } catch let error as TongueError {
      // Every case upstream throws from this path is a broken or mismatched
      // resource, which is a load failure rather than a missing model.
      throw ModelLoadFailedException(error.description)
    } catch {
      throw ModelLoadFailedException(String(describing: error))
    }
  }

  /// Search the loaded bundles for the two resource files.
  ///
  /// Ordered cheapest-first: the app itself, then this pod's own bundle, then
  /// everything loaded, then one level of nested `.bundle` directories -- which
  /// is where a SwiftPM resource bundle lands when it is copied into an app.
  private static func bundledModelURLs() -> (weights: URL, metadata: URL)? {
    var roots = [Bundle.main, Bundle(for: TongueModelObject.self)]
    roots += Bundle.allBundles + Bundle.allFrameworks

    var seen = Set<URL>()
    for root in roots where seen.insert(root.bundleURL).inserted {
      if let found = modelURLs(in: root) {
        return found
      }
      guard let resources = root.resourceURL,
        let nested = try? FileManager.default.contentsOfDirectory(
          at: resources, includingPropertiesForKeys: nil)
      else { continue }
      for url in nested where url.pathExtension == "bundle" {
        if let bundle = Bundle(url: url), let found = modelURLs(in: bundle) {
          return found
        }
      }
    }
    return nil
  }

  private static func modelURLs(in bundle: Bundle) -> (weights: URL, metadata: URL)? {
    guard let weights = bundle.url(forResource: "tongue_int8", withExtension: "bin"),
      let metadata = bundle.url(forResource: "tongue_meta", withExtension: "json")
    else { return nil }
    return (weights, metadata)
  }

#else

  // The inert half. It exists rather than the file being empty because the
  // JavaScript surface has to be able to *ask* -- `requireOptionalNativeModule`
  // returning a module that answers `isSupported: false` with a sentence is a
  // much better failure than an import that resolves to null and leaves a caller
  // guessing whether the package was prebuilt.
  //
  // Everything here throws the same coded error the module's `createModel`
  // already throws, so nothing can reach it in practice; it is here so the two
  // branches present the same type.

  static var isSupported: Bool { false }

  @JS
  func isLoaded() -> Bool { false }

  func load() async throws {
    throw UnsupportedPlatformException(Self.productMissingReason)
  }

  func detect(_ text: String, options: TongueDetectOptions) throws -> TongueDetection {
    throw UnsupportedPlatformException(Self.productMissingReason)
  }

#endif
}
