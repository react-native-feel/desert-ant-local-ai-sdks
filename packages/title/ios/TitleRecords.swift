// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion.
//
// What matters is *where* these are encoded. `TitleCard` is handed to JavaScript
// from a synchronous member -- `TitleModelObject.takeCard` -- and never returned
// from a `@JS async` function, because an async return value can be encoded off
// the JavaScript thread and segfault the runtime. See `TitleModelObject.swift`.
//
// A card is two short strings, which is the smallest result in this family by a
// wide margin and nowhere near the shapes that took Ear, Emo and Clear down. It
// goes through `takeCard` anyway. The limit has now been reproduced on a bare
// `[String]`, on `Record.encode`, and on `JavaScriptValuesBuffer.deinit`, in five
// separate packages; treating it as a property of the toolchain rather than of a
// result's size is what the other three packages written this session concluded,
// and a package that made itself the exception would be betting on a crash being
// about size when the evidence says it is about thread.

import ExpoModulesCore
import Foundation

/// How a `TitleModel` finds its model folder, and how long it may decode for.
///
/// Both fields are `Titles.init` parameters rather than per-call ones, which is
/// upstream's shape and not a simplification: `init(directory:maxTokens:)` builds
/// the `ModelContainer` and stores the cap, and `describe` takes only text.
@Record
struct TitleLoadOptions {
  /// The model folder. Files already there are adopted; otherwise the seven
  /// files upstream declares are downloaded into it. Nil uses the managed cache.
  ///
  /// Worth knowing that upstream's own SDK does neither: `Titles.init(directory:)`
  /// takes a folder "you populated" and never downloads. The download here is
  /// `TitleModel.resolve`, which Title inherits from `ModelDeclaration` like every
  /// other model in the catalog and which works whether or not the `MLX` trait is
  /// on. It is the half of this package that runs today.
  var directory: String?

  /// The decode cap, in tokens. Upstream's default argument is 96.
  ///
  /// Mirrored rather than read, like Align's `maxBufferedSeconds: 30` and
  /// Redact's 0.6: it is a default argument on `Titles.init`, and a default
  /// argument is not a constant any SDK exposes. Forwarded so one number appears
  /// in one place, and validated because upstream does not validate it.
  var maxTokens: Int = 96
}

/// A title and a description for a passage of text.
///
/// The three data fields are upstream's `Card` verbatim -- `title`,
/// `description`, and its own `isEmpty`, read off the value rather than
/// recomputed here so the two cannot disagree about what "no card" means.
/// The rest is this call's provenance.
@Record
struct TitleCard {
  /// Three to eight words, no final punctuation, in the language of the passage.
  /// That is the shape upstream's prompt asks for; `cardShape` in TypeScript is
  /// how a caller checks whether it got it.
  var title: String = ""
  /// One or two sentences saying what this passage is, as opposed to what its
  /// subject is.
  var description: String = ""
  /// Upstream's own emptiness test: neither field came back.
  ///
  /// The only failure signal a caller gets, because `Titles.parse` is tolerant by
  /// design -- a reply that drifts off the `TITLE:` / `DESC:` format degrades to
  /// a usable title rather than throwing. Treat it as "no card", not as an error.
  var isEmpty: Bool = true
  /// Wall clock around the generation, excluding the load.
  var processingSec: Double = 0
  /// The model revision the folder was resolved at, so a log line is
  /// self-identifying. `v0.1.0` -- a tag, unlike Align's branch.
  var modelRevision: String?
  /// The runtime that produced it. `mlx` -- there is no other, and that is the
  /// whole reason this package has the shape it has.
  var modelRuntime: String?
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
///
/// **One phase, and it is not invented.** `loadingModel` carries a true byte
/// fraction from `ModelDeclaration.resolve`'s `DownloadProgress`, which is
/// `completedBytes / totalBytes` over the seven declared files.
///
/// There is deliberately no `generating` phase. Upstream's decode loop is
/// `for await generation in stream` over `MLXLMCommon.generate`, which yields
/// text chunks and no denominator -- there is no total to be a fraction of, and
/// a phase that could only ever report `0` and `1` would be a progress bar
/// pretending to be one. `ModelPhase` in `@desert-ant-labs/react-native-core`
/// gains nothing for this model.
@Record
struct TitleProgressEvent {
  var jobId: String = ""
  var phase: String = ""
  var fraction: Double = 0
}
