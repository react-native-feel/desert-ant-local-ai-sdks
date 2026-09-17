// The model handle. One instance owns the resolved weights directory and the
// parsed refiner config, so an app creates it once and reuses it.
//
// Everything asynchronous is `internal`, not `@JS` -- the `@SharedObject` macro
// can only bind synchronous members onto the JS prototype. `AlignModule` exposes
// these as module-level `@JS async` functions; see the note at the top of
// AlignModule.swift.
//
// What this object deliberately does NOT hold is a `SpeechTimestampRefiner`. One
// refiner is bound to one locale *and*, on the file path, to one audio file:
// `init(locale:audioFile:resourceDirectory:)` calls `useCompleteAudio`, which
// loads that file's samples into the refiner and clears the streaming ring
// buffer. So a refiner is a per-call object, built from already-downloaded files
// in `setupSec` milliseconds, and what is worth keeping across calls is the
// download rather than the instance.

@preconcurrency import AVFoundation
import Align
import CoreMedia
import DesertAnt
import ExpoModulesCore
import Foundation
import Speech

// `@unchecked Sendable` so the progress handler -- a `@Sendable` closure the
// Swift SDK invokes from its own tasks -- can capture `self`. What it touches is
// a `let` and lock-guarded state, so the guarantee is real; the compiler just
// cannot see it through `SharedObject`.
@SharedObject("AlignModel")
final class AlignModelObject: SharedObject, @unchecked Sendable {
  static let coreVersion = "3.1.0"

  /// The oldest OS this SDK can run Align on: iOS 26.
  ///
  /// **This is not the artifact's floor and the difference is the whole story.**
  /// `Sources/Align/Catalog.swift` declares no `osFloor`, so `AlignModel.osFloor`
  /// is `OSFloor.packageFloor` -- iOS 16 -- and `align_coarse.mlmodelc` really
  /// would load there. What needs iOS 26 is the only *public* way to hand the
  /// refiner a transcript.
  ///
  /// `SpeechTimestampRefiner` has two refine overloads that take words and audio
  /// directly, and both are `internal` to the `Align` module. The one public
  /// entry point is `refine(_ result: SpeechTranscriber.Result)`, declared in
  /// `SpeechTimestampRefiner+Pipeline.swift` under
  /// `@available(iOS 26, macOS 26, tvOS 26, visionOS 26, *)` because
  /// `SpeechAnalyzer` and `SpeechTranscriber` are themselves iOS 26. So this pod
  /// compiles at the desert-ant-core package floor of 17 -- an app installing
  /// Align alongside Uhm or Shapes is not dragged up nine major versions -- and
  /// refuses at runtime below 26, which is what `isSupported` reports.
  static let apiFloor = 26

  /// Whether this build and this device can run Align at all.
  ///
  /// Two questions, and unlike Ear, Gist, Redact and Shapes both of them can
  /// answer no. The catalog one (`files` lists `.apple`) is always yes here, so
  /// the OS one is the live case -- which makes Align the second model in this
  /// repo after Clips whose `isSupported` is about the *device* on Apple rather
  /// than only about the platform.
  static var isSupported: Bool {
    AlignModel.supports(.current) && osIsNewEnough
  }

  static var osIsNewEnough: Bool {
    ProcessInfo.processInfo.isOperatingSystemAtLeast(
      .init(majorVersion: apiFloor, minorVersion: 0, patchVersion: 0))
  }

  /// Why `isSupported` is false, or `""` when it is true.
  static var unsupportedReason: String {
    if !AlignModel.supports(.current) {
      return "desert-ant-core ships no Align artifact for this platform"
    }
    if !osIsNewEnough {
      return
        "Align needs iOS \(apiFloor) or newer. Its weights would load lower, but the only public "
        + "way to give the refiner a transcript is SpeechAnalyzer's result stream, which is "
        + "iOS \(apiFloor)."
    }
    return ""
  }

  /// The sidecar holding the language map and the frontend geometry. Named here
  /// as a literal and checked against `AlignModel.sidecars` at use, so a rename
  /// upstream is a legible error rather than an empty language list.
  private static let configName = "refiner_config.json"

  private let directory: String?
  private let progressGate = ProgressGate()

  /// Where `resolve` put the weights, once `load` has run. Nil before that.
  private let stateLock = NSLock()
  private var rootPath: String?
  private var languages: [String] = []
  private var reservedLocales: Set<String> = []

  /// Results waiting to be handed over, keyed by the job that produced them.
  ///
  /// Keyed rather than a single slot so two concurrent `transcribe` calls on one
  /// model cannot take each other's answer -- the same reason every entry point
  /// in this family carries a job id. Entries are removed on read, so nothing
  /// accumulates.
  private let resultsLock = NSLock()
  private var transcripts: [String: AlignTranscript] = [:]

  /// Emitted while the weights download, while Apple's speech assets install,
  /// and while the recognizer works through the file. See `AlignProgressEvent`.
  @Event
  var onProgress: (AlignProgressEvent) -> Void

  init(directory: String?) {
    // Construction does no work and starts no download.
    self.directory = directory
    super.init()
  }

  // MARK: - Synchronous state

  /// Whether Align's own weights are on the device. Synchronous: it is a
  /// filesystem check, and a UI wants it during render.
  ///
  /// It says nothing about Apple's speech assets, which are a separate download
  /// under `AssetInventory`. `isLocaleInstalled` answers that one.
  @JS
  func isDownloaded() -> Bool {
    AlignModel.isAvailable(directory: directory)
  }

  /// The language codes Align was trained to refine, read off the downloaded
  /// `refiner_config.json` rather than hardcoded.
  ///
  /// This is the same policy as `Gist.variants`, `Redact.labelDisplayNames` and
  /// `Uhm.fillerTypes`: a vocabulary that lives in the artifact is read from the
  /// artifact. Align makes it slightly harder than those three -- `RefinerConfig`
  /// is an `internal` struct and its `languages` map is not exposed on
  /// `SpeechTimestampRefiner` in any form -- but the file it is decoded from is
  /// a plain JSON sidecar this SDK has already downloaded, so the list is read
  /// from the same bytes the model reads it from.
  ///
  /// Empty before `load`.
  @JS
  func supportedLanguages() -> [String] {
    stateLock.lock()
    defer { stateLock.unlock() }
    return languages
  }

  /// The resolved weights directory, or `""` before `load`. Useful in a bug
  /// report and in the example app's self-test; not interesting otherwise.
  @JS
  func resolvedDirectory() -> String {
    stateLock.lock()
    defer { stateLock.unlock() }
    return rootPath ?? ""
  }

  // MARK: - Work (driven by AlignModule)

  /// Download Align's weights and read the language map out of them.
  ///
  /// There is no session to build here, and that is a real difference from every
  /// other model in this family rather than an omission. `SpeechTimestampRefiner`
  /// builds its two `StageModel`s in its own initializer, and that initializer is
  /// per-locale and per-audio-file, so it cannot be hoisted to load time. What
  /// `load` buys is the download: 0.7 MB of compiled Core ML and three sidecars,
  /// after which every `transcribe` is offline.
  func load(jobId: String) async throws {
    let stored: StoredModel
    do {
      stored = try await AlignModel.resolve(directory: directory) { [weak self] progress in
        self?.report(jobId, phase: "loadingModel", fraction: progress.fraction)
      }
    } catch {
      throw Self.mapped(error, fallback: { ModelUnavailableException($0) })
    }

    guard AlignModel.sidecars.contains(Self.configName) else {
      throw ModelLoadFailedException(
        "desert-ant-core no longer ships \(Self.configName); this SDK reads the language map "
          + "out of it")
    }
    let configPath = stored.path(Self.configName)
    let codes: [String]
    do {
      let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
      let object = try JSONSerialization.jsonObject(with: data)
      guard
        let root = object as? [String: Any],
        let map = root["languages"] as? [String: Any]
      else {
        throw ModelLoadFailedException("\(Self.configName) has no `languages` map")
      }
      codes = map.keys.sorted()
    } catch let exception as Exception {
      throw exception
    } catch {
      throw ModelLoadFailedException("could not read \(Self.configName): \(error)")
    }

    storeResolved(rootPath: stored.rootPath, languages: codes)

    report(jobId, phase: "loadingModel", fraction: 1)
  }

  /// Install Apple's on-device speech model for `identifier`, if it is not there.
  ///
  /// Align's second download, and the one this SDK does not own. Apple's
  /// recognizer weights are per-locale, live under `AssetInventory`, and are not
  /// part of desert-ant-core's catalog -- so an app that has Align's 0.7 MB can
  /// still have nothing to refine. Exposed as its own call rather than only
  /// folded into `transcribe` so a caller can pay it at a moment of its
  /// choosing, the way Voz's and Clips' downloads are.
  ///
  /// Idempotent: `assetInstallationRequest(supporting:)` returns nil when there
  /// is nothing to install.
  @available(iOS 26, *)
  func installSpeechAssets(identifier: String, jobId: String) async throws {
    let requested = try Self.resolvedLocale(identifier)

    // Apple's own spelling of the locale, not the caller's. `AssetInventory`
    // keys its reservations and its asset subscriptions on the identifier
    // `SpeechTranscriber` publishes, and `en-US` is not always that identifier --
    // `supportedLocale(equivalentTo:)` is the only function that maps one to the
    // other, so everything below uses what it returns.
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
      let supported = await SpeechTranscriber.supportedLocales.map(\.identifier)
      throw SpeechAssetsUnavailableException(
        "Apple's SpeechTranscriber does not support \(requested.identifier) on this device "
          + "(it supports \(supported.isEmpty ? "nothing at all here" : supported.joined(separator: ", ")))")
    }
    let transcriber = Self.transcriber(for: locale)

    // **Reserve first.** This is not an optimization and the order is not
    // arbitrary -- it was found by getting it wrong on a simulator. Calling
    // `assetInstallationRequest(supporting:)` before reserving fails with:
    //
    //     SFSpeechErrorDomain Code=1 "Cannot check the download status,
    //     com.example.app is not subscribed to transcription.en"
    //
    // which is Apple saying the app has not declared an interest in that
    // locale's asset, so it may not even ask whether it is installed. Reserving
    // is what declares it. Nothing upstream mentions this, because
    // desert-ant-core does not manage Apple's assets at all -- its own download
    // is the 0.7 MB of Align weights, and the recognizer behind them is assumed
    // to be somebody else's problem. On this SDK it is this function's problem.
    //
    // Reservations are capped (`AssetInventory.maximumReservedLocales`), so a
    // failure here is real and is reported rather than swallowed: without it
    // every later call fails with a message about a download status, which names
    // the symptom instead of the cause.
    if !hasReserved(locale.identifier) {
      do {
        _ = try await AssetInventory.reserve(locale: locale)
        markReserved(locale.identifier)
      } catch {
        throw SpeechAssetsUnavailableException(
          "could not reserve \(locale.identifier) (Apple allows "
            + "\(AssetInventory.maximumReservedLocales) reserved locales): \(error)")
      }
    }

    // Ask before installing, because the answer `unsupported` is a *different*
    // situation from a failed download and Apple reports it through an error
    // that names neither. Measured on an iPhone 17 Pro Max simulator running
    // iOS 26.4: `status(forModules:)` is `.unsupported`,
    // `SpeechTranscriber.installedLocales` is empty, and
    // `assetInstallationRequest(supporting:)` then throws
    //
    //     SFSpeechErrorDomain Code=1 "Cannot check the download status,
    //     <bundle id> is not subscribed to transcription.en"
    //
    // *after* a successful `reserve`. Reading that message, an app author would
    // reasonably go looking for a subscription or an entitlement they had
    // forgotten. There is none: Apple's recognizer assets are device-only, and
    // `supportedLocale(equivalentTo:)` still answers `en_US` on the simulator,
    // so the supported-locale check above cannot catch it either. The status is
    // the one call that says so.
    let status = await AssetInventory.status(forModules: [transcriber])
    if status == .installed {
      report(jobId, phase: "loadingModel", fraction: 1)
      return
    }
    if status == .unsupported {
      let installed = await SpeechTranscriber.installedLocales.map(\.identifier)
      throw SpeechAssetsUnavailableException(
        "this device reports Apple's speech assets for \(locale.identifier) as unsupported "
          + "(installed locales: \(installed.isEmpty ? "none" : installed.joined(separator: ", "))). "
          + "That is what an iOS Simulator reports: SpeechTranscriber names supported locales "
          + "there but AssetInventory cannot install any of them, so transcription -- and "
          + "therefore refinement -- needs a real device")
    }

    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        let progress = request.progress
        let ticker = Task { [weak self] in
          while !Task.isCancelled {
            self?.report(jobId, phase: "loadingModel", fraction: progress.fractionCompleted)
            try? await Task.sleep(nanoseconds: 200_000_000)
          }
        }
        defer { ticker.cancel() }
        try await request.downloadAndInstall()
      }
    } catch let exception as Exception {
      throw exception
    } catch {
      let installed = await SpeechTranscriber.installedLocales.map(\.identifier)
      let status = await AssetInventory.status(forModules: [transcriber])
      throw SpeechAssetsUnavailableException(
        "\(error) [locale=\(locale.identifier) status=\(status) installed="
          + "\(installed.isEmpty ? "none" : installed.joined(separator: ", "))]")
    }

    report(jobId, phase: "loadingModel", fraction: 1)
  }

  /// Transcribe `path` with Apple's recognizer and refine every finalized word
  /// boundary, storing the result for `jobId` rather than returning it.
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
  /// `Record.encode`, and Redact, Gist and Shapes designed around it from the start.
  /// An `AlignTranscript` is **an array of `@Record`s inside a `@Record`**, which
  /// is the largest result in this family after Clear's audio -- a minute of
  /// speech is a couple of hundred `AlignWord`s. So the async half returns `Void`
  /// and `takeTranscript` is synchronous, which puts the encode on the JavaScript
  /// thread by construction.
  ///
  /// That is necessary and not sufficient: the same closure destroys the call's
  /// *arguments* on the same thread, which is what `onJavaScriptThread` in
  /// AlignModule.swift is for. See docs/architecture.md, limit 4.
  ///
  /// The two halves of the work are timed separately because they belong to
  /// different vendors. `processingSec` covers Apple's recognition as well;
  /// `refineSec` and `setupSec` are Align's alone, and they are the numbers a
  /// decision about Align is made on.
  @available(iOS 26, *)
  func transcribe(path: String, options: AlignTranscribeOptions, jobId: String) async throws {
    let locale = try Self.resolvedLocale(options.locale)
    let buffered = try options.resolvedBufferSeconds()

    let (root, known) = resolvedState()
    guard let root else {
      throw NotLoadedException("transcribe")
    }

    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else {
      throw AudioDecodeFailedException("no file at \(path)")
    }

    // Answered from the language map before anything is built, so a typo costs
    // nothing. `SpeechTimestampRefiner` resolves its own language id the same
    // way -- the first two characters of the language code, lowercased -- so this
    // is the same test and not an approximation of it.
    let languageRefined = known.contains(Self.languageKey(locale))
    if !languageRefined && !options.allowUnrefined {
      throw UnrefinedLocaleException(
        "\(locale.identifier) (its language is not among \(known.joined(separator: ", ")))")
    }

    try await installSpeechAssets(identifier: locale.identifier, jobId: jobId)

    let started = ContinuousClock.now
    let audioFile: AVAudioFile
    do {
      audioFile = try AVAudioFile(forReading: url)
    } catch {
      throw AudioDecodeFailedException(String(describing: error))
    }
    let durationSec = audioFile.fileFormat.sampleRate > 0
      ? Double(audioFile.length) / audioFile.fileFormat.sampleRate
      : 0

    let setupStarted = ContinuousClock.now
    let refiner: SpeechTimestampRefiner
    do {
      refiner = try SpeechTimestampRefiner(
        locale: locale,
        audioFile: audioFile,
        resourceDirectory: URL(fileURLWithPath: root, isDirectory: true),
        maxBufferedSeconds: buffered)
    } catch {
      throw Self.mapped(error, fallback: { ModelLoadFailedException($0) })
    }
    let setupSec = Self.elapsed(since: setupStarted)

    // Apple's spelling of the locale again, for the same reason
    // `installSpeechAssets` uses it: the transcriber that runs must be the one
    // whose assets were reserved and installed, or the reservation was for
    // something else. The refiner above keeps the caller's locale because it
    // only ever reads a language code off it.
    let appleLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) ?? locale
    let transcriber = Self.transcriber(for: appleLocale)
    let analyzer = SpeechAnalyzer(modules: [transcriber])

    // Apple finalizes results as it goes, so refinement is interleaved with
    // recognition rather than run after it. The collector runs concurrently with
    // `analyzeSequence` because `transcriber.results` only yields while the
    // analyzer is consuming input -- awaiting one before the other deadlocks.
    let collector = Task { () -> (words: [AlignWord], text: String, refineSec: Double) in
      var words: [AlignWord] = []
      var text = ""
      var refineSec: Double = 0
      for try await result in transcriber.results {
        guard result.isFinal else { continue }
        let refineStarted = ContinuousClock.now
        let refined = refiner.refine(result)
        refineSec += Self.elapsed(since: refineStarted)
        let originals = Self.wordTimings(from: result.text)
        for (index, word) in refined.words.enumerated() {
          let original = index < originals.count ? originals[index] : word
          words.append(
            AlignWord(
              text: word.text,
              start: word.start,
              end: word.end,
              originalStart: original.start,
              originalEnd: original.end,
              refined: word.refined))
        }
        text += String(refined.text.characters)
        if durationSec > 0 {
          let reached = CMTimeGetSeconds(result.range.end)
          self.report(
            jobId, phase: "transcribing", fraction: min(1, max(0, reached / durationSec)))
        }
      }
      return (words, text, refineSec)
    }

    do {
      // Apple's own file pattern: run the file through, then finalize through the
      // last sample it produced. `analyzeSequence` returning nil means it read no
      // audio at all, and there is nothing to finalize through.
      if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
        try await analyzer.finalizeAndFinish(through: lastSample)
      } else {
        await analyzer.cancelAndFinishNow()
      }
    } catch {
      collector.cancel()
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }

    let collected: (words: [AlignWord], text: String, refineSec: Double)
    do {
      collected = try await collector.value
    } catch {
      throw Self.mapped(error, fallback: { InferenceFailedException($0) })
    }

    let processingSec = Self.elapsed(since: started)
    var transcript = AlignTranscript()
    transcript.text = collected.text.trimmingCharacters(in: .whitespacesAndNewlines)
    transcript.words = collected.words
    transcript.locale = locale.identifier
    transcript.languageRefined = languageRefined
    transcript.refinedWordCount = collected.words.reduce(0) { $0 + ($1.refined ? 1 : 0) }
    transcript.durationSec = durationSec
    transcript.processingSec = processingSec
    transcript.refineSec = collected.refineSec
    transcript.setupSec = setupSec
    transcript.realtimeFactor = processingSec > 0 ? durationSec / processingSec : 0
    transcript.modelRevision = AlignModel.revision
    transcript.modelRuntime = "coreml"

    report(jobId, phase: "transcribing", fraction: 1)
    store(transcript, for: jobId)
  }

  // MARK: - Handing results over

  /// The transcript computed for `jobId`, removed as it is read.
  ///
  /// Synchronous so the record is encoded on the JavaScript thread. See
  /// `transcribe` for why that is load-bearing rather than incidental.
  @JS
  func takeTranscript(_ jobId: String) throws -> AlignTranscript {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    guard let transcript = transcripts.removeValue(forKey: jobId) else {
      throw InferenceFailedException("no transcript is waiting for job \(jobId)")
    }
    return transcript
  }

  /// Non-async so the lock is taken in a synchronous context: `NSLock.lock()` is
  /// unavailable from an async one, and holding it across an `await` is what that
  /// rule exists to prevent.
  private func store(_ transcript: AlignTranscript, for jobId: String) {
    resultsLock.lock()
    defer { resultsLock.unlock() }
    transcripts[jobId] = transcript
  }

  // MARK: - Lock-guarded state
  //
  // Every one of these is non-async, and that is required rather than tidy:
  // `NSLock.lock()` is *unavailable* from an asynchronous context in Swift 6 --
  // "instance method 'lock' is unavailable from asynchronous contexts" is a hard
  // error, not a warning -- because holding a lock across a suspension point can
  // deadlock a cooperative thread pool. So an `async` method that needs this
  // state calls one of these, which take and release the lock within a single
  // synchronous frame.

  /// The resolved root and language list, read together so the two cannot be
  /// observed half-updated.
  private func resolvedState() -> (String?, [String]) {
    stateLock.lock()
    defer { stateLock.unlock() }
    return (rootPath, languages)
  }

  private func storeResolved(rootPath newRoot: String, languages newLanguages: [String]) {
    stateLock.lock()
    defer { stateLock.unlock() }
    rootPath = newRoot
    languages = newLanguages
  }

  private func hasReserved(_ identifier: String) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return reservedLocales.contains(identifier)
  }

  private func markReserved(_ identifier: String) {
    stateLock.lock()
    defer { stateLock.unlock() }
    reservedLocales.insert(identifier)
  }

  // MARK: - Helpers

  /// The transcriber this SDK always builds, with the one attribute option the
  /// whole product depends on.
  ///
  /// `.audioTimeRange` is not optional here and is worth stating rather than
  /// assuming. `SpeechTimestampRefiner` reads word spans out of the result's
  /// `AttributedString` runs; a transcriber configured without that attribute
  /// produces runs with no `audioTimeRange`, so the refiner sees **zero words**,
  /// returns the input unchanged, and the whole pipeline silently degrades to
  /// plain transcription. Owning the transcriber is what makes that
  /// unmisconfigurable from JavaScript.
  ///
  /// `.volatileResults` is deliberately absent: a volatile result passes through
  /// `refine` unrefined by design, so subscribing to them would cost recognition
  /// work for output this SDK discards.
  @available(iOS 26, *)
  private static func transcriber(for locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: [.audioTimeRange])
  }

  /// Apple's word spans, read out of the result the same way upstream reads them.
  ///
  /// A deliberate, minimal port rather than a call: upstream's `words(from:)` in
  /// `SpeechTimestampRefiner+Speech.swift` is `internal`, and the original
  /// timestamps are not carried on `RefinedSpeechResult` in any other form --
  /// `original` is Apple's `Result`, whose `text` still holds them. The loop is
  /// the same shape as upstream's so the two walk the runs in the same order and
  /// the arrays pair index for index; if that ever stops being true the pairing
  /// degrades to "original equals refined", not to a wrong number.
  @available(iOS 26, *)
  private static func wordTimings(from text: AttributedString) -> [WordTiming] {
    var out: [WordTiming] = []
    for run in text.runs {
      guard let range = run.audioTimeRange else { continue }
      let word = String(text[run.range].characters)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      guard !word.isEmpty else { continue }
      let start = CMTimeGetSeconds(range.start)
      out.append(
        WordTiming(text: word, start: start, end: start + CMTimeGetSeconds(range.duration)))
    }
    return out
  }

  /// Refuse a locale identifier that does not name a language.
  ///
  /// Upstream does not: `init(locale:)` reads
  /// `locale.language.languageCode?.identifier ?? ""`, and `Locale(identifier:)`
  /// accepts anything at all -- `""`, `"english"`, `"en_US_POSIX_nonsense"` --
  /// so a bad identifier yields an empty language code, no language id, and a
  /// refiner whose `refine` is a **passthrough that returns Apple's timestamps
  /// unchanged**. No error is raised on the call, and the result is a transcript
  /// that looks exactly like a refined one. That is the failure mode this repo
  /// refuses on principle: a typo that silently voids a result.
  private static func resolvedLocale(_ identifier: String) throws -> Locale {
    let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw InvalidLocaleException("(empty)")
    }
    let locale = Locale(identifier: trimmed)
    guard let code = locale.language.languageCode?.identifier, code.count >= 2 else {
      throw InvalidLocaleException(trimmed)
    }
    return locale
  }

  /// The key `SpeechTimestampRefiner` looks the language id up under: the first
  /// two characters of the language code, lowercased. Mirrored from
  /// `SpeechTimestampRefiner.init` so the refusal and the refiner agree.
  private static func languageKey(_ locale: Locale) -> String {
    String((locale.language.languageCode?.identifier ?? "").prefix(2)).lowercased()
  }

  private static func elapsed(since started: ContinuousClock.Instant) -> Double {
    let components = started.duration(to: .now).components
    return Double(components.seconds) + Double(components.attoseconds) / 1e18
  }

  /// Translate an upstream error into one of the codes
  /// `@desert-ant-labs/react-native-core` declares, so JavaScript branches on
  /// `error.code` rather than on the text of a Swift error.
  ///
  /// Three typed families reach here: `AlignResourceError` for a sidecar that is
  /// not on disk, `SpeechTimestampRefiner.AudioFileError` for audio AVFoundation
  /// opened but could not convert, and everything else -- a URLSession failure
  /// inside the download, a Core ML load failure, a `SpeechAnalyzer` error --
  /// which falls through to the caller's own default. Hence `fallback` as a
  /// parameter rather than a fixed code.
  private static func mapped(_ error: Error, fallback: (String) -> Exception) -> Exception {
    if let exception = error as? Exception {
      return exception
    }
    if let resourceError = error as? AlignResourceError {
      switch resourceError {
      case let .missingResource(name):
        return ModelUnavailableException("\(name) is not in the resolved model directory")
      }
    }
    if let audioError = error as? SpeechTimestampRefiner.AudioFileError {
      switch audioError {
      case .cannotAllocateBuffer:
        return AudioDecodeFailedException("could not allocate a buffer for the whole file")
      case .unsupportedFormat:
        return AudioDecodeFailedException(
          "the file decodes to a sample format the refiner cannot read")
      }
    }
    if error is CancellationError {
      return InferenceFailedException("cancelled")
    }
    return fallback(String(describing: error))
  }

  // MARK: - Progress

  /// Called from whatever context the work is on, so it hops to the JavaScript
  /// actor before touching the event.
  private func report(_ jobId: String, phase: String, fraction: Double) {
    guard progressGate.shouldEmit(phase: phase, fraction: fraction) else {
      return
    }
    Task { @JavaScriptActor [weak self] in
      self?.onProgress(AlignProgressEvent(jobId: jobId, phase: phase, fraction: fraction))
    }
  }
}

/// Rate-limits progress so a fine-grained callback does not become a hop onto the
/// JavaScript thread per chunk. A phase change and the terminal `1.0` always pass.
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

extension AlignTranscribeOptions {
  /// Validated rather than clamped.
  ///
  /// `SpeechTimestampRefiner` stores `maxBufferedSeconds` and multiplies it by
  /// the sample rate into a ring-buffer cap with no check at all, so `0` caps the
  /// buffer at zero samples and `NaN` makes `Int(NaN * 16000)` a trap. Neither is
  /// a reading of "how much context should I keep".
  func resolvedBufferSeconds() throws -> Double {
    guard maxBufferedSeconds.isFinite, maxBufferedSeconds > 0 else {
      throw InvalidBufferSecondsException(maxBufferedSeconds)
    }
    return maxBufferedSeconds
  }
}
