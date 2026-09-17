// The value types that cross the JS boundary, declared with the Expo Modules 2.0
// `@Record` macro: every non-private stored property is a field, and its Swift
// type drives the conversion, so there is no `@Field` wrapper and no separate
// dictionary-parsing code to keep in sync.
//
// Records nest here the way Clips' do -- a `GistTagging` holds `[GistTopic]` --
// which works because `Array: JavaScriptEncodable where Element:
// JavaScriptEncodable` and every `Record` is `JavaScriptEncodable`. What is
// different from Clips is *where* they are encoded: everything in this file is
// handed to JavaScript from a synchronous member, never returned from a `@JS
// async` function. See GistModel.swift.

import DesertAnt
import Gist
import ExpoModulesCore

/// How a `GistModel` finds its weights, and which build to load.
@Record
struct GistLoadOptions {
  /// The model's home directory. Files already there are adopted, so an app that
  /// ships the weights itself points at the folder holding them. Nil uses the
  /// managed platform cache.
  var directory: String?

  /// `"multilingual"` (the ~74 MB, 101-language default) or `"english"` (~15 MB,
  /// Latin script only). Each variant caches its own slice of the repo, so
  /// choosing one never downloads the other.
  var variant: String = GistVariant.default.rawValue

  /// Resolve into upstream's own enum, so a typo is an argument error here rather
  /// than a silent fall back to the 74 MB build.
  func resolvedVariant() throws -> GistVariant {
    guard let resolved = GistVariant(rawValue: variant) else {
      throw InvalidVariantException(variant)
    }
    return resolved
  }
}

/// One `classify` call's settings.
@Record
struct GistClassifyOptions {
  /// How many topics to return at most. Upstream's own default is 3.
  var topK: Int = 3

  /// The threshold override, or a negative number meaning "use the model's own
  /// tuned value".
  ///
  /// A sentinel rather than an `Double?` because the TypeScript side has to send
  /// *something* and a probability is never negative, so `-1` cannot collide with
  /// a threshold a caller meant. Upstream's `classify` takes `Double?` and this
  /// maps straight back onto it.
  var threshold: Double = -1

  func resolvedTopK() throws -> Int {
    guard topK >= 1 else { throw InvalidTopKException(topK) }
    return topK
  }

  func resolvedThreshold() throws -> Double? {
    guard threshold >= 0 else { return nil }
    guard threshold <= 1 else { throw InvalidThresholdException(threshold) }
    return threshold
  }
}

/// One predicted topic and its probability.
///
/// A `@Record` rather than a tuple or a dictionary because it is returned inside
/// an array, and an array of records encodes as a real array of real objects with
/// no per-entry boxing.
@Record
struct GistTopic {
  /// The taxonomy slug, e.g. `"technology"`.
  var slug: String = ""
  /// The display name from the model's own `taxonomy.json`, e.g.
  /// `"Technology & Software"`. Carried rather than derived, so a new model
  /// revision's names arrive with its weights.
  var name: String = ""
  var score: Double = 0
}

/// What a `classify` decided.
@Record
struct GistTagging {
  /// Ranked, most likely first, capped at `topK`. The top topic is present even
  /// when it is below the model's threshold -- upstream's rule, on both
  /// platforms. So more than one topic here means every one of them cleared it
  /// (they are sorted descending, and only the first is exempt); exactly one
  /// means it may be the nearest topic rather than a confident one.
  var topics: [GistTopic] = []
  /// The threshold the caller overrode, echoed back so a result is
  /// self-describing -- and **nil when they did not**, because neither SDK
  /// exposes the model's own tuned value. `Model.threshold` is `internal` in
  /// Swift and `Gist.tagged` is `private` in Kotlin; reading it would mean either
  /// duplicating a number out of `gist_config.json`, which the next model
  /// revision would silently invalidate, or reporting a bound and calling it a
  /// threshold. See the note on `topics` for what is derivable instead.
  var threshold: Double?
  /// Wall clock around the whole call.
  var processingSec: Double = 0
  /// The pinned model revision this came from, so a benchmark or a telemetry
  /// event is self-identifying.
  var modelRevision: String?
  /// Which build answered.
  var variant: String = ""
}

/// One slug and its probability, for the full distribution.
///
/// Separate from `GistTopic` because upstream's `scores(of:)` returns a bare
/// `[String: Double]` with no display names attached -- inventing a `name` here
/// would mean deriving one from a slug, which is the thing `taxonomy.json` exists
/// to prevent.
@Record
struct GistScore {
  var slug: String = ""
  var score: Double = 0
}

/// The full 36-topic distribution for one text.
@Record
struct GistDistribution {
  /// Ordered by slug, so the wire is deterministic across platforms -- the same
  /// order upstream's own cross-language binding writes.
  var scores: [GistScore] = []
  var processingSec: Double = 0
  var modelRevision: String?
  var variant: String = ""
}

/// One post's distribution, for `channelTopics`.
@Record
struct GistPostTopics {
  var topics: [GistScore] = []
  /// Epoch milliseconds, or `0` for "no timestamp" -- which is upstream's `nil`,
  /// and means the post is never decayed.
  var timestampMillis: Double = 0
}

/// `RollupOptions` on the wire. Defaults mirror upstream's initializer so a
/// caller who passes nothing gets exactly what Swift would give them.
@Record
struct GistRollupOptions {
  var topN: Int = 5
  var floor: Double = 0.05
  var minPosts: Int = 3
  var halfLifeDays: Double = 0
  var touch: Double = 0.15
  var nowMillis: Double = 0

  /// Into upstream's own struct, so the aggregation is decided there and the
  /// defaults cannot drift apart from it.
  func resolved() -> RollupOptions {
    RollupOptions(
      topN: topN, floor: floor, minPosts: minPosts,
      halfLifeDays: halfLifeDays, touch: touch, nowMillis: nowMillis)
  }
}

/// One channel-level topic in a roll-up.
@Record
struct GistChannelTopic {
  var slug: String = ""
  var share: Double = 0
  var postCount: Int = 0
}

/// A progress tick. `jobId` is the id the caller passed to the call that is
/// running, so one listener can serve concurrent calls.
///
/// `phase` is only ever `loadingModel`: upstream's `classify` and `scores` take
/// no progress handler on either platform, so there is no tagging fraction to
/// report and none is invented.
@Record
struct GistProgressEvent {
  var jobId: String = ""
  var phase: String = ""
  var fraction: Double = 0
}

// MARK: - Mapping

/// Built by mutation rather than an initializer: `@Record` synthesizes the
/// memberwise `init` itself, and a hand-written one in the same type would race
/// the macro for the same signature. Every field has a default, so the
/// no-argument form is always available.
func gistTagging(
  from topics: [Topic],
  threshold: Double?,
  variant: GistVariant,
  processingSec: Double
) -> GistTagging {
  var record = GistTagging()
  record.topics = topics.map { topic in
    var entry = GistTopic()
    entry.slug = topic.slug
    entry.name = topic.name
    entry.score = topic.score
    return entry
  }
  record.threshold = threshold
  record.processingSec = processingSec
  record.modelRevision = GistModel.revision
  record.variant = variant.rawValue
  return record
}

func gistDistribution(
  from scores: [String: Double],
  variant: GistVariant,
  processingSec: Double
) -> GistDistribution {
  var record = GistDistribution()
  // Sorted by slug: deterministic across platforms, which is what makes two
  // devices' logs comparable.
  record.scores = scores.sorted { $0.key < $1.key }.map { pair in
    var entry = GistScore()
    entry.slug = pair.key
    entry.score = pair.value
    return entry
  }
  record.processingSec = processingSec
  record.modelRevision = GistModel.revision
  record.variant = variant.rawValue
  return record
}

func gistChannelTopics(from topics: [ChannelTopic]) -> [GistChannelTopic] {
  topics.map { topic in
    var record = GistChannelTopic()
    record.slug = topic.slug
    record.share = topic.share
    record.postCount = topic.postCount
    return record
  }
}
