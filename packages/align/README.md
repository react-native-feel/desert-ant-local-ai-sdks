# @desert-ant-labs/react-native-align

On-device word-timestamp refinement for React Native and Expo. Apple's
`SpeechAnalyzer` transcribes an audio file; Align takes the **same words** and
moves their start and end times, by tens of milliseconds, so a caption highlights
the word you are hearing and a cut lands between two of them instead of through a
consonant.

**iOS 26+ only.** The text is never changed — Align is not a recognizer and does
not replace one. What comes back is Apple's transcript with better numbers on it,
plus Apple's original numbers beside them so you can see what changed.

Upstream measures Apple's mean boundary error at **106.4 ms** and Align's at
**20.2 ms** on LibriSpeech test-clean, with 95% of words inside 50 ms, and a
macro-average across its nine languages going from 124.2 ms to 43.9 ms. Those are
[Desert Ant's numbers on Desert Ant's corpus](https://desertant.com/models/align/)
and this package does not restate them as its own; `timestampShift` is here so you
can measure what happened on your audio.

The weights are **0.7 MB** — two Core ML cascade stages plus three sidecars, 13
files, 672,560 bytes measured on disk — which makes this the second-smallest model
in the Desert Ant family after Shapes.

Wraps [Desert Ant Labs' Align model](https://desertant.com/models/align/) —
`Sources/Align` in the `desert-ant-core` Swift package. There is no Android half
and no web half: upstream's manifest records the Kotlin and JavaScript SDKs as
`none`, and `Package.swift` puts the target outside its `models` array with a
comment saying why — *"Align is Apple-only (Core ML, Speech, AVFoundation), so it
lives outside the `models` list: it gets no Android/Node/Web products and no
NativeBindings."*

## Install

```sh
npx expo install @desert-ant-labs/react-native-align
```

Add the config plugin to `app.json`:

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-align"] } }
```

Then `npx expo prebuild` and build a dev client. Expo Go cannot load it — this is
a native module.

The plugin does one thing your own config would not otherwise say: it raises the
iOS deployment target to **17.0**, the `desert-ant-core` package floor, above
Expo's 16.4 default. It does **not** raise it to 26, even though Align needs iOS
26 to do anything — see *[Why the pod is iOS 17 and the model is iOS
26](#why-the-pod-is-ios-17-and-the-model-is-ios-26)*. It touches no
`build.gradle`, because there is no Android half to touch.

## Use

```ts
import { Align, timestampShift } from '@desert-ant-labs/react-native-align';

if (!Align.isSupported) return;             // Android, or an iOS older than 26

const align = await Align.load();           // 0.7 MB, fine on mount
await align.prepareLocale('en-US');         // Apple's recognizer — the big one

const { text, words, refinedWordCount } = await align.transcribe({
  uri: recording.uri,
  locale: 'en-US',
});

for (const w of words) {
  console.log(w.text, w.originalStart, '->', w.start, w.refined ? '' : '(kept)');
}

const shift = timestampShift(words);
console.log(`${shift.refinedCount}/${shift.wordCount} moved, ` +
            `mean ${(shift.meanAbsSec * 1000).toFixed(1)} ms`);
```

### Two downloads, not one

This is the only model in this family that needs something Desert Ant does not
ship, and it is the larger half.

| | what | how big | who manages it | which call |
| --- | --- | --- | --- | --- |
| Align's weights | two Core ML cascade stages + 3 sidecars | **0.7 MB** | `desert-ant-core`'s catalog | `Align.load()` |
| Apple's recognizer | the on-device speech model for one locale | hundreds of MB | Apple's `AssetInventory` | `align.prepareLocale(locale)` |

An app with the first and not the second has nothing to refine. `transcribe`
installs the second for you on its first call, but `prepareLocale` exists so you
can pay that cost at a moment of your choosing — behind a button and a progress
bar, the way Voz's 490 MB and Clips' 288 MB are handled in this repo.

### The locale is required, and a typo is refused

`SpeechTimestampRefiner` resolves a language id from the locale you give it, and
when it cannot find one **`refine` becomes a passthrough**: it returns Apple's own
timestamps, unchanged, and raises nothing. So `locale: 'eng-US'` would ship you
Apple's 106 ms mean error while looking exactly like a refined result.

This package refuses instead, in three places — in TypeScript before the bridge,
natively before the model, and against the model's own language map:

```ts
await align.transcribe({ uri, locale: '' });           // ERR_INVALID_ARGUMENT
await align.transcribe({ uri, locale: 'english' });    // ERR_INVALID_ARGUMENT
await align.transcribe({ uri, locale: 'cy-GB' });      // ERR_INVALID_ARGUMENT — no model for Welsh
```

If a transcript of unknown-language audio is worth having anyway, ask for it
explicitly and read the flag:

```ts
const t = await align.transcribe({ uri, locale: 'cy-GB', allowUnrefined: true });
t.languageRefined;    // false — every timestamp below is Apple's
```

### Both timelines come back

`AlignedWord` carries `start`/`end` **and** `originalStart`/`originalEnd`, and a
`refined` flag. That is not redundancy: the whole product is a delta of tens of
milliseconds, and a result carrying only the corrected span would be
indistinguishable from Apple's output with a flag bolted on.

`refined: false` is an ordinary outcome rather than a failure. Upstream keeps
Apple's span whenever either boundary's cascade output is invalid, the coarse
correction lands at the edge of its search window, or the correction would invert
the word — a documented fallback. When it is false, the two spans are identical by
construction.

`timestampShift(words)` is pure arithmetic over a result you already hold: no
model, no bridge hop, no download, the same kind of call as Gist's
`channelTopics` and Redact's `restore`. It reports the mean and max absolute
movement per **boundary** (two per word, which is the unit upstream's 106.4 ms and
20.2 ms are quoted in) and the signed means, which is where a systematic bias
would show.

It is **not** accuracy. It says how far the two models disagree, not which one is
right; that needs reference boundaries, which a device does not have.

### The join: Align, Uhm, and a cut that lands on silence

```ts
const { words } = await align.transcribe({ uri, locale: 'en-US' });
const { fillers } = await (await Uhm.load()).analyze({ uri });
const clean = Uhm.reconcileWords(words, fillers);
```

`AlignedWord` is structurally `Uhm.WordRange` plus extra fields, so it goes
straight in. This is the one place in this family where tens of milliseconds
change an output rather than a number on a screen: `reconcileWords` trims word
spans around the fillers so an automated cut misses both.

**Align does not refine Voz's words**, and that is upstream's shape rather than a
gap here. `SpeechTimestampRefiner` has two `refine` overloads that take an
arbitrary `[WordTiming]` and audio, and both are `internal` to the `Align` module;
the only `public` entry point is `refine(_ result: SpeechTranscriber.Result)`. So
Align *replaces* Voz as the word-timestamp source when you want refined ones — it
cannot sharpen a transcript that came from somewhere else.

## API

```ts
class Align {
  static readonly isSupported: boolean;
  static readonly unsupportedReason: string | null;
  static readonly isAppleSpeechAvailable: boolean;
  static readonly nativeCoreVersion: string | null;
  static readonly modelRevision: string | null;      // 'main' today — read the next line
  static readonly revisionIsPinned: boolean;         // false today. See below.
  static readonly modelRepo: string | null;
  static readonly defaultMaxBufferedSeconds: number; // 30

  static load(options?: AlignLoadOptions): Promise<Align>;
  static create(options?: AlignLoadOptions): Align;

  isDownloaded(): boolean;                 // Align's 0.7 MB, not Apple's recognizer
  supportedLanguages(): string[];          // read off the downloaded config; [] before load
  resolvedDirectory(): string;             // where the weights landed; '' before load

  warm(onProgress?): Promise<void>;
  download(onProgress?): Promise<void>;    // the same call as warm
  prepareLocale(locale: string, onProgress?): Promise<void>;
  transcribe(options: TranscribeFileOptions): Promise<AlignedTranscript>;
  release(): void;
}

function timestampShift(words: readonly AlignedWord[]): TimestampShift;
```

`TranscribeFileOptions` is `{ uri, locale, allowUnrefined?, maxBufferedSeconds?,
onProgress? }`. `AlignedTranscript` carries `text`, `words`, `locale`,
`languageRefined`, `refinedWordCount`, `durationSec`, `processingSec`,
`refineSec`, `setupSec`, `realtimeFactor`, `modelRevision` and `modelRuntime`.

Failures are `DesertAntError` with a stable `code`: `ERR_UNSUPPORTED_PLATFORM`,
`ERR_MODEL_UNAVAILABLE` (Align's weights **or** Apple's recognizer),
`ERR_MODEL_LOAD_FAILED`, `ERR_AUDIO_DECODE_FAILED`, `ERR_INFERENCE_FAILED`,
`ERR_INVALID_ARGUMENT`, `ERR_RELEASED`.

## Things the types cannot tell you

### The pinned revision is a branch

`Align.revisionIsPinned` is **false**, and it is the one thing in this package to
read before shipping.

Every other model in this repo resolves a `v`-prefixed tag.
`Sources/Align/Catalog.swift` resolves `"main"`, with upstream's own
`// TODO: pin to a tagged revision once the align model repo is tagged` above it.
The consequence is concrete: two users installing your app a week apart can get
different weights and different timestamps, with **no version number anywhere
moving** — not this package's, not `desert-ant-core`'s, and not
`AlignedTranscript.modelRevision`, which reads `main` in both cases. On disk the
branch name is the cache directory: `…/desert-ant-labs/align/main/`.

`Sources/Ear/Catalog.swift` states the rule this breaks, in upstream's own words:
*"Pinned to a tag rather than a branch. A branch means a push to the Hub silently
changes what already-shipped SDKs download, which is the kind of change nobody is
looking for when something starts behaving differently."*

If reproducibility matters, resolve the weights once, ship that directory with
your app, and pass it as `directory` to `load` so the download never runs.
`revisionIsPinned` is computed from the catalog rather than hardcoded, so it flips
to `true` on its own the day upstream tags the repo.

### Nine languages, read off the downloaded config

`de, en, es, fr, it, ja, ko, pt, zh` — German, English, Spanish, French, Italian,
Japanese, Korean, Portuguese, Chinese.

`supportedLanguages()` reads that list out of `refiner_config.json`, one of the
three sidecars the model downloads, rather than restating it in TypeScript. That
is why it is a method on a loaded model and not a static: before `load` there is
genuinely nothing to answer with. (Shapes hit the opposite case — a vocabulary
that cannot be read off the binary at all — and wrote up why it left the list in
TypeScript instead. Align can read it, so it does.)

The match against your locale is the first two characters of its language code,
lowercased, which is how `SpeechTimestampRefiner` resolves its own language id.

### Why the pod is iOS 17 and the model is iOS 26

Align's artifacts would load on iOS 16 — `Catalog.swift` declares no `osFloor`, so
it inherits `OSFloor.packageFloor`. What needs iOS 26 is the *API*:
`SpeechAnalyzer` and `SpeechTranscriber` are iOS 26, and the only public way into
the refiner takes one of their results.

So every Speech reference in `ios/` sits inside an `@available(iOS 26, *)` scope,
the pod compiles at 17, and the refusal happens at runtime through
`Align.isSupported`. Putting 26 in the podspec instead would raise the **whole
app** to 26 — CocoaPods gives an app one deployment target — and an app that
installs Align beside Shapes or Emo would lose every device below iOS 26 for
models that run fine on 17.

This is the same reasoning already written into
`packages/core/ios/DesertAntCore.podspec` for the mirror-image case, and the
opposite of Clips, whose iOS 18 floor is a real artifact floor: `clips.mlmodelc`
is a Core ML multifunction package and an older OS refuses to load it.

### There is no session to build at load time

`load()` downloads and parses; it builds nothing. `SpeechTimestampRefiner`
constructs its two Core ML stages in its own initializer, and that initializer is
per-locale **and** per-audio-file — the file-input form calls `useCompleteAudio`,
which loads that file's samples into the refiner. So a refiner is a per-call
object and `setupSec` on the result is what building it cost.

That is why this model has no warm-up step to demonstrate and why `isDownloaded()`
returning true does not mean a transcript is possible: it says nothing about
Apple's recognizer.

### `maxBufferedSeconds` is validated, and does nothing here

Upstream stores it and multiplies it into a ring-buffer cap with no check at all,
so `0` caps the buffer at zero samples and `NaN` makes the `Int(...)` conversion
trap. Neither is a reading of "how much context should I keep", so both are
refused.

It has no effect on this SDK's file path, which loads the whole file into the
refiner and clears the ring buffer it bounds. It is forwarded because it is
upstream's only tunable, and validated because a value that does nothing today
should still not be nonsense tomorrow.

### Progress reports two phases and invents neither

`loadingModel` carries a true byte fraction from the catalog's `DownloadProgress`
and, for Apple's half, `AssetInstallationRequest.progress.fractionCompleted`.
`transcribing` carries `result.range.end / durationSec` off Apple's own result
stream — how far into the recording the recognizer has finalized.

Refinement itself reports nothing, because there is nothing to report: `refine`
takes no handler on any overload, and it is milliseconds.

### `.audioTimeRange` is not optional, so this SDK owns the transcriber

`SpeechTimestampRefiner` reads word spans out of the result's `AttributedString`
runs. A transcriber configured without `.audioTimeRange` produces runs with no
time attribute at all, so the refiner sees **zero words**, returns its input
unchanged, and the whole thing silently degrades to plain transcription. This
package constructs the `SpeechTranscriber` itself with that option always set,
which is what makes it unmisconfigurable from JavaScript.

## Every async call returns nothing, on purpose

`transcribe` on the native side is `@JS async ... async throws` returning
**`Void`**. The transcript comes back through a synchronous `takeTranscript` on
the shared object.

That is the fourth Expo Modules 2.0 limit this repo has had to design around: a
`@JS async` function's return value can be encoded **off** the JavaScript thread
and segfault the runtime, on `com.apple.root.user-initiated-qos.cooperative`
rather than on `com.facebook.react.runtime.JavaScript`, and `@JavaScriptActor`
does not prevent it. Ear hit it on `[String]`, Clear in `Record.encode`, Emo in
`JavaScriptValuesBuffer.deinit` on an array of `@Record`s.

An `AlignedTranscript` is Emo's exact shape at a larger scale — an array of
`@Record`s inside a `@Record`, one entry per word, so a minute of speech is a
couple of hundred of them. A synchronous `@JS` member runs on the JavaScript
thread by construction, which is where the encode has to happen. Same shape as
`packages/shapes`' `takeRecognition`, `packages/redact`'s `takeRedaction` and
`packages/gist`'s `takeTagging`.

## Apple's assets must be reserved before they can be asked about

Found by getting it wrong. `AssetInventory.assetInstallationRequest(supporting:)`
called before `AssetInventory.reserve(locale:)` fails with

```
SFSpeechErrorDomain Code=1 "Cannot check the download status,
com.example.app is not subscribed to transcription.en"
```

which reads like a missing entitlement and is not one. Reserving is what declares
the interest that word "subscribed" refers to. Nothing upstream mentions it,
because `desert-ant-core` does not manage Apple's assets at all — its download is
the 0.7 MB, and the recognizer behind it is assumed to be somebody else's problem.
Here it is this package's problem, so: resolve the locale through
`SpeechTranscriber.supportedLocale(equivalentTo:)` (Apple keys reservations on its
own spelling), reserve it, then ask.

## Verified

Driven on an iOS 26.4 simulator (**iPhone 17 Pro Max**) with a dev build,
alongside Clear, Voz, Clips, Uhm, Ear, Emo, Tongue, Gist, Redact and Shapes — the
**eleventh pod** in an app that already carried ten. Every number below was
measured on that run.

**What was verified:**

- The pod builds and links into an app carrying ten other Desert Ant pods, with
  no duplicate symbols. `DesertAntCore.podspec` gained `'Align'` and nothing
  else; no `_NumericsShims` include path was needed, because `alignTargets`
  depends only on `DesertAnt`.
- The module registers and every `@JS` property reads:
  `[align] isSupported=true nativeCore=3.1.0 revision=main pinned=false
  repo=desert-ant-labs/align appleSpeech=false maxBuffered=30`.
- **`revisionIsPinned` is false**, reported at launch and on screen, which is the
  risk this package exists to surface rather than hide.
- **The download works.** `[align] ready in 33345ms downloaded=true
  languages=de/en/es/fr/it/ja/ko/pt/zh`. On disk: **672,560 bytes across 13
  files** under `…/desert-ant-models/desert-ant-labs/align/main/` —
  `align_coarse.mlmodelc/` and `align_fine.mlmodelc/` plus
  `refiner_config.json`, `mel_filters.bin` and `calibrator.bin`. The directory
  name is the branch.
- **The language list is read off the artifact**, not from TypeScript: the nine
  codes above come out of the downloaded `refiner_config.json`, and they match
  the nine the product page advertises.
- **Every refusal fires before a native call**: an empty locale, `'english'`,
  `'cy-GB'` (a locale Align has no model for), `maxBufferedSeconds: 0` and
  `maxBufferedSeconds: NaN` all raised `ERR_INVALID_ARGUMENT`.
- **A missing recognizer is classified, not guessed**: `transcribe` with a valid
  locale and a real speech file raised `ERR_MODEL_UNAVAILABLE`, with a message
  naming the cause rather than Apple's.
- `[selftest] all prepared models passed`, and **no crash attributable to Align**.
  Two `EXC_BAD_ACCESS`es were observed across the session, and both symbolicate to
  the same stack: `ClearMetrics.toObject` → `Record.encode` →
  `ClearModule._decorateModule` closure #6, on
  `com.apple.root.user-initiated-qos.cooperative`. That is the known, pre-existing
  Clear async-return crash, queued separately — tripped here by the Clear leg of
  the self-test, which runs *after* Align's and had no effect on it. It is a race:
  of four self-test runs, two completed and two did not. Align's own async entry
  points return `Void` by construction and never appeared on a crashing stack.
- **The other half of the join runs on the same audio.** Uhm found six filler
  spans in the 10.93 s speech sample (`rtf=10x`), and `Uhm.reconcileWords`
  exercised all five of its rules — so the only part of the chain that is untested
  is Align's own contribution to it.

**Two real bugs were found and fixed on the device**, neither of which any
compiler or unit test would have caught:

1. `assetInstallationRequest` before `reserve` fails with *"not subscribed to
   transcription.en"*. Reserve first.
2. Reserving `Locale(identifier: "en-US")` is not the same as reserving what
   `SpeechTranscriber.supportedLocale(equivalentTo:)` returns (`en_US`). Apple
   keys on its own identifier.

### Not verified

**Transcription and refinement have never run.** That is the headline and it is
not a small caveat: the central claim of this model — that word boundaries move —
is unmeasured here.

The reason is the simulator, and it was diagnosed rather than assumed. On this
iPhone 17 Pro Max running iOS 26.4:

- `SpeechTranscriber.isAvailable` is **false**;
- `SpeechTranscriber.supportedLocale(equivalentTo: en-US)` nevertheless answers
  `en_US`, so the supported-locale check does not catch it;
- `AssetInventory.status(forModules:)` answers **`.unsupported`**;
- `SpeechTranscriber.installedLocales` is **empty**;
- and `assetInstallationRequest` then throws `SFSpeechErrorDomain Code=1` even
  after a successful `reserve`.

Apple's on-device recognizer assets are device-only. No physical device was
available. The SDK now reports this case as a sentence naming the simulator
instead of forwarding Apple's message about a download status, which is the most
this could be taken to.

So, specifically **not** measured: any latency (`processingSec`, `refineSec`,
`setupSec`, `realtimeFactor`), any word count, any boundary movement, any value of
`timestampShift`, the `transcribing` progress fraction, the `allowUnrefined`
passthrough against real audio, and the Align → Uhm join end to end. Upstream's
106.4 ms / 20.2 ms figures are upstream's and are attributed as such everywhere
they appear.

Also not verified: the 33.3 s and 33.7 s `load()` figures above are a **ceiling
under contention**, not Align's own cost — they were measured at app mount while
six other models downloaded and built Core ML sessions concurrently on a
memory-pressured machine (Uhm reported 57.0 s in the same window), and the second
of them had `downloaded=true`. No isolated load figure was measured.

## License

This wrapper is MIT. The model is not: it ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0)
— free below 100,000 monthly active devices per platform per model, attribution
required in your app, and no using the model or its outputs to train a competing
on-device model.
