# @desert-ant-labs/react-native-gist

On-device content topic tagging for React Native and Expo: what a post or an
article is *about*, from a fixed 36-topic taxonomy, in 101 languages with no
language setting to pass in. Nothing leaves the device.

Wraps Desert Ant Labs' own [Gist](https://desertant.com/models/gist/) Swift and
Kotlin SDKs as an Expo module.

**iOS and Android.** Gist is the fourth model in this repo with two working
halves, after Clear, Emo and Ear: upstream publishes a Core ML export *and* a
LiteRT one, and `ai.desertant:gist` is on Maven Central.

## Install

```bash
npx expo install @desert-ant-labs/react-native-gist
```

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-gist"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios   # or run:android
```

The plugin raises the iOS deployment target to 17.0 — tied with Emo, Uhm, Ear and
Tongue for the lowest floor of any model here — and narrows the Android ABIs to
`arm64-v8a` and `x86_64`, which are the two LiteRT ships. Both only ever raise or
narrow, so they compose with the other Desert Ant plugins; pass
`restrictAbis: false` to keep your own ABI list.

## Use

```ts
import { Gist } from '@desert-ant-labs/react-native-gist';

if (!Gist.isSupported) return;             // an ABI LiteRT does not ship

const gist = await Gist.load();            // ~74 MB, so not on mount
const { topics } = await gist.classify('How to start a podcast with your iPhone');
// [{ slug: 'technology', name: 'Technology & Software', score: 0.93 },
//  { slug: 'business',   name: 'Business & Entrepreneurship', score: 0.80 },
//  { slug: 'creator-economy', name: 'Creator Economy & Marketing', score: 0.77 }]

gist.release();
```

Multi-label, not single-label. The scores are independent probabilities rather
than a distribution that sums to one, so two or three topics is the ordinary
answer and a `0.93` next to a `0.80` is not a near-tie.

### The list length is the confidence signal, not the threshold

**The top topic always comes back**, even when nothing clears the model's tuned
threshold. That is upstream's rule on both platforms, not this package's: the 36
topics are a fixed list, so a subject outside it lands on the nearest topic on it
rather than on nothing.

Topics are sorted descending and only the first is exempt from the threshold, so:

```ts
const { topics } = await gist.classify(title);
topics.length > 1        // every one of them cleared the threshold
topics.length === 1      // may be the *nearest* topic rather than a confident one
```

`Tagging.threshold` echoes an explicit `threshold` back and is **null otherwise**,
because neither SDK exposes the tuned value — `Model.threshold` is `internal` in
Swift, `Gist.tagged` is `private` in Kotlin. Copying the number out of the model's
`gist_config.json` would be right until the next revision retunes it and then
quietly wrong. Pass your own threshold when you need the bar to be yours:

```ts
await gist.classify(title, { threshold: 0.8 });   // echoed back on the result
```

### Rolling many posts up into what a channel is about

```ts
import { channelTopics } from '@desert-ant-labs/react-native-gist';

const posts = await Promise.all(recent.map((p) => gist.scores(p.title)));
const about = channelTopics(posts.map((p) => ({ topics: p.scores })));
// [{ slug: 'technology', share: 0.14, postCount: 10 }, ...]
```

`scores()` rather than `classify()` because the roll-up wants every topic's mass:
a topic that comes third in every post is what a channel is about even though it
tops none of them.

`channelTopics` is **pure, synchronous, and needs no model** — it would answer on
a device that had never downloaded a weight. It is bound from upstream rather
than ported: Swift and Kotlin already agree on this arithmetic field for field,
and a third implementation in TypeScript would be a third chance to differ on a
calculation whose output nothing would flag as wrong.

Two guards keep one-off posts from characterizing a channel: a share `floor`
(0.05) below which a topic is dropped, and `minPosts` (3), below which the answer
is empty rather than confidently wrong about two posts. Recency decay is off
until you supply both `halfLifeDays` and `nowMillis`; a half-life with no clock to
measure against decays nothing.

### Two builds, and only one of them on Android

```ts
Gist.variants;         // iOS: ['multilingual', 'english'] — Android: ['multilingual']
await Gist.load({ variant: 'english' });   // ~15 MB, Latin script only
```

The multilingual default is ~74 MB and covers 101 languages. The English build is
the same 36 topics and the same head at ~15 MB, and upstream is explicit that
other scripts are *not* covered — non-Latin input degrades to noise rather than
to a low score, so pick it deliberately.

Gate a variant picker on `Gist.variants`, which is read off the native binary,
rather than on `Platform.OS`: `ai.desertant:gist`'s whole constructor is
`Gist(context, directory)` and its own documentation says the English build is
selectable from the Swift SDK only. Asking for it on Android raises
`ERR_UNSUPPORTED_PLATFORM` rather than silently pulling 74 MB instead of 15.

## API

| | |
| --- | --- |
| `Gist.isSupported` | True on iOS and on Android with a LiteRT ABI. |
| `Gist.unsupportedReason` | Why, in a sentence, or null. On Android it names the device's ABIs. |
| `Gist.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Gist.modelRevision` | The pinned model revision, or null. Both variants live at it. |
| `Gist.modelRepo` | The Hub repo the weights come from, or null. |
| `Gist.defaultTopK` | How many topics `classify` returns untold. `3`. |
| `Gist.variants` | What this platform can load. iOS two, Android one. |
| `Gist.defaultVariant` | `'multilingual'`. |
| `Gist.defaultRollupOptions` | `channelTopics`' six defaults, read off the binary. |
| `Gist.load(options?)` | Create, download and prepare. |
| `Gist.create(options?)` | Create without touching the network. |
| `gist.variant` | Which build this instance loads. |
| `gist.isDownloaded()` | Whether tagging can run offline. Synchronous. |
| `gist.warm(onProgress?)` | Download and build the session. |
| `gist.download(onProgress?)` | The same call — see below. |
| `gist.classify(text, options?)` | Text in, a `Tagging` out. |
| `gist.scores(text, options?)` | Text in, all 36 probabilities out. |
| `gist.release()` | Hand the model back. |
| `channelTopics(posts, options?)` | Many distributions in, ranked channel topics out. No model. |

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_INVALID_ARGUMENT`, `ERR_RELEASED`,
`ERR_UNSUPPORTED_PLATFORM`. There is no `ERR_AUDIO_*` here — the input is a
string, so nothing can fail to decode.

## Things the types cannot tell you

- **The download is the expensive part, not the inference.** ~74 MB of weights,
  then a forward pass measured in single-digit milliseconds — Gist is a static
  multilingual embedding table plus hashed n-grams plus one MLP head, with no
  transformer in it. Every other model here is the other way round. That is why
  this is the one text model in the family that does *not* load on mount.
- **Tagging reports no progress.** Upstream's `classify` and `scores` take no
  handler on either platform, so the only phase a Gist emits is `loadingModel`,
  and no phase was added to `ModelPhase` in `packages/core`. `onProgress` on a
  `classify` still fires — for the load the first call does implicitly.
- **`warm` and `download` are the same call.** Upstream exposes one entry point
  that downloads *and* builds the session, so unlike Clear and Voz there is no
  download-only step. Both names exist so the eight models read alike.
- **Blank input is an answer, and it never reaches the weights.** This is the one
  place the two upstream SDKs disagree and this package picks a side.
  `ai.desertant:gist` returns an empty list for blank text before touching the
  model; `Sources/Gist` has no such guard, so a blank string runs the head over an
  all-zero feature vector and — because `classify` always returns its top topic —
  comes back naming a topic with nothing behind it. Kotlin's behaviour is the
  honest one, so both platforms got it here. A text field wired straight to
  `classify` therefore costs nothing while it is empty, on a device that has never
  downloaded anything.
- **`classify` and `scores` are two model runs.** Asking for both on one text runs
  the model twice. That is upstream's shape on both platforms, and this package
  does not paper over it by deriving one from the other — `classify`'s ranking
  rule lives natively, where one implementation decides it.
- **Display names come from the model.** `Topic.name` is read out of the weights'
  own `taxonomy.json`, not from a table in this package, so a renamed topic
  arrives with its revision rather than after a release here. `Topic.slug` is what
  to store.
- **It tags what a text is about, not whether it is good or safe**, per upstream.
  And the 36 topics are a fixed list — see the note on list length above.
- **`defaultTopK` is mirrored, not read.** It is `topK: Int = 3` in a Swift
  signature and a Kotlin one — a default argument, not a constant either SDK
  exposes. `variants`, `defaultVariant` and `defaultRollupOptions` *are* read off
  the binary.
- **Android reports progress as phase boundaries, not fractions.**
  `ai.desertant:gist`'s `download()` takes no callback, so it emits 0 on entering
  `loadingModel` and 1 on leaving. It matters more here than for Ear or Emo: the
  download is ~74 MB, not ~9.
- **`modelRevision` and `modelRepo` are constants on Android.**
  `ai.desertant:gist` publishes `Gist`, `Topic`, `GistException`, `PostTopics`,
  `ChannelTopic`, `RollupOptions` and `channelTopics`, and nothing to read the
  catalog from. The Apple half reads `GistModel`.
- **Every async native call returns `Void`.** The results come back through
  synchronous members on the shared object. That is not a style choice — see
  below.

## Every async call returns nothing, on purpose

This package's native surface has an unusual shape: `classify` and `scores` are
`@JS async` functions that return `Void` and store their result on the shared
object under the caller's job id, and the result is read back through a
**synchronous** `takeTagging` / `takeDistribution`.

It is the fourth Expo Modules 2.0 limit this repo has had to design around. **A
`@JS async` function's return value can be encoded off the JavaScript thread**,
which segfaults the runtime — the crash lands on
`com.apple.root.user-initiated-qos.cooperative` rather than on
`com.facebook.react.runtime.JavaScript`, and `@JavaScriptActor` does not prevent
it, because the return value is encoded *after* the actor hop the annotation
governs. Ear hit it returning `[String]`; the same investigation found Clear
hitting it through `Record.encode`, so "arrays of primitives only" is the wrong
reading. It is a race, so it survives a first call and a second and then takes
the process down, and the damage it does to the Hermes heap surfaces later and
somewhere else entirely.

`docs/architecture.md` draws the general rule out of those two: split "do the
work" from "hand the result over" whenever the result is large or its encoding is
not a single scalar. Gist returns the largest results in this family — `scores` is
the whole 36-topic taxonomy — so the rule applies here without any judgement about
how many records is too many, and both calls are split rather than one of them.
A synchronous `@JS` member runs on the JavaScript thread by construction.

The job id is what makes it safe rather than merely lucky: results are keyed by
it and removed on read, so two concurrent `classify` calls on one model cannot
take each other's answer.

`channelTopics` is synchronous for the same reason on top of the obvious one. It
is arithmetic over a few hundred numbers, and a synchronous return cannot hit the
hazard at all.

## Verified

Driven on an iOS 26 simulator (iPhone 17 Pro Max) with a dev build, alongside
Clear, Voz, Clips, Uhm, Ear, Emo and Tongue — the eighth pod in an app that
already carried seven.

The module binds and reports, before anything touches a model:

```
[gist] isSupported=true nativeCore=3.1.0 revision=v2.2.0 repo=desert-ant-labs/gist
       topK=3 variants=multilingual/english default=multilingual
       rollup={"topN":5,"floor":0.05,"minPosts":3,"halfLifeDays":0,"touch":0.15,"nowMillis":0}
```

which exercises the `@ExpoModule` registration, every `@JS` property — including
`variants` as a `[String]` getter and `defaultRollupOptions` as a
`[String: Double]` one — `createModel` returning a `@SharedObject`, its
synchronous `isDownloaded()`, and `release()`.

**Loading.** The ~74 MB download plus the Core ML session build took **65.3 s**
cold, on a model prepared by itself. A first attempt failed on a Hugging Face
**HTTP 429**, which is worth recording because the failure path is the one a real
app hits: it surfaced as `ERR_MODEL_UNAVAILABLE` naming the URL and the status,
not as an inference failure. Two later launches loaded the cached weights in
**42.9 s** and **45.1 s** — but both were measured while Emo (36.0 s), Ear
(40.6 s) and Uhm (55.8 s) were loading on the same mount, and those three take
3.0 s, 7.0 s and rather less uncontended, so read the warm figure as an upper
bound under contention rather than as the session build's cost.

**Tagging is correct, and multilingual.** One headline in four languages, with no
language ever passed in:

| | Top topics |
| --- | --- |
| `en` "How to start a podcast with just your iPhone" | **technology 0.931**, business 0.799, creator-economy 0.772 |
| `es` "Cómo empezar un podcast solo con tu iPhone" | **technology 0.861**, business 0.746, creator-economy 0.636 |
| `de` "Wie du nur mit deinem iPhone einen Podcast startest" | **business 0.591**, technology 0.588 |
| `ja` "iPhoneだけでポッドキャストを始める方法" | **technology 0.621**, creator-economy 0.521 |

Three of the four name `technology` first and the fourth puts `business` ahead of
it by **0.003** — which is the multi-label point rather than a miss: all four rank
the same two or three topics, and the German phrasing leans on *how you do it*
rather than on the device. Nothing here is a keyword table; the Japanese sentence
shares no characters with the English one.

Two headlines on other subjects, through the app's own field:

```
"Why our index fund beat the hedge fund over ten years"  -> Personal Finance & Investing 0.800   (1 topic, 11 ms)
"The best one-pan salmon recipe for a weeknight"         -> Food & Cooking 0.915                 (1 topic, 50 ms)
```

**Latency.** The first `classify` after a load costs **45.3 ms** natively; after
that it is **9–11 ms end to end from JavaScript**, bridge hop included. `scores`
is **3.6–4.1 ms** natively. Twelve transcript lines through `scores` plus one
`channelTopics` ran in **74–88 ms** total, over six runs (74, 79, 83, 83, 84,
88) — so a whole feed's worth of tagging costs less than a frame budget's worth
of animation.

**The roll-up, on the transcript this app ranks with Clips.** Twelve lines of a
retro about a recommendation engine that failed at scale:

```
technology 13.9% x10   business 12.7% x8   self-improvement 6.8% x5   news-politics 5.2% x2
```

Ten of the twelve lines touch `technology` and eight touch `business`, which is
what that transcript is. The shares sum to 0.385 rather than 1 because the floor
and `topN` drop the tail. Two posts return **0** channel topics, which is
`minPosts` declining to describe a channel from too little rather than being
confident about it.

Also exercised, all green in the example app's self-test on two consecutive runs:
ranked/bounded/unique/named/capped invariants on every tagging; `topic` agreeing
with `topics[0]`; `topK: 1` returning one and `topK: 10` returning three, with the
same winner; `threshold: 1` returning exactly the one topic upstream always
returns, and echoing `1` back; blank input returning zero topics with no download;
`scores` returning **36** topics, all in `0..1` and a superset of what `classify`
named; `topK` of 0, -1 and 1.5 and `threshold` of -0.1 and 1.1 all rejected with
`ERR_INVALID_ARGUMENT` before reaching native; and `Gist.variants` reporting both
builds on iOS. The run ends `[selftest] all prepared models passed`, so adding
this package breaks none of the seven.

**What was not verified.**

- **Android was not built or run.** No Android SDK is installed on this machine —
  `$ANDROID_HOME` points at a directory with no `platforms` or `build-tools` — so
  unlike the other packages here, this one's Android half has not even been
  compiled. It is written against `ai.desertant:gist`'s published API as read from
  the desert-ant-core checkout, and should be treated as unproven until it builds.
- **The `english` variant was never loaded.** `Gist.variants` reports it and the
  refusal path is exercised on the platform that refuses, but the ~15 MB build was
  not downloaded, so nothing here says what it answers.
- **No accuracy claim of this package's own.** Upstream's "the right topic is in
  the top three 91% of the time, on 572 human-labelled real posts" is upstream's
  measurement. Six headlines are six headlines.
- **Latency is a simulator's.** A simulator has no Neural Engine, so these are CPU
  numbers. For this model that matters less than for the others — it is an MLP
  head, not a transformer — but it is still not a device figure.

### A crash that is not this model's, and the shape that avoids it

The full self-test ended, twice, with the process dying afterwards: once stuck
with its busy indicator still spinning, once gone. The crash report names
`hermes::vm::HadesGC::youngGenCollection` on
`com.facebook.react.runtime.JavaScript` — a corrupted Hermes heap surfacing at the
next collection, which is the downstream symptom `docs/architecture.md` describes
rather than a site.

The two crashes in the same session that *do* name a site name someone else:

```
Thread: com.apple.root.user-initiated-qos.cooperative
  ExpoModulesCore  static Record.encode(_:in:)
  DesertAntExample closure #6 in ClearModule._decorateModule(object:in:)
```

```
Thread: com.apple.root.user-initiated-qos.cooperative
  ExpoModulesJSI   JavaScriptValuesBuffer.deinit
  DesertAntExample closure #2 in EmoModule._decorateModule(object:in:)
```

Both are async returns being encoded off the JavaScript thread — Clear's is the
defect this repo already had documented and queued, and Emo's is a second
instance of the same one, found here. Neither is Gist's, and the first of them
was recorded by a crash that predates this package being in the binary at all.

A Gist-only session then ran **three `classify` calls and sixty `scores` calls
plus five native `channelTopics`** through the example app's UI with no other
model touched, and the process stayed up throughout. That is evidence for the
split shape being enough, not proof that it is: the defect is a race, and a race
that did not fire is not a race that cannot.
