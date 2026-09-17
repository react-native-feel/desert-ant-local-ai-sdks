// The model handle. One instance owns the resolved model folder and -- where the
// build can generate at all -- the loaded MLX generator, so an app creates it
// once and reuses it. Upstream is explicit that this is the intended shape:
// "Loading is expensive and generation is cheap: build one and reuse it."
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `TitleModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// TitleModule.swift.
//
// MARK: - What is and is not compiled here
//
// This file has two halves and only one of them is in the binary.
//
// The catalog half -- resolving, downloading, verifying and inspecting the seven
// files upstream declares -- is unconditional and works. `TitleModel` conforms to
// `ModelDeclaration`, so `resolve`, `isAvailable` and `distribution` come from the
// shared extension in `Sources/ModelCatalog/ModelDeclaration.swift` and know
// nothing about MLX. That half is real, it is exercised, and it is what the
// example app runs.
//
// The generating half is behind `#if canImport(MLXLMCommon)` and is NOT in the
// binary, because the `MLX` package trait that would put MLX in the graph cannot
// be enabled from a CocoaPods build. The full account is in TitleModule.swift and
// in the README. What matters here is the consequence: `Titles` -- upstream's
// actor -- has **no public initializer** without the trait, by design. Upstream's
// own header says so: "a consumer that forgot the trait fails at compile time
// instead of mis-building." So this is not a case of code that would work being
// switched off defensively; it is code that would not compile.
//
// The inert branch is written the way Tongue's is, and carries Tongue's caveat
// with it and then some: **it has never been compiled.** Tongue's inert half at
// least names a module that exists on the Android side of the same SDK. This one
// names `MLXLMCommon` types that have never been in this project's graph. Read it
// as a statement of intent about where the call goes, not as reviewed code.

import DesertAnt
import ExpoModulesCore
import Foundation
import Title

#if canImport(MLXLMCommon)
import MLXLMCommon
#endif

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the
// Swift SDK invokes from its own tasks -- can capture `self`. What it touches is
// a `let` and lock-guarded state, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("TitleModel")
final class TitleModelObject: SharedObject, @unchecked Sendable {

  /// The desert-ant-core version this binary links against.
  ///
  /// Read off the catalog rather than written down, unlike Align's, because
  /// Title publishes it: `ModelDeclaration` requires `sdkVersion`, and
  /// `TitleModel` declares `"3.1.0"`. A constant here would be a second copy of
  /// a number that already exists in the binary.
  static var coreVersion: String { TitleModel.sdkVersion }

  /// Whether this binary was built with the `MLX` package trait.
  ///
  /// `canImport(MLXLMCommon)` is a proxy for the trait rather than the trait
  /// itself -- Swift gives a consumer no way to test another package's
  /// compilation conditions -- but for this package the two cannot come apart.
  /// `Package.swift` declares mlx-swift-lm's products with
  /// `condition: .when(traits: ["MLX"])` and nothing else in the graph
  /// references them, so SwiftPM prunes the whole dependency unless the trait is
  /// on. If `MLXLMCommon` is importable here, the trait is on.
  static var mlxTraitEnabled: Bool {
    #if canImport(MLXLMCommon)
    return true
    #else
    return false
    #endif
  }

  /// Whether this build can write a card.
  ///
  /// Two questions, and today the second one answers no on every device. The
  /// catalog question -- does upstream ship a Title artifact for this platform --
  /// is yes on Apple and no everywhere else; `Sources/Title/Catalog.swift`
  /// declares `files` for `.apple` alone and says why: "MLX is Apple only.
  /// `supports(_:)` therefore returns false for them, which is the honest answer
  /// rather than a manifest promising files that cannot run." The build question
  /// is the `MLX` trait, and it is off.
  ///
  /// Deliberately NOT the same as `canDownloadWeights`. Splitting them is the
  /// whole point: one of the two halves of this package works.
  static var isSupported: Bool { TitleModel.supports(.current) && mlxTraitEnabled }

  /// Whether the model folder can be fetched and inspected here, which is a
  /// weaker and genuinely true claim.
  static var canDownloadWeights: Bool { TitleModel.supports(.current) }

  /// Why `isSupported` is false, or `""` when it is true.
  static var unsupportedReason: String {
    if !TitleModel.supports(.current) {
      return "desert-ant-core ships no Title artifact for this platform. Title is MLX, and MLX "
        + "is Apple silicon only; upstream's manifest records its Kotlin and JavaScript SDKs as "
        + "none."
    }
    if !mlxTraitEnabled {
      return "This build cannot generate: desert-ant-core's `MLX` package trait is off, so "
        + "`Sources/Title/Title.swift` compiled without its `#if MLX` half and `Titles` has no "
        + "public initializer. The trait can only be enabled from a consuming Package.swift "
        + "(`.package(url:..., traits: [\"MLX\"])`) or by `swift build --traits MLX`; React "
        + "Native's `spm_dependency` helper takes no traits argument, an Xcode package "
        + "reference has no field for one, and `xcodebuild` has no flag for one. Downloading "
        + "and inspecting the model folder still works."
    }
    return ""
  }

  /// The seven files upstream declares for Apple, read off the catalog.
  static var declaredFiles: [String] { TitleModel.files[.apple] ?? [] }

  private let directory: String?
  private let maxTokens: Int
  private let progressGate = ProgressGate()

  /// Where `resolve` put the model folder, once `prepare` has run. Nil before.
  private let stateLock = NSLock()
  private var rootPath: String?

  /// Cards waiting to be handed over, keyed by the job that produced them.
  ///
  /// Keyed rather than a single slot so two concurrent `describe` calls on one
  /// model cannot take each other's answer. Entries are removed on read.
  private let resultsLock = NSLock()
  private var cards: [String: TitleCard] = [:]

  /// Emitted while the model folder downloads. One phase; see
  /// `TitleProgressEvent`.
  @Event
  var onProgress: (TitleProgressEvent) -> Void

  init(directory: String?, maxTokens: Int) {
    // Construction does no work and starts no download.
    self.directory = directory
    self.maxTokens = maxTokens
    super.init()
  }

  // MARK: - Synchronous state

  /// Whether the model folder is on the device, complete and verified.
  /// Synchronous: it is a filesystem check, and a UI wants it during render.
  @JS
  func isDownloaded() -> Bool {
    TitleModel.isAvailable(directory: directory)
  }

  /// The model folder this instance would use, or `""` when there is not one yet.
  ///
  /// More interesting for this model than for the others in this family, and not
  /// only for bug reports: upstream's own API is `Titles(directory:)` over a
  /// folder "you populated", so this path is exactly what a native caller with
  /// the trait enabled would hand it.
  ///
  /// It answers before `prepare` where it honestly can — see `folderPath()`.
  @JS
  func resolvedDirectory() -> String {
    folderPath()
  }

  /// Which of the seven declared files are not on disk.
  ///
  /// Checked against `TitleModel.files[.apple]` rather than a list written here,
  /// so a rename upstream shows up as a missing file rather than as a silently
  /// shorter check. Before any folder is known this is all seven, which is the
  /// truthful answer rather than an empty array.
  @JS
  func missingFiles() -> [String] {
    let root = folderPath()
    guard !root.isEmpty else { return Self.declaredFiles }
    let fm = FileManager.default
    return Self.declaredFiles.filter { !fm.fileExists(atPath: (root as NSString).appendingPathComponent($0)) }
  }

  /// How many bytes of the seven files are on disk. `0` before `prepare`.
  ///
  /// A `Double` rather than an `Int64` because the JavaScript number is a double
  /// either way, and 280 MB is nowhere near the 2^53 where that stops being
  /// exact. Reported because it is the one real number this package can quote
  /// about the model today.
  @JS
  func installedBytes() -> Double {
    let root = folderPath()
    guard !root.isEmpty else { return 0 }
    let fm = FileManager.default
    var total: Int64 = 0
    for name in Self.declaredFiles {
      let path = (root as NSString).appendingPathComponent(name)
      if let size = (try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber {
        total += size.int64Value
      }
    }
    return Double(total)
  }

  // MARK: - Work (driven by TitleModule)

  /// Download and verify the model folder, and -- where the build can -- load the
  /// generator from it.
  ///
  /// ~280 MB in seven files: 6-bit quantized weights, a shard index, the config,
  /// the generation config, and the byte-level BPE tokenizer with its config and
  /// chat template. That is nearly as much as Clips and more than half of Voz, so
  /// this is a call an app puts behind a tap rather than on mount, and it is why
  /// the example app's Title section has a button on it.
  ///
  /// `resolve` adopts files a caller placed in `directory` and downloads
  /// otherwise, verifying as it goes; an interrupted download does not count as
  /// available. Both behaviours are the shared store's, not this SDK's.
  func prepare(jobId: String) async throws {
    let stored: StoredModel
    do {
      stored = try await TitleModel.resolve(directory: directory) { [weak self] progress in
        self?.report(jobId, phase: "loadingModel", fraction: progress.fraction)
      }
    } catch {
      throw Self.mapped(error, fallback: { ModelUnavailableException($0) })
    }
    storeResolved(rootPath: stored.rootPath)

    #if canImport(MLXLMCommon)
    // NEVER COMPILED. See the file header.
    //
    // This is where the ~280 MB becomes a `ModelContainer`: upstream's
    // `Titles.init(directory:maxTokens:)` calls
    // `#huggingFaceLoadModelContainer(configuration: ModelConfiguration(directory:))`,
    // a macro that expands into `HubClient` and `Tokenizers` references. It is
    // the expensive half of the lifecycle and belongs here rather than in
    // `describe`, which is what "build one and reuse it" means.
    do {
      let titles = try await Titles(
        directory: URL(fileURLWithPath: stored.rootPath, isDirectory: true),
        maxTokens: maxTokens)
      storeGenerator(titles)
    } catch {
      throw Self.mapped(error, fallback: { ModelLoadFailedException($0) })
    }
    #endif

    report(jobId, phase: "loadingModel", fraction: 1)
  }

  /// Write a title and a description for `text`, storing the card for `jobId`
  /// rather than returning it.
  ///
  /// Returning nothing is the fourth Expo Modules 2.0 limit this repo designs
  /// around; `takeCard` hands the record over synchronously. A card is two short
  /// strings and would very likely survive being returned directly -- and that is
  /// exactly the reasoning that would make this the package where the limit bit
  /// again. See `TitleRecords.swift`.
  func describe(text: String, jobId: String) async throws {
    let passage = try Self.validated(text)

    #if canImport(MLXLMCommon)
    // NEVER COMPILED. See the file header.
    guard let titles = generator() else {
      throw NotLoadedException("describe")
    }
    let started = ContinuousClock.now
    let card: UpstreamCard
    do {
      card = try await titles.describe(passage)
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }
    let processingSec = Self.elapsed(since: started)

    var record = TitleCard()
    record.title = card.title
    record.description = card.description
    // Upstream's own test, not a recomputation of it here.
    record.isEmpty = card.isEmpty
    record.processingSec = processingSec
    record.modelRevision = TitleModel.revision
    record.modelRuntime = "mlx"
    store(record, for: jobId)
    #else
    // Not a stub that returns an empty card. A method that silently produced
    // nothing would be worse than an absent one, because an app would ship it.
    _ = passage
    throw GenerationUnavailableException(Self.unsupportedReason)
    #endif
  }

  // MARK: - Handing results over

  /// The card computed for `jobId`, removed as it is read. Synchronous so the
  /// record is encoded on the JavaScript thread.
  @JS
  func takeCard(_ jobId: String) throws -> TitleCard {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let card = cards.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no card is waiting for job \(jobId)")
    }
    return card
  }

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an asynchronous one, and holding it across an `await` is
  /// what that rule exists to prevent.
  private func store(_ card: TitleCard, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    cards[jobId] = card
  }

  // MARK: - Lock-guarded state

  /// The folder to answer filesystem questions about.
  ///
  /// Three fallbacks, in this order, and the third one is a bug fix rather than a
  /// nicety. It was found by the example app's own self-test, which asserts that
  /// `isDownloaded()` and `missingFiles()` agree: on a freshly created model with
  /// no `directory`, `isDownloaded()` was **true** -- it asks
  /// `TitleModel.isAvailable`, which consults the managed cache -- while
  /// `missingFiles()` reported all seven absent and `installedBytes()` zero,
  /// because nothing had been resolved on *this instance* and there was no path
  /// to look in. Two public members of one object disagreeing about whether a
  /// 280 MB folder exists is exactly the kind of quiet wrongness this repo
  /// refuses.
  ///
  /// `ModelDistribution.installedModels` is the store's own answer to "which
  /// revisions of this repo are in the managed cache", one path per revision with
  /// the revision as its last component, so the third fallback reads the same
  /// bookkeeping `isAvailable` reads rather than reconstructing a cache layout
  /// here.
  private func folderPath() -> String {
    stateLock.lock()
    let resolved = rootPath
    stateLock.unlock()
    if let resolved { return resolved }
    if let directory { return directory }
    return TitleModel.distribution.installedModels()
      .first { ($0 as NSString).lastPathComponent == TitleModel.revision } ?? ""
  }

  private func storeResolved(rootPath newRoot: String) {
    stateLock.lock()
    defer { stateLock.unlock() }
    rootPath = newRoot
  }

  #if canImport(MLXLMCommon)
  // NEVER COMPILED. See the file header.
  private var titles: Titles?

  private func storeGenerator(_ value: Titles) {
    stateLock.lock()
    defer { stateLock.unlock() }
    titles = value
  }

  private func generator() -> Titles? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return titles
  }
  #endif

  // MARK: - Helpers

  /// Refuse a passage with nothing in it.
  ///
  /// Upstream does not. `describe` is
  /// `Self.prompt.replacingOccurrences(of: "{clip}", with: text)`, so an empty
  /// string produces a prompt that ends `PASSAGE:` and nothing else, and a 350M
  /// instruct model answers that with a confident invented title rather than an
  /// empty card. The refusal is cheap and the alternative is unattributable
  /// output.
  private static func validated(_ text: String) throws -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw EmptyPassageException(text.isEmpty ? "an empty string" : "only whitespace")
    }
    // Deliberately NOT truncated to a maximum. Upstream declares no context
    // limit anywhere this SDK can read -- the window is the base model's and
    // lives in `config.json` in the downloaded folder, not in any Swift constant
    // -- and a cap invented here would silently drop the end of a passage, which
    // is the class of behaviour this package refuses on principle.
    return text
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares.
  ///
  /// Thinner than Align's, because Title raises no typed error family of its
  /// own: without the trait, `TitleModel.resolve` is the only path that can fail
  /// here and it fails with `ModelStoreError` or a URLSession error, both of
  /// which are `ERR_MODEL_UNAVAILABLE`. If the trait is ever enabled, MLX's and
  /// swift-transformers' errors arrive here untyped and fall through to the
  /// caller's default rather than being guessed at.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if error is CancellationError {
      return InferenceFailedException("cancelled")
    }
    return fallback(String(describing: error))
  }

  private static func elapsed(since started: ContinuousClock.Instant) -> Double {
    let components = started.duration(to: .now).components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }

  // MARK: - Progress

  /// Called from whatever context the work is on, so it hops to the JavaScript
  /// actor before touching the event.
  private func report(_ jobId: String, phase: String, fraction: Double) {
    guard progressGate.shouldEmit(phase: phase, fraction: fraction) else {
      return
    }
    Task { @JavaScriptActor [weak self] in
      self?.onProgress(TitleProgressEvent(jobId: jobId, phase: phase, fraction: fraction))
    }
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per chunk. A phase change and the terminal `1.0` always pass.
///
/// It earns its keep here more than anywhere else in this family: a 280 MB
/// download is the largest number of `DownloadProgress` callbacks any model in
/// this repo generates.
private final class ProgressGate: @unchecked Sendable {
  private let lock = NSLock()
  private var lastPhase = ""
  private var lastEmit = Date.distantPast

  private static let interval: TimeInterval = 0.05

  func shouldEmit(phase: String, fraction: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let now = Date()
    if phase != lastPhase || fraction >= 1 || now.timeIntervalSince(lastEmit) >= Self.interval {
      lastPhase = phase
      lastEmit = now
      return true
    }
    return false
  }
}

extension TitleLoadOptions {
  /// Validated rather than clamped.
  ///
  /// `Titles.init` stores `maxTokens` and hands it to
  /// `GenerateParameters(maxTokens:)`, which stops the iterator at that count
  /// with no check at all -- so `0` ends the decode before the first token and
  /// produces an empty `Card`, which is indistinguishable from a model that
  /// declined to answer.
  func resolvedMaxTokens() throws -> Int {
    guard maxTokens > 0 else {
      throw InvalidMaxTokensException(maxTokens)
    }
    return maxTokens
  }

  /// A `directory` that is present must be a path.
  func resolvedDirectory() throws -> String? {
    guard let directory else { return nil }
    guard !directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw InvalidDirectoryException(directory.isEmpty ? "an empty string" : "only whitespace")
    }
    return directory
  }
}
