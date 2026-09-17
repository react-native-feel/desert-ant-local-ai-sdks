# Architecture: why Expo Modules, and what it costs

This is the decision record for the native layer. It exists because the obvious
question — "Expo Modules 2.0 or Nitro?" — has a defensible answer only once you
know what Desert Ant actually ships and what `expo-modules-core` 57 can actually
convert.

Everything below was read out of the shipped artifacts, not recalled.

## What Desert Ant ships for Clear (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Clear` in `desert-ant-core` | **No podspec, no XCFramework.** `swift-tools-version: 6.2`, package floor `iOS 17` but Clear's Core ML artifact needs **iOS 18**. |
| Kotlin | `ai.desertant:clear:3.1.0` on Maven Central | Plain AAR; `ai.desertant:core` (LiteRT + a Swift-JNI shim) comes transitively. API 24+, `arm64-v8a` and `x86_64`. |
| JavaScript | `@desert-ant-labs/clear` | WebAssembly + LiteRT.js, or a prebuilt Node native core. **Neither is usable from React Native.** |

So this has to be a native module on both platforms. There is no JS path.

The two Swift/Kotlin SDKs are also not symmetric, which shapes the whole design:

- **Swift has a file API.** `Clear.enhance(path:to:)` decodes with AVFoundation,
  runs a bounded-memory streaming pass, and picks the output encoding from the
  extension. It takes a `ProgressHandler`.
- **Kotlin has no file API and no progress.** `Clear.kt` exposes exactly
  `enhance(channels: List<FloatArray>, sampleRate, options)`. `LoadedModel.download()`
  takes no callback either.

## What Desert Ant ships for Voz (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Voz` in `desert-ant-core` | Core ML only. No `@available` of its own, so its floor is the package's `iOS 17`. |
| Kotlin | — | **Nothing.** `Sources/Voz/Catalog.swift` declares `files` for `.apple` and no other platform. |
| JavaScript | — | Nothing. |

Voz is Apple-only by construction, not by omission, and the package says why: it
drives Core ML directly rather than going through the shared `InferenceSession`,
because preallocated buffers, `outputBackings` and a lane-batched decode loop are
not expressible through a generic `run(inputs:outputs:)` — and dropping them costs
"roughly 127x on load and about a third of decode throughput".

So this SDK is iOS-only too, and `Voz.isSupported` answers `false` elsewhere via
`requireOptionalNativeModule`, which resolves to `null` off iOS instead of
throwing at import. One bundle still ships everywhere.

Two consequences for the design, both pleasant:

- **No buffer-marshaling problem.** The constraint that shaped Clear's API — that
  `expo-modules-core` 57 cannot return a Swift-allocated buffer through `@JS` —
  only bites when audio has to travel *back*. Voz takes audio and returns text,
  so there is no `VozAudio` shared object and no two-call `takeEnhancedAudio`
  dance. `transcribeSamples` takes a `Float32Array` straight in.
- **`[VozWord]` returns fine.** A word list is an array of `@Record`s, and
  `Array: JavaScriptEncodable where Element: JavaScriptEncodable` in
  `expo-modules-jsi` plus `Record: JavaScriptEncodable` in `expo-modules-core`
  covers it. (The note further down that the conformances are "TypedArray,
  Record, SharedObject and Enumerable — and that is all" is about
  `expo-modules-core`; the container and primitive conformances live in
  `expo-modules-jsi`. `ArrayBuffer` is genuinely in neither.)

The one thing Voz costs that Clear does not is **~490 MB of weights** against
Clear's ~9 MB — a 460 MB encoder, a 16 MB decoder and a 10 MB embedding table.
That is a UX constraint more than a technical one, and it is why the example app
loads Clear on mount and makes Voz an explicit, progress-reported step.

## What Desert Ant ships for Clips (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Clips` in `desert-ant-core` | One MULTIFUNCTION `clips.mlmodelc` (selector + scorer over a shared trunk), 288 MB int8, plus a 4 MB tokenizer. |
| Kotlin | — | LiteRT files are declared in `Catalog.swift`, but no `ai.desertant:clips` is published. "Coming soon". |
| JavaScript | — | None, and deliberately: the wasm host contract holds one compiled model per module and selection needs two sessions. |

So this SDK is iOS-only too, but for a different reason than Voz: Voz has no
Android *artifact*, while Clips has files and no *package to bind to*. That
distinction is why `Clips.unsupportedReason` exists as a separate string rather
than a boolean — "no Android build yet" and "this OS is too old" are different
sentences, and an app shows different UI for them.

### Nobody enforces the OS floor, so this SDK does

`clips.mlmodelc` is multifunction, which is an iOS 18 feature: the compiled
artifact declares `specificationVersion` 9. `ClipModel` says so, as data:

```swift
public static let osFloor = OSFloor.multifunction
```

and `OSFloor` carries `isSatisfiedHere` and `unmetReason(_:)` to check it. But
**grepping the package, nothing calls either.** `osFloor` is declared by `Clips`
and `Title` and read by no one — the type's own doc says it exists so "the
catalog can be checked against the artifact instead of against somebody's
memory", not so the runtime refuses.

Left alone, an iOS 17 device would download 288 MB and then fail inside Core ML
with whatever that reports. So `ClipsModule.isSupported` evaluates
`ClipModel.supports(.current) && ClipModel.osFloor.isSatisfiedHere`, and
`createModel` throws `ERR_UNSUPPORTED_PLATFORM` carrying `unmetReason` before any
of that happens. The podspec and config plugin pin 18.0 as well, so the honest
answer arrives at three different times: at `pod install`, at build, and at
runtime for anyone who bypassed both.

### The input is text; the output has to be audio

`Clips.clips(in:limit:)` takes `[String]` — sentence texts, nothing else. But a
selected clip is only useful if you can play it, and turning selected sentences
back into spans of a recording is real logic: `Clip.ranges(in:padding:)` splits a
clip at pauses so silence is cut rather than played, pads each end into that
silence only (never into a neighbouring word), and merges spans that overlap once
padded.

That could have lived in TypeScript, taking the sentence times the caller already
has. It does not, and the reason is that it would be a *second definition of
where a cut goes*, free to drift from upstream's. So `find` takes sentences with
times, hands the model only the texts, and runs `ranges(in:padding:)` on this
side — JavaScript gets `ranges` and `durationSec` already computed.

The same argument applies to `Clips.toSentences`, which is
`Transcript.Sentence.sentences(from:)`: a recognizer emits words, this model wants
sentences, and where a sentence ends is something selection was trained on. A
regex in TypeScript would be a guess at it. It is exposed as a synchronous,
model-free module function, so it costs nothing and needs no download.

## What Desert Ant ships for Uhm (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Uhm` in `desert-ant-core` | A 45 MB DistilHuBERT `uhm.mlmodelc`, plus a ~13 KB `UhmLabel.mlmodel` type labeller. No `@available` and no `osFloor`, so its floor is the package's `iOS 17`. |
| Kotlin | — | **Nothing.** `Sources/Uhm/Catalog.swift` declares `files` for `.apple` and no other platform. |
| JavaScript | — | An ONNX export exists (51 MB, per the model page) but no npm package is published. |

This is the third distinct shape of "iOS only" in this repo, and the distinction
keeps mattering. Voz has no Android *artifact*; Clips has files and no *package*;
Uhm has **neither half of the model**. The detector has no LiteRT export, and the
type labeller is a CreateML sound classifier driven through SoundAnalysis — a
framework that exists on Apple platforms and nowhere else. Upstream's own code
says so structurally rather than in a comment: `labelDetections` is behind
`#if canImport(SoundAnalysis) && canImport(CoreML)`, with an `#else` branch that
returns the detections untouched.

So there is no `unsupportedReason` string to compute here the way Clips computes
one. `Uhm.isSupported` is false off iOS for one reason, which the TypeScript side
can state without asking native — which is just as well, because off iOS there is
no native module to ask.

### Nothing has to travel back, again

Uhm lands on the easy side of the one constraint that shaped Clear: audio goes
*in* (a path, or a `Float32Array` copied to `[Float]` before the first
suspension), and what comes back is a handful of spans. So, like Voz, this
package needs no equivalent of `ClearAudio` and no two-call handshake. The
`@Record` nesting is one level deeper than Voz's — `UhmResult` holds both a
`[UhmFiller]` and a single `UhmTimings` — and both work for the same reason:
every `Record` is `JavaScriptEncodable`, and `Array` is where its `Element` is.

`biasThresholds` crosses as a `[String: Double]`, which is the one conversion in
this repo that had not been exercised before. It works.

### Two states that are one number on the wire

`Uhm.Options.minConfidence` is `Double?` in Swift: nil means "use the bias
preset's threshold". JavaScript has no way to send that — an absent field and an
explicit `0` arrive identically, and `0` is a threshold a caller can legitimately
mean. So the record carries both `minConfidence` and `useBiasThreshold`, and
`src/Uhm.ts` is the only place that decides which. It is the same split Clips
makes for `limit` and `useDurationCurve`, for the same reason.

### `reconcileWords` stays on the Swift side

Upstream ships `Uhm.reconcileWords(_:fillers:options:)`: pure geometry over two
sets of spans, no model, no I/O. It would port to TypeScript in an afternoon.

It is exposed as a synchronous module function instead, on the same argument
`Clips.toSentences` is: it would be a *second definition of where a cut goes*.
And the rules are not ones you would reliably re-derive — a recognizer's word span
can straddle a filler, contain one, or *be* one, because the recognizer heard "um"
and wrote it down. That last case is about a third of the detections in Desert
Ant's own notes, and it is the one a naive "drop any overlapping word" loses.

The `minOverlapFraction` gate is the part worth knowing about. Voz places a word
boundary to about 80 ms and Uhm places a filler edge to 20 ms, so a sliver of
overlap between the two is the models disagreeing about the same audio rather
than a word running into a filler. At the 0.5 default a word overlapping a filler
by 8% of its length comes back **untouched**, still overlapping. That is correct,
and it surprises anyone who asserts "no word overlaps a filler" afterwards —
including, briefly, this repo's own self-test.

## What Desert Ant ships for Emo (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Emo` in `desert-ant-core` | A ~4.6 MB `emo.mlmodelc` plus two sidecars: `emo_tokenizer.bin` (~0.75 MB) and a tiny `emo_meta.json`. No `@available` and no `osFloor`, so its floor is the package's `iOS 17`. |
| Kotlin | `ai.desertant:emo:3.1.0` on Maven Central | Plain AAR; `ai.desertant:core` comes transitively. Same API as Swift: `suggestions(text, limit, skinTone)`. |
| JavaScript | `@desert-ant-labs/emo` | LiteRT.js in the browser, a prebuilt native core in Node. **Neither is usable from React Native.** |

This is the first model since Clear with a real Android half, and it breaks the
pattern the middle three established. The four "iOS only" shapes in this repo are
now: Voz has no Android *artifact*; Clips has files and no *package*; Uhm has
**neither half of the model**; and Emo has **both** — a LiteRT export and a
published AAR — so it is simply not in that list.

That makes `isSupported` mean something different here than it does for the other
three. Off Apple it is not a statement about the catalog but about the *device*:
LiteRT ships `arm64-v8a` and `x86_64`, and an ABI outside those has no `.so` to
load. So unlike Uhm, whose reason is a constant the TypeScript side can state
alone, Emo computes `unsupportedReason` natively — only the Android half knows
which ABIs the device actually reported.

### The two SDKs are symmetric, for once

Clear's whole design is downstream of an asymmetry: Swift has a file API, Kotlin
has samples only, so half the Android module is a decoder this repo had to write.
Emo has no such gap. Both SDKs take a string and return `[(emoji, confidence)]`,
both fuse download and session build into one `download()`, and both apply the
skin tone in the shared native core after the ranking. The Android module is
therefore the thinnest in this repo — a module, a shared object, two records and
the exceptions — with nothing in it that is not also on the Apple side.

One difference survives, and it is Clear's: Kotlin's `download()` takes no
callback, so Android reports progress as phase boundaries rather than fractions.
It matters less here. The download is ~11 MB, not ~490.

### Nothing to marshal, in either direction

Emo is the easiest case yet for the constraint that shaped Clear. A `String` goes
in; a short array of two-field records comes back. No buffer, no shared object for
the result, no two-call handshake — and, unlike Uhm, not even a `Float32Array` to
copy before the first suspension.

The one thing worth noting is what is *not* exposed. `EmoSuggestion` upstream
carries an `id` alongside `emoji` and `confidence`, and the id is the emoji — a
`SwiftUI.Identifiable` conformance rather than data. Forwarding it would put the
same string in a record twice and give a JavaScript caller a second field to keep
true, so `EmoSuggestionRecord` drops it.

### The skin tone is not the model's

`skinTone` reads like an inference parameter and is not one. The classifier's
~800 labels are toneless; `applyingSkinTone` walks the result's Unicode scalars
and appends a modifier to the ones whose base accepts one. So the tone cannot
change which emoji come back or in what order — worth knowing before building a
UI that re-ranks when the tone changes, because nothing will move.

It crosses the wire as the Swift enum's lowerCamelCase spelling on both
platforms, which means the Kotlin half maps rather than calling `valueOf`: the
Kotlin enum is `MEDIUM_LIGHT` where the wire says `mediumLight`. Mapping
explicitly is also what turns an unknown tone into a coded
`ERR_INVALID_ARGUMENT` instead of an `IllegalArgumentException` from the enum.

### Two plugins now write to the same `build.gradle`

Clear narrowed `abiFilters` for a LiteRT constraint. Emo has the same constraint,
so it narrows the same two ABIs — and an app with both installed runs both
plugins over one generated file. Each plugin originally matched only its own
marker comment, which would have produced two `ndk { abiFilters }` blocks inside
one `defaultConfig`: accepted by Gradle, and saying nothing the first did not.

Both now match a shared pattern instead, so whichever runs first writes the block
and the other defers to it. This is the general shape of the composition rule the
iOS plugins already followed — *only ever raise* — applied to a file where "raise"
has no meaning and "write once, across all of us" does.

## What Desert Ant ships for Ear (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Ear` in `desert-ant-core` | A ~9 MB `ear.mlmodelc` plus three sidecars: `languages.json`, `ear_meta.json` and `mel_filters.f32`. No `@available` and no `osFloor`, so its floor is the package's `iOS 17`. |
| Kotlin | `ai.desertant:ear:3.1.0` on Maven Central | Plain AAR; `ai.desertant:core` comes transitively. Samples only -- `identify(samples, sampleRate, Options(windows))` -- with no file entry point. |
| JavaScript | `@desert-ant-labs/ear` | LiteRT.js in the browser, a prebuilt native core in Node. **Neither is usable from React Native.** |

Third model with both halves, after Clear and Emo, so `isSupported` means what it
means for Emo: off Apple it is a statement about the *device*, not the catalog.
LiteRT ships `arm64-v8a` and `x86_64`, and `unsupportedReason` is computed
natively because only the Android half knows which ABIs the device reported.

The frontend is worth noting because it explains the sidecars. Every platform
runs the same graph shape -- log-mel in, language logits out -- because the mel
frontend is Swift rather than part of the artifact, and that is not for symmetry:
the frontend cannot run in float16, so folding it into the Core ML program would
either drop the whole thing off the Neural Engine or destroy the features.
Upstream measured a float16 frontend taking routing accuracy from 97.5% to 84.2%.
Hence `mel_filters.f32` shipping as a table.

### Clear's asymmetry, again -- and a smaller answer to it

Swift has `identify(contentsOf:)` and `identify(path:)`; Kotlin has samples only.
That is exactly the gap that shaped Clear, where half the Android module is a
decoder this repo had to write.

Ear needs less of one. Clear has to keep the channels apart and encode a file back
out; Ear consumes one mono buffer and returns a few candidates, so
`packages/ear/android/.../AudioFiles.kt` is the decode half alone, downmixing as
it goes -- and it does not resample, because the Kotlin `identify` takes the rate
as an argument and resamples internally.

It is still a second decoder in this repo, which is a real cost. Sharing it would
mean an Android artifact in `packages/core`, which is Apple-only today; that is
the right fix if a third model needs a decoder, and overbuilt for the second. The
memory limit is inherited from Clear's: the whole decoded file is resident. It
bites slightly less here -- Ear listens to at most three thirty-second windows --
but the windows are chosen by scanning the whole file, so the whole file still
has to be decoded to choose them.

### `isReliable` is the API, and it is not a threshold

The field that matters is a boolean, not the confidence beside it, and the
two genuinely disagree. `isReliable` is false when the top two candidates are
within 0.25 of each other **or** when the answer is Norwegian, Swedish or Danish
-- which the detector confuses with each other *confidently*, reading Norwegian
as Swedish in roughly 40% of clips. The probability does not reveal that, so no
margin test can catch it and no threshold a caller picks can either.

It is decided natively on both platforms and forwarded, never recomputed here.
Upstream's own calibration table is the argument for not second-guessing it:

| margin | answered | of those, correct |
| --- | --- | --- |
| 0.00 | 100% | 93.2% |
| 0.25 | 80.9% | **98.5%** |
| 0.80 | 63.6% | 100% |

The package's own test suite deliberately does *not* assert `isReliable` against
a recomputed margin. A test like that would be asserting a second implementation
into existence, which is the drift the native decision exists to prevent; the
example app's self-test checks only *consistency* with the two rules, which is a
much weaker claim and the only one a caller can make without duplicating the
calibration.

`Ear.confusableLanguages` is the one piece of upstream knowledge this package
does duplicate, because `confusableLanguages` is `internal` in
`Sources/Ear/Languages.swift` and neither SDK exposes it. It is here to explain a
`false`, and nothing branches on it.

### Ear reports no progress, so it emits one phase

Upstream's `identify` takes no progress handler on either platform -- only
`download` does. So an Ear emits `loadingModel` and nothing else, and no
`identifying` phase was added to `ModelPhase` in `packages/core`. Inventing a
fraction for a 250 ms call would mean making one up.

That turned out to matter for more than tidiness. The progress path is also where
a crash *appeared* to live before it was traced to the async-return encode (limit
4 above), and `supportedLanguages` now loads with progress suppressed, since no
caller of it has a progress bar to feed.

### Where Ear sits in the chain

Ahead of Voz, and the join is not decorative. `Voz.supportedLanguages` exists
because Voz does **not** detect what it is hearing: audio outside its 25
languages comes back as fluent, confident nonsense rather than as an error or a
low score, and Voz's own documentation says to establish the language some other
way first. Ear is that other way, and it names all 25 of Voz's languages, so the
comparison is always meaningful.

The example app does the comparison and reports it, but deliberately does **not**
gate on it. A real app routing unattended work should; a demo that hid Voz
behind Ear's opinion would be showing one model instead of two.

## What Desert Ant ships for Tongue (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM target `Tongue` in `desert-ant-core` | **Declared as a product and never exported.** 2 MB of int8 weights plus `tongue_meta.json` as `.copy` target resources. No `@available`, no `osFloor`, no inference runtime. |
| Kotlin | `ai.desertant:tongue:3.1.0` on Maven Central | A plain **jar**, not an AAR, and not a binding: a direct Kotlin port of the same frozen specification. No `ai.desertant:core`, no NDK, no `.so`. The 2 MB ships as a jar resource. |
| JavaScript | `@desert-ant-labs/tongue` | A third port of the same spec. Browser and Node; not usable from React Native. |

Tongue is the odd one out three times over, and every one of them changes the
shape of this package rather than a line of it.

**It is not downloaded.** Every other model in this catalog resolves its
artifacts through `ModelStore` at runtime; Tongue's whole model is 2 MB and ships
inside each package. So this SDK has no `directory` load option, no
`isDownloaded()`, no `ProgressEvent`, no `onProgress`, no `jobId` on any native
call, and no `INTERNET`-for-the-weights story. `modelRevision` names a Hub tag
that mirrors sha256-identical bytes for the website demo, and no `ModelStore`
path in any Desert Ant SDK resolves that manifest. Upstream's `Catalog.swift`
says so in its first paragraph.

**It is not bridged.** `ai.desertant:tongue` is pure Kotlin, and upstream's
reasoning is worth repeating because it is a real number: bridging the Swift core
would cost ~51 MB of static Swift runtime *per ABI* to serve 2 MB of weights. So
where Clear, Emo and Ear are one implementation plus JNI, Tongue is three
implementations -- Swift, Kotlin, TypeScript -- held to each other by golden
vectors replayed byte for byte in all three. Two consequences reach this
package. There is no ABI constraint on Android, so this is the only
cross-platform model here whose config plugin writes nothing to `build.gradle`
and whose `isSupported` off Apple is not a statement about the device. And the
usual argument for a thin wrapper -- one implementation, many bindings -- does
not apply, which is why the `INTERNET` permission in the manifest is for the
usage turnstile alone and says so.

**It is not slow.** A detection is an int8 embedding gather, a sum over the
n-grams present, one 59x32 matmul and a masked softmax. Upstream measures tens of
microseconds and documents it as a main-thread call.

### Synchronous inference, and why that is the safe shape as well as the fast one

Every other model here answers asynchronously because every other model takes
milliseconds to seconds, and an `@JS async` function on the module is how that is
expressed. Tongue's `detect` is a synchronous `@JS` function on the module
instead, and `Tongue.detect()` in TypeScript wraps it in a promise so the seven
packages read alike. `detectSync()` is the same call with the promise removed,
and it is what an `onChangeText` should use: no debounce, no timer, nothing for a
suggestion to lag behind.

The second reason is limit 4 below. A `@JS async` function's return value can be
encoded off the JavaScript thread and segfault the runtime -- that cost a day
during Ear, and the same defect had been sitting in Clear for months. A
synchronous `@JS` function's return value is encoded on the JavaScript thread by
construction. This module has exactly **one** `async` function, `load`, and it
returns `Void`; the `scripts` catalogue is a property rather than a call for the
same reason, since an array of bare strings is precisely what crashed Ear. So the
hazard has no surface here at all, rather than being avoided by care.

That is the general lesson Ear's fix only gestured at: the safe arrangement is to
split "do the work" from "hand the result over", and a model fast enough to do
its work on the JavaScript thread needs no split because there is no hop.

### `reliability` is the API, and it is four-valued on purpose

The same argument as Ear's `isReliable`, one level further. The probability is a
softmax over a masked label set and is badly overconfident on short text --
`"hi i am"` reads as Welsh at high probability to any character model.
`reliability` is keyed off evidence instead: `confident` at 18+ characters and a
0.30+ margin, `likely` at 12+ and 0.20+, `tentative` otherwise, `empty` when
normalization left nothing. Upstream's own guidance is to treat a low reliability
as *unknown* rather than as an answer with an asterisk.

`isTooCloseToCall` is a separate question, not a weaker `reliability`: it is true
when the top two candidates are within 0.12 of each other, so a long sentence can
be `confident` and still a tie between two sister languages. `"la casa"` is
equally Italian and Spanish, and presenting both is more useful than picking.

Both are decided natively on both platforms and forwarded, never recomputed here.
The package's Jest suite deliberately asserts neither against a reconstructed
threshold -- a test like that would be asserting a second implementation into
existence -- and the example app's self-test checks only *consistency* with the
rule, which is a much weaker claim and the only one a caller can make.

### The router is public API, and it explains the answers

25 of the 84 languages never reach the model: a script only one language uses
settles the route, and such answers come back at probability 1 and `confident`
however short the text is. A script several share narrows the field first, so
Cyrillic input is decoded among eight labels rather than 59. `Detection.route`
carries all of it -- verdict, the allowed candidates, and the UAX#24 script name
-- and it is forwarded because it is a better explanation of a result than a
probability is.

`'Japanese'` is the one script name that is not a Unicode script. Japanese mixes
Han with kana, so any kana settles the route even when Han characters outnumber
them; without that special case, kanji-heavy Japanese misroutes to Chinese.

`Detection.normalized` is forwarded for the same reason. It is what the model
actually saw -- NFC, lowercased, URLs and digits stripped, capped at 512 scalars
-- and a string that normalizes to two characters is a guess whatever the
probability says.

### The Apple half is written and switched off

desert-ant-core v3.1.0 declares the product:

```swift
let tongueProducts: [Product] = [
    .library(name: "Tongue", targets: ["Tongue"]),
]
```

and then builds the manifest without it:

```swift
products: products + modelProducts + alignProducts + vozProducts,
```

`swift package dump-package` on the pinned tag reports 45 products -- `Clear`,
`Voz`, `Clips`, `Uhm`, `Emo`, `Ear`, `Align`, `Title`, and no `Tongue`. The only
thing in the package that depends on the target is the `ModelCatalogTests` *test*
target, which is a target and not a product, which is why it builds green
upstream and is invisible from there.

It is not an import failure. Naming `'Tongue'` in `DESERT_ANT_PRODUCTS` fails the
whole build before a line is compiled:

```
Missing package product 'Tongue' (in target 'DesertAntCore' from project 'Pods')
```

So `packages/tongue/ios` compiles behind `#if canImport(Tongue)` into an inert
branch: the module still registers, still answers all eight `@JS` properties, and
refuses `createModel` with `ERR_UNSUPPORTED_PLATFORM` carrying a sentence that
names the cause. That is a much better failure than a package that simply is not
there, because the reason a developer would otherwise reach for -- "I must have
forgotten to prebuild" -- is wrong.

When upstream adds `+ tongueProducts`, the change on this side is adding
`'Tongue'` to the array in `packages/core/ios/DesertAntCore.podspec`. One entry;
`canImport` does the rest.

### Bundled resources would have been the next problem, and are solved anyway

Tongue would be the first product in `DESERT_ANT_PRODUCTS` to ship SwiftPM
**resources**, and the package is linked into a *pod* rather than into the app
target -- React Native's `spm_dependency` adds the product to
`libDesertAntCore.a`, and CocoaPods links that into the app. Whether the
generated `DesertAnt_Tongue.bundle` rides along to where `Bundle.module` looks is
a property of that pipeline rather than of the package.

Upstream's `Tongue()` resolves the two files through `Bundle.module`, whose
generated accessor calls `fatalError("unable to find bundle named ...")`. A
missing resource would therefore take the app down with no JavaScript error and
nothing for a caller to report. `TongueModel.swift` searches the loaded bundles
for `tongue_int8.bin` and `tongue_meta.json` itself -- `Bundle.main`, the pod's
own bundle, `allBundles`, `allFrameworks`, and one level of nested `.bundle`,
which is a superset of what `Bundle.module` checks -- and raises
`ERR_MODEL_UNAVAILABLE` with a sentence when it finds nothing.

## What Desert Ant ships for Gist (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Gist` in `desert-ant-core` | A ~74 MB `gist.mlmodelc` plus five sidecars: `gist_tokenizer.bin`, `gist_embedding.i8`, `gist_embedding.json`, `gist_config.json` and `taxonomy.json`. A second, ~15 MB English build lives under `en/` in the same repo at the same revision. No `@available` and no `osFloor`, so its floor is the package's `iOS 17`. |
| Kotlin | `ai.desertant:gist:3.1.0` on Maven Central | Plain AAR; `ai.desertant:core` comes transitively. `Gist(context, directory)` — **no variant**, so the English build is Swift-only. |
| JavaScript | `@desert-ant-labs/gist` | LiteRT.js in the browser, a prebuilt native core in Node. **Neither is usable from React Native.** |

Fourth model with both halves, after Clear, Emo and Ear, so `isSupported` means
what it means for those three: off Apple it is a statement about the *device*, not
the catalog. LiteRT ships `arm64-v8a` and `x86_64`, and `unsupportedReason` is
computed natively because only the Android half knows which ABIs the device
reported.

It is also the first model here whose *download* is the expensive half and whose
inference is not, and the architecture is why. `Sources/Gist/Model.swift` is two
streams and a head: a vocab-pruned potion embedding table gathered, dequantized,
mean-pooled and L2-normalized; hashed word and character n-grams CRC-32'd into a
fixed-dimension vector beside it; the concatenation through one MLP. No
transformer, and the embedding table stays a **sidecar** rather than a tensor op
inside the graph, because the potion stream is a lookup. So the artifact is 74 MB
of mostly table and a forward pass is single-digit milliseconds — the opposite
shape to Voz or Clips, and the reason this is the one text model in the family
that does not load on mount.

### Two builds, and only one platform can choose

`GistVariant` is a real choice rather than a label: the two trained builds live in
separate folders of one Hub repo (multilingual at the root, English under `en/`)
and a variant is a path prefix, so selecting one never downloads the other.
`Gist(variant:directory:)` takes it in Swift; `ai.desertant:gist`'s whole
constructor is `Gist(context, directory)`, and its own KDoc says the English build
is "currently selectable from the Swift SDK only".

So `Gist.variants` is read off the binary and is **two entries on iOS and one on
Android**, and a variant picker should be gated on that list rather than on
`Platform.OS` — a released Kotlin SDK that gains the choice lights up with no
change here. Asking for `english` on Android is refused with
`ERR_UNSUPPORTED_PLATFORM` in both halves, rather than quietly loading 74 MB when
15 was asked for, which is the failure a caller could not detect.

### The threshold is not readable, so it is not reported

`classify` returns the ranked topics above the model's tuned threshold **plus the
top topic whatever its score**, on both platforms. That rule makes the answer
always non-empty, which is right — a fixed 36-topic list means a subject outside
it gets the nearest topic on it — and makes "did this clear the bar?" a real
question.

Neither SDK will answer it. `Model.threshold` is `internal` in Swift and
`Gist.tagged` is `private` in Kotlin; the value lives in the weights'
`gist_config.json` and is upstream's to retune. The two options were to copy the
number, which would be right until the next revision and then silently wrong, or
to report nothing. `Tagging.threshold` therefore echoes an explicit override and
is `null` otherwise — the same refusal Ear makes for `supportedLanguages` on
Android, for the same reason.

What is derivable is stated in the types instead: topics are sorted descending and
only the first is exempt, so **more than one topic means every one of them
cleared the threshold**, and exactly one means it may be the nearest rather than a
confident answer. That is a weaker claim than the number, and it is one this
package can make without keeping a copy of upstream's calibration.

### Blank input: the two SDKs disagree, and this package picks Kotlin's side

`ai.desertant:gist` guards `classify` and `scores` with `if (text.isBlank())
return emptyList()`, before it touches the model. `Sources/Gist` has no such
guard: a blank string tokenizes to nothing, pools to zeros, and runs the head
over an all-zero feature vector — and because `classify` always returns its top
topic, it comes back naming a topic with nothing behind it.

Kotlin's is the honest behaviour, so the Apple half was given the same guard. It
is the one place in this repo where a native half deliberately differs from its
own upstream, and it is worth the divergence twice over: the alternative is an
answer that means nothing, and returning early means a text field wired straight
to `classify` costs nothing while it is empty — including on a device that has
never downloaded the 74 MB.

### `channelTopics` is bound, not ported

Upstream ships a channel roll-up as a **free function** on both platforms —
`channelTopics(posts, options:)` in Swift, a top-level `fun` in Kotlin — that is
pure, deterministic and involves no model: probability-weighted mass per topic
with optional exponential recency decay, a share floor, and a minimum post count.

It could trivially have been thirty lines of TypeScript. It is bound instead,
because Swift and Kotlin already agree on it field for field and default for
default, and a third implementation would be a third chance to differ on a
calculation whose output nothing would flag as wrong. The six defaults are read
off the native binary through `Gist.defaultRollupOptions` for the same reason.

Two consequences shape the JavaScript surface. It is a module-level function
rather than a method, so it answers on a device that has never downloaded a
weight — the only call in this family with no model behind it. And it is
**synchronous**, which is both the fast shape and the safe one: see limit 4.

### Every async call returns `Void`, and that is the general rule applied

Gist is the first package here written to limit 4's *conclusion* rather than
patched after hitting it. `classify` and `scores` are `@JS async` functions that
return nothing and store their result on the shared object keyed by the caller's
job id; `takeTagging` and `takeDistribution` are synchronous `@JS` members that
hand it over and remove it.

Ear's fix was the same shape applied to one call whose result happened to be
`[String]`. The architecture note above draws the general rule — split "do the
work" from "hand the result over" whenever the result is large or its encoding is
not a single scalar — and Gist's results are the largest in the family, since
`scores` is the whole 36-topic taxonomy. Applying it to both calls rather than
arguing about how many `@Record`s is too many is the cheaper decision: it costs
one synchronous hop and removes the question.

Keying on the job id rather than a single slot is what makes it correct rather
than merely lucky. Every entry point in this family already carries one for
progress routing; here it also means two concurrent `classify` calls on one model
cannot take each other's answer.

### Where Gist sits next to the others

Not in the audio chain at all, and not in Emo's or Tongue's job either. Tongue
answers *what language* a string is in; Gist answers *what it is about*, and
neither needs the other. The join worth building is with **Clips**: given one
transcript, Clips ranks which moments are worth cutting and Gist says what the
whole thing is about — the two halves of describing a piece of content, from the
same twelve lines, with one model that needs no audio and another that needs no
weights for its roll-up.

## What Desert Ant ships for Redact (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Redact` in `desert-ant-core` | A ~12 MB `redact.mlmodelc` plus two sidecars: `redact_tokenizer.bin` (a compact SentencePiece vocab) and `labels.json` (the BIOES id → label map). No `@available` and no `osFloor`, so its floor is the package's `iOS 17`. |
| Kotlin | `ai.desertant:redact:3.1.0` on Maven Central | Plain AAR; `ai.desertant:core` comes transitively. `redact.tflite` is ~25 MB — twice the Apple export, same model, same revision. |
| JavaScript | `@desert-ant-labs/redact` | LiteRT.js in the browser, a prebuilt native core in Node. **Neither is usable from React Native.** |

Fifth model with both halves, after Clear, Emo, Ear and Gist, so `isSupported`
means what it means for those four: off Apple it is a statement about the
*device*, not the catalog. `ai.desertant:redact` binds the shared native core
through JNI and `RedactNative.ensureLoaded()` loads `libRedactAndroid.so`, LiteRT
ships `arm64-v8a` and `x86_64`, and `unsupportedReason` is computed natively
because only the Android half knows which ABIs the device reported.

It is the only model in this family that is **two detectors rather than one**, and
that shows up in the API in a way none of the others do. `Sources/Redact/Model.swift`
runs a six-layer multilingual BIOES token classifier (XLM-R lineage, ~23 M
parameters, a fixed 256-token window with stride 64) over the text. In front of it,
`Deterministic.swift` is a pure-stdlib layer of regexes and real checksums — Luhn,
ISO-13616 IBAN, ISO-7064, per-country national IDs — that **owns** twelve
structured labels outright:

```swift
static let owned: Set<String> = [
    "EMAIL", "URL", "IP_ADDRESS", "CREDIT_CARD", "SSN",
    "BANK_ACCOUNT", "ROUTING_NUMBER", "TAX_ID", "GOVERNMENT_ID", "PASSPORT",
    "DRIVERS_LICENSE", "IMEI",
]
```

Those spans are reported at confidence exactly `1.0` and are not scored by the
model at all, so `minimumConfidence` — which is the only knob upstream exposes —
trims names, cities and streets and cannot touch a card or an IBAN. The types say
so, because the alternative is a caller raising the threshold to be safer and
being surprised by which half moved.

The obvious next step from that — "so `confidence === 1` tells me it was
checksum-validated" — is **wrong**, and the simulator disproved it in one tap. A
confident neural `GIVEN_NAME` comes back at exactly `1.0` too: a saturated softmax
rounds there in a `Double` once the runner-up logit is ~40 below, and several of
upstream's address post-processing stages (`attachBuildingNumbers`,
`attachStateCodes`, `redactSecondaryAddress`) construct their spans through
`Span(start, end, label)`, whose `score` parameter defaults to `1.0`. So the
implication runs one way only: deterministic ⇒ 1.0, never 1.0 ⇒ deterministic.
The **label** is what says how a detection was found.

Which raises the question of whether this package should export the owned set so
a caller can branch on it, and the answer is no, for Ear's and Gist's reason:
`Deterministic.owned` is `internal` upstream on both platforms, and a copy here
would be right until the next revision moved one label across the line and then
quietly wrong. `RedactionItem.confidence` says all of this in the types instead.

### The result is reversible, and that is the whole product

Every other text model here answers a question. This one performs a
*transformation* that has to be undoable: mask the text, send the masked text
somewhere it should not see personal data, put the originals back into what comes
out. Upstream models that as a `Redaction` struct with a `restore(_:)` method on
both platforms, with bracket-delimited numbered placeholders (`[EMAIL_1]`,
`[EMAIL_2]`, …) chosen so that no placeholder is a prefix of another and
restoration is order-independent.

A struct with a method does not cross the bridge, so `restore` is a **free
function** here, and it is **ported rather than bound** — the opposite of the call
this repo made for Gist's `channelTopics`, on purpose. `channelTopics` is
probability arithmetic over a few hundred numbers where a third implementation
could differ subtly and nothing would flag it. `restore` is a loop over
`String.replacing(_:with:)` in Swift and `String.replace` in Kotlin, both of which
replace every literal occurrence: one behaviour, four lines, no judgement.
Porting it buys something real, too — the call needs no model, no handle, and no
trip back across the bridge carrying the personal data that was just brought over
it.

### Offsets, because `Range<String.Index>` is not a wire type

`Redaction.Item.range` is a `Range<String.Index>` in Swift and cannot be encoded.
Upstream's own FFI binding already answers this: `Binding.swift` writes
`item.range.lowerBound.utf16Offset(in: text)` and the upper bound as two `u32`s,
and `ai.desertant:redact`'s `RedactionItem` carries `start` and `end` directly. So
this package reports the same two numbers rather than inventing a third
representation, and because UTF-16 code units are exactly what
`String.prototype.slice` indexes, `text.slice(item.start, item.end) === item.original`
holds in JavaScript with no conversion anywhere.

### A typo is refused, because upstream's binding drops it

`Options.labels` narrows what gets redacted. Upstream's cross-language binding
resolves the names with `Set(names.compactMap(Label.init(rawValue:)))`, which
**drops** a name it does not recognise. That is the wrong failure for this
option in two directions at once: one misspelled label silently widens the
redaction past what the caller asked for, and a set of nothing but misspellings
produces an empty set, which redacts *nothing*. Neither is visible from the
result.

So all three layers refuse. TypeScript validates against `Redact.labels`, which is
read off the binary; the Apple half throws `InvalidLabelException`; the Kotlin half
checks `Labels.ALL`. `labels: []` is refused too, so the empty array has exactly
one meaning on the wire — "use the model's default set" — rather than two.
`minimumConfidence` outside `0..1` is refused for the same reason, where upstream
would quietly clamp it: a clamped threshold is a redaction policy that is not the
one that was asked for.

### Blank input: no disagreement to settle, so a decision instead

Gist's blank-input guard exists because the two upstream SDKs disagreed and one
side had to be picked. Here neither guards it, so returning the text unchanged
with no items and without loading the model is straightforwardly this package's
decision, taken on both platforms together.

It is a safe one — the deterministic recognizers match nothing in whitespace and
the tagger has no token to label, so the answer is provably the input — and it
buys the thing this model is actually used for: a text field wired straight to
`redaction` costs nothing while it is empty, on a device that has never downloaded
the weights.

### Display names are Swift-only, so the map is the API

`Label.displayName` turns `IP_ADDRESS` into "IP address" and exists only in Swift;
`ai.desertant:redact`'s whole `Labels` object is two sets of bare strings. This is
the same shape as Gist's `english` variant and Ear's `supportedLanguages`, and it
gets the same treatment: `Redact.labelDisplayNames` is read off the binary and is
all 22 entries on iOS and empty on Android, so a UI gates on the map rather than
on `Platform.OS`, and `Redact.displayName` refuses with
`ERR_UNSUPPORTED_PLATFORM` where there are none.

Deriving one from the slug was the alternative and is worse than absent.
Title-casing produces "Drivers License", "Imei", "Ssn", "Org" and "Ip Address"
where upstream says "Driver's license", "IMEI", "SSN", "Organisation" and "IP
address" — and a wrong display name is invisible in exactly the place it matters,
which is a privacy UI telling someone what was masked.

### SwiftUI also has a `Label`

Redact's category enum is spelled `Label`. So is SwiftUI's view, and any file
importing `ExpoModulesCore` gets SwiftUI transitively through its `ExpoSwiftUI`
sources, so the bare name does not compile:

```
error: 'Label' is ambiguous for type lookup in this context
note: found this candidate (Sources/Redact/Label.swift:5:13)
note: found this candidate (SwiftUI.Label:2:15)
```

`Redact.Label` is not the fix. The module is named `Redact` and so is the class
inside it, so a module-qualified spelling resolves to the class and then fails to
find a member type on it — the same collision Gist's `channelTopics` hit from the
other direction, where a `@JS` member shadowed a free function of the same name
and needed a file-scope hop to reach it. Here the answer is
`ios/RedactLabel.swift`: one `typealias PIILabel = Label` in a file whose import
list is exactly `import Redact`, where there is no SwiftUI in scope to be
ambiguous with.

### Where Redact sits next to the others

At the **end** of the chain rather than beside it, and it is the first model here
that is about what happens to content *after* the others are done with it. Clear
cleans a recording, Ear names its language, Voz turns it into a transcript, Clips
ranks the moments and Gist says what it is about — and a transcript is exactly the
artifact an app then forwards to a summarizer, writes to a log, or attaches to a
support ticket. Redact is the step that takes the people out of it first.

That makes the Voz join the honest one to build, and the example app builds it:
whatever the microphone heard, masked before it can go anywhere.

## What Desert Ant ships for Shapes (v3.1.0)

| Platform | Form | Notes |
| --- | --- | --- |
| Swift | SPM product `Shapes` in `desert-ant-core` | A **0.2 MB** `shapes.mlmodelc` plus one sidecar, `shapes_meta.json` (the class order, the per-class confidence and residual gates, and the frozen preprocessing constants). No `@available` and no `osFloor`, so its floor is the package's `iOS 17`. |
| Kotlin | `ai.desertant:shapes:3.1.0` on Maven Central | Plain AAR; `ai.desertant:core` comes transitively. `shapes.tflite` is 1.3 MB — six times the Apple export, same model, same revision `v0.3.0`. |
| JavaScript | `@desert-ant-labs/shapes` | LiteRT.js in the browser, a prebuilt native core in Node. **Neither is usable from React Native.** |

Sixth model with both halves, after Clear, Emo, Ear, Gist and Redact, so
`isSupported` means what it means for those five: off Apple it is a statement
about the *device*, not the catalog. `ai.desertant:shapes` binds the shared native
core through JNI and `ShapesNative.ensureLoaded()` loads `libShapesAndroid.so`,
LiteRT ships `arm64-v8a` and `x86_64`, and `unsupportedReason` is computed
natively because only the Android half knows which ABIs the device reported.

It is the first model in this repo whose **input is neither audio nor text**, and
that single fact drives most of what is different about this package. A stroke is
an ordered list of `{ x, y }` in the caller's own coordinate space; the model is
scale- and translation-invariant, so there is nothing to normalize, no sample
rate, no language, and no file. It is also the first whose **output is geometry**
rather than a description — which is why this is the one package here that ships a
drawing helper.

### Two stages, two gates, and rejecting is half the product

`Sources/Shapes/Model.swift` is short enough to read in one sitting and the shape
of it explains the API. A stroke is preprocessed into a fixed 256-length window of
`[distance, cos, sin]` features plus a 1/0 validity mask, a small classifier
proposes a class, and then:

```swift
guard let gate = meta.gates[kind] else { return nil }
if confidence < gate.conf { return nil }
if confidence < Float(options.minimumConfidence) { return nil }

let (shape, residual) = Fitter.fit(kind, points: points, snap: options.snap)
if Float(residual) > gate.resid { return nil }
return shape
```

Two independent gates, both per class, both calibrated upstream and shipped in the
sidecar rather than compiled in. The residual is an RMS point-to-shape distance
normalized by the bounding-box diagonal, so a confident "rectangle" that does not
actually fit a rectangle is thrown away by the *geometry* after the network has
already voted for it.

That is why `Recognition.shape` is `Shape | null` and why the null is documented
as a result rather than a failure. A recognizer that never declines is worse than
useless on a whiteboard: a scribble silently becoming a triangle corrupts the
drawing, while a scribble staying a scribble costs nothing. The example app has a
`scribble` sample for exactly this, and it is rejected.

### The snapping is upstream's and is not configurable

`Options` has one public member, `minimumConfidence`. Its other member, `snap`, is
`internal`:

```swift
public struct Options: Sendable {
    public var minimumConfidence: Double
    var snap: SnapConfig            // internal
}
```

So the regularization — 5° to an axis for a line, 15° rotation increments, 25% to
a circle, a square, an equilateral or an isosceles triangle — is a fixed behaviour
on all three upstream SDKs. This package documents the numbers (they are literals
in `Sources/Shapes/Snapping.swift`) and exposes no knob, because inventing one
would mean reaching past `internal` into a type upstream deliberately closed.

It is also the reason the output *looks* deliberate rather than merely accurate,
and the reason the verification numbers are as clean as they are: a 151 × 137 box
comes back a 149.7 × 149.7 square because the ratio 0.907 clears the 25% gate, not
because the fitter was lucky.

### The class list cannot be read off the binary, and that is upstream's

Every other model here reads its vocabulary from the native SDK — `Label.allCases`
for Redact, `Gist.variants`, `Uhm.fillerTypes` — on the principle that a list
duplicated in TypeScript is a list that goes stale. Shapes is the one exception in
the family, and it is not a shortcut:

- `ShapeKind` — the `CaseIterable` enum with the five raw values — is `internal`
  in `Sources/Shapes/Shape.swift`.
- The public `Shape` is an enum with associated values, so it cannot be
  `CaseIterable`.
- Kotlin's `Shape` is a sealed class; its subclasses are not enumerable without
  reflection.

There is no list on either platform to read, so `Shapes.kinds` is written in
`src/types.ts` where its provenance is visible, and **no** `@JS var kinds` was
added — a hardcoded list served from the native module would look like it had been
read off the binary while being exactly as stale.

What keeps it honest is the compiler. `shapesRecognition(from:processingSec:)` in
`ios/ShapesRecords.swift` switches exhaustively over the public enum with no
`default`, so a sixth class in a future `desert-ant-core` **fails the pod's build**
rather than going silently unreported. The Android half cannot have that — it
resolves a sealed class out of a Maven artifact at runtime — so its `when` has an
`else` that throws `ERR_INFERENCE_FAILED` naming the class it did not know. That
is deliberately *not* what upstream's own Kotlin FFI decoder does:

```kotlin
// A kind this SDK does not know is a core newer than the AAR. Report it
// as "no shape" rather than half-decoding a payload we cannot read.
else -> null
```

Right for a decoder, wrong here: `null` already means "the model rejected this
stroke", and a real detection hidden behind the same value a scribble produces is
two opposite answers collapsed into one.

### The wire is flat because neither `@Record` nor JS has a sum type

`Shape` is a Swift enum with associated values and a Kotlin sealed class. The wire
carries a `kind` tag, a flat `[x, y, x, y, ...]` array, and scalar fields for the
rest — which is exactly what upstream's own cross-language binding writes:

```
u32 present          0 when the stroke was rejected, and nothing follows
u32 kind             1 line, 2 rectangle, 3 triangle, 4 ellipse, 5 star
...                  that kind's fields; points are f64 pairs
```

`src/Shapes.ts` narrows it back into a discriminated union on `kind`, so the
flatness never reaches a caller and `switch (shape.kind)` narrows in TypeScript.
A payload that cannot be the kind it claims — four coordinates for a rectangle —
is refused rather than half-read.

The stroke goes *in* flat for a different reason. A real stroke is hundreds of
points, this is the only call in the family a gesture stream can issue several
times a second, and a `[Double]` is the cheapest thing that crosses. It is also
the layout upstream's FFI already uses between Kotlin and Swift, so it is a format
two implementations agree on rather than one invented here.

### `outline` is ported, and it is the only port in this repo made knowingly

Upstream's Swift SDK has `Shape.outline(samples:)`, `cgOutline` and a ready
`CGPath`. `ai.desertant:shapes` has nothing equivalent — its whole public surface
is `Shapes`, `Shape`, `Point`, `Options` and `ShapesException`. This is the same
asymmetry `Redact.displayName` has, and the opposite decision was taken, because
the two asymmetries are not the same kind of thing.

`Redact.displayName` is cosmetic: refusing on Android costs a caller a nicer
string and a fallback is one line. `outline` is the *rendering* path. Refusing it
on Android would make the package unable to draw its own output there, which is
not a tolerable answer for a shape SDK. And the alternative to porting — writing
it once in Kotlin and once in Swift, then bridging both — is the same duplication
in two languages instead of one, with a bridge hop per frame on top.

What makes it safe is how little there is. A line, a rectangle and a triangle *are*
their outlines; the points come straight back out of the union untouched. The only
arithmetic is an ellipse sampled uniformly in its own frame and rotated into
place, and a star alternating two radii across `2 × pointCount` evenly spaced
angles from `rotation - PI/2` — both closed forms fully determined by the field
documentation upstream publishes, both pinned by unit tests written against
independently computed values, and both re-checked on device in the example app's
self-test against geometry the model itself produced. A snapped circle's ported
outline came back **1.4e-14** from its own radius.

`isClosed` ships beside it for the same reason: upstream's `CGPath` calls
`closeSubpath()` for every case except `.line`, which is trivial and is exactly
the kind of trivial thing a renderer gets wrong.

### Two refusals, both against a silent transformation

Shapes is the model where the "validate what upstream does not" rule has the most
to bite on, because geometry has a failure mode a string does not.

**A non-finite coordinate.** `StrokePreprocessor` does not reject one. Its
duplicate test is `abs(dx) > epsilon`, which is `false` for `NaN`, so a poisoned
point is *dropped* rather than caught — and the points that survive are classified
anyway, producing a real `Shape` whose geometry is `NaN`. It renders as nothing
and reads as a model that stopped working. A gesture stream that briefly reported
no location is precisely how an app gets there. Refused in TypeScript and on both
native halves, naming the offending point index.

**A `minimumConfidence` outside `0...1`.** Upstream's `Options.init` runs
`isFinite ? min(1, max(0, value)) : 0`. So `95`, meaning "95%", becomes `1.0` and
rejects every stroke; `NaN` becomes `0` and rejects none. Both look like a working
recognizer that has quietly stopped recognizing. The Kotlin SDK does not clamp at
all — it writes the `f64` onto the FFI and lets the Swift initializer on the other
side do it — so the two platforms agree only by accident. Refused on both.

What is deliberately **not** refused is a stroke of fewer than two points. That is
upstream's own "no shape" answer on both platforms — `Shapes.kt` opens with
`if (points.size < 2) return null`, and the Swift path reaches the same nil through
`DegenerateStrokeError` — and a result is not an error. Both native halves answer
it before loading the model, so an empty canvas is free on a device that has never
downloaded a weight.

### SwiftUI also has a `Shape`

`ios/ShapesGeometry.swift` is the same one-import, typealias-only file
`packages/redact/ios/RedactLabel.swift` is, written *before* the first compile
rather than after the first failure. Upstream's fitted-geometry enum is spelled
`Shape` and so is SwiftUI's protocol; any file importing `ExpoModulesCore` gets
SwiftUI transitively. `Shapes.Shape` is not the fix, for Redact's exact reason:
the module is named `Shapes` and so is the recognizer class inside it, so a
module-qualified spelling resolves to the class and then fails to find a member
type on it. A file importing only `Shapes` has no SwiftUI in scope, so
`FittedShape` and `CanvasPoint` are unambiguous there and everything else in the
pod uses them.

`Point` is aliased alongside it as policy rather than against a diagnostic —
nothing in the current toolchain's transitive SwiftUI shadows it, but this is the
one package here that puts geometry across the bridge and one extra line is
cheaper than the same investigation twice.

### Where Shapes sits next to the others

Nowhere near them, which is the interesting part. Every other model in this repo
reads a recording or a string. Shapes reads the *screen*: a stroke is something
the app already has, produced by the person using it a fraction of a second ago.
That makes it the only model here with no permission to ask for, no file to
decode, no language to establish, and no upstream chain to sit in.

It is also the cheapest by a wide margin — 0.2 MB and a 2.0 ms median pass — which
puts it in a different category of integration decision than anything else here.
Voz and Clips have to be asked about. Emo, Ear and Redact can load on mount. Shapes
barely registers as a decision at all.

## What Desert Ant ships for Align (v3.1.0)

The eleventh model, and the first one whose job is to correct another model's
answer rather than produce one of its own.

`Sources/Align` is a `SpeechTimestampRefiner`: feed it the audio Apple's
`SpeechAnalyzer` is transcribing, hand it each finalized `SpeechTranscriber.Result`,
and it returns the same words with their `audioTimeRange` boundaries moved. Two
Core ML cascade stages — a 241-frame coarse pass and an 81-frame fine pass
recentred on it — run per boundary in batches of 16, and a fitted calibrator
decides from both stages' output distributions how much of the proposed correction
to apply, or whether to keep Apple's original. Upstream reports 106.4 ms of mean
boundary error down to 20.2 ms on LibriSpeech test-clean.

Apple-only, and not by omission. `Package.swift` puts the target outside its
`models` array with the reason written above it — *"Align is Apple-only (Core ML,
Speech, AVFoundation), so it lives outside the `models` list: it gets no
Android/Node/Web products and no NativeBindings"* — and upstream's manifest
records `swift: live`, `kotlin: none`, `js: none`. So `packages/align` has no
`android/` directory at all and its `expo-module.config.json` lists
`"platforms": ["apple"]`.

### The public surface is one function, and it decides the whole design

`SpeechTimestampRefiner` has three `refine` overloads. Two of them take what a
wrapper would want — an arbitrary `[WordTiming]` plus samples, or an
`AttributedString` plus samples — and **both are `internal`** to the `Align`
module. The only `public` one is

```swift
@available(iOS 26, macOS 26, tvOS 26, visionOS 26, *)
public func refine(_ result: SpeechTranscriber.Result) -> RefinedSpeechResult
```

That single fact settles three things at once:

1. **This SDK must own the recognizer.** There is no way to hand Align a word list
   from anywhere else, so `packages/align` constructs the `SpeechTranscriber` and
   the `SpeechAnalyzer` itself and runs the file through them. `transcribe` is a
   transcription API that happens to refine, not a refinement API.
2. **Align cannot sharpen Voz.** The obvious composition — Voz reads the audio,
   Align tightens its word spans, Uhm's `reconcileWords` places the cuts — is not
   expressible against the public API. Align *replaces* Voz as the
   word-timestamp source; it does not improve it. The chain that does work is
   Align → Uhm.
3. **The floor is iOS 26**, because `SpeechAnalyzer` is.

### The OS floor is the API's, not the artifact's

`Sources/Align/Catalog.swift` declares no `osFloor`, so `AlignModel.osFloor` is
`OSFloor.packageFloor` — iOS 16 — and `align_coarse.mlmodelc` really would load
there. Nothing about the weights needs 26.

This is the opposite case to Clips, whose 18 *is* an artifact floor: `clips.mlmodelc`
is a Core ML multifunction package and an older OS refuses to load it. Here the
artifact is fine and the API around it does not exist.

So the pod compiles at 17 — every Speech reference in `packages/align/ios` sits
inside an `@available(iOS 26, *)` scope — and `AlignModelObject.isSupported`
checks `ProcessInfo.isOperatingSystemAtLeast(26)` at runtime. The config plugin
raises the app to 17 and no further.

That is a deliberate trade and worth stating as one. CocoaPods gives an app a
single deployment target, so an Align pod declaring 26 would raise the *whole app*
to 26 — Shapes, Emo, Uhm and the rest included, all of which run happily on 17. An
app that installs Align beside them would lose eight major versions of devices for
a model those devices would refuse anyway. The rule the other ten plugins already
follow gives the right answer here too: raise to what the pod needs to *build*,
and answer what the model needs to *run* at runtime.

### Two downloads, and only one of them is Desert Ant's

Align is the only model in this repo that needs something `desert-ant-core` does
not ship, and it is the larger half by three orders of magnitude.

| | what | size | managed by | call |
| --- | --- | --- | --- | --- |
| Align's weights | two `.mlmodelc` directories + 3 sidecars | **672,560 bytes**, 13 files (measured) | the catalog | `load()` |
| Apple's recognizer | the on-device speech model for one locale | hundreds of MB | `AssetInventory` | `prepareLocale(locale)` |

`isDownloaded()` answers only the first, which is why the TypeScript says so
explicitly. An app with the weights and no recognizer has nothing to refine.

Getting the second half right took two trips through a device, and neither
mistake is visible to a compiler:

* **`AssetInventory.assetInstallationRequest(supporting:)` fails before
  `reserve`.** It throws `SFSpeechErrorDomain Code=1 "Cannot check the download
  status, <bundle id> is not subscribed to transcription.en"` — which reads like a
  missing entitlement and is not one. Reserving is what declares the interest the
  word "subscribed" refers to.
* **Reserve the locale Apple names, not the one the caller passed.**
  `Locale(identifier: "en-US")` and what
  `SpeechTranscriber.supportedLocale(equivalentTo:)` returns (`en_US`) are not
  interchangeable; `AssetInventory` keys on its own spelling.

Nothing upstream mentions either, because upstream does not manage Apple's assets
at all. Its download is the 0.7 MB; the recognizer behind it is assumed to be
somebody else's problem, and on this SDK it is.

### There is no session to build, so `load` is not what it is elsewhere

Every other model here builds its platform session inside `load`/`warm`. Align
cannot: `SpeechTimestampRefiner`'s initializer constructs both `StageModel`s, and
that initializer is per-locale **and** per-audio-file — the file-input form calls
`useCompleteAudio`, which loads that file's samples into the refiner and clears
the streaming ring buffer.

So the shared object holds a resolved directory and a parsed language map, not a
refiner. A refiner is built per `transcribe` call, and what that cost is comes back
on the result as `setupSec`, separately from `refineSec`. The two are separated
because they scale differently — setup is fixed per call, refinement scales with
the transcript — and because `processingSec` includes Apple's recognition, which
is not Align's to be judged on.

### Both timelines cross the bridge

`AlignedWord` carries `start`/`end`, `originalStart`/`originalEnd` and `refined`.
That is the one design decision here that is this package's rather than upstream's,
and it follows from what the model is: a delta of tens of milliseconds. A result
carrying only the corrected span would be **indistinguishable** from Apple's output
with a boolean bolted on, and no app could tell whether the model was working.

Apple's original spans are not on `RefinedSpeechResult` in any form —
`words(from:)` is `internal` — so this package walks `result.original.text`'s runs
itself, the same way upstream walks them, and pairs the two arrays by index. If
that pairing ever breaks it degrades to "original equals refined", not to a wrong
number.

`timestampShift` is the pure half, in TypeScript alongside Gist's `channelTopics`
and Redact's `restore`: no model, no bridge hop, no download. It averages over
*boundaries* rather than words, because two per word is the unit upstream's 106.4
ms and 20.2 ms are quoted in.

### A locale typo would void the result silently, so it is refused

`SpeechTimestampRefiner.init` reads `locale.language.languageCode?.identifier ?? ""`
and looks the first two lowercased characters up in the config's language map. A
miss sets `languageId = nil`, and `isSupported` false — at which point `refine`
**returns its input unchanged**. No error, no flag on the call, and a transcript
that looks exactly like a refined one.

`Locale(identifier:)` never fails, so `''`, `'english'` and `'en US'` all reach
that state. This package refuses in three places: a shape check in TypeScript
before the bridge, the same check natively, and a lookup against the model's own
downloaded language map before any work starts. `allowUnrefined: true` is the
explicit opt-out, and `languageRefined` on the result is how an app that used it
tells the difference.

The same judgement covers `maxBufferedSeconds`, which upstream multiplies into a
ring-buffer cap with no validation — `0` caps the buffer at nothing and `NaN`
traps the `Int` conversion. It is validated here even though this SDK's file path
does not use the ring buffer at all.

### The vocabulary is read off the artifact, which Shapes could not do

`supportedLanguages()` returns the keys of the `languages` map in
`refiner_config.json`, one of the three sidecars the model downloads —
`de, en, es, fr, it, ja, ko, pt, zh`. Same policy as `Gist.variants`,
`Redact.labelDisplayNames` and `Uhm.fillerTypes`: a list that lives in the
artifact is read from the artifact.

Align makes it slightly harder than those three — `RefinerConfig` is an `internal`
struct and its map is not exposed on `SpeechTimestampRefiner` in any form — but
the file it is decoded from is a plain JSON sidecar this SDK has already
downloaded, so the list comes out of the same bytes the model reads it from. That
is also why it is a method on a loaded model rather than a property on the module:
before `load` there is nothing to answer with, and answering with a hardcoded nine
would be exactly the mistake `packages/shapes` declined to make when its own
vocabulary turned out to be unreadable.

### `.audioTimeRange` is load-bearing, so JavaScript never gets to set it

`SpeechTimestampRefiner` reads word spans out of the result's `AttributedString`
runs. A `SpeechTranscriber` configured without the `.audioTimeRange` attribute
option produces runs with no time attribute, so the refiner sees zero words,
returns its input, and the pipeline degrades to plain transcription with no error
anywhere. Owning the transcriber is what makes that unmisconfigurable.
`.volatileResults` is deliberately absent for the mirror reason: a volatile result
passes through `refine` unrefined by design, so subscribing would buy recognition
work for output this SDK discards.

### Where Align sits next to the others

Beside Voz, and in competition with it rather than after it. Voz is a 490 MB
recognizer that runs anywhere Core ML does and times words to about 80 ms; Align
is 0.7 MB on top of Apple's own recognizer, needs iOS 26, and times them to a
measured 20.2 ms upstream. An app choosing between them is choosing between
portability and precision, not between two steps of a pipeline.

The chain it does belong to is Align → Uhm. `AlignedWord` is structurally
`Uhm.WordRange` plus two extra fields, so `Uhm.reconcileWords` takes it directly,
and that is the one place in this whole family where tens of milliseconds change an
output rather than a number on a screen: a filler-trimmed word span is what an
automatic cut is made from.

## Is Expo Modules 2.0 real, and is it enough?

Real, and iOS-only. In `expo-modules-core@57.0.17` — current stable —
`ios/Core/ExpoModulesMacros.swift` declares `@ExpoModule`, `@JS`, `@SharedObject`,
`@Record`, `@Event` and `@OptimizedFunction`. There are no Kotlin equivalents
anywhere in the same package, matching Expo's own note that the Android
implementation is in progress (iOS experimental in SDK 57, beta in SDK 58).

That asymmetry is not a problem here. A module's two native halves are
independent implementations of one JavaScript surface; nothing requires them to
be written in the same style. So: 2.0 macros on Swift, classic DSL on Kotlin,
one `src/native.ts` holding both to the same shape. When the Kotlin macros land,
only `android/` changes.

Views are also unsupported in 2.0 — irrelevant, both models are headless.

## The one real constraint: getting audio back out

`Float32Array` is a first-class convertible type on both platforms
(`ios/Core/TypedArrays/ConcreteTypedArrays.swift`,
`android/.../typedarray/ConcreteTypedArrays.kt`), so *passing samples in* is easy.

Getting them *out* is not. In `expo-modules-core` 57 the `JavaScriptCodable`
conformances are TypedArray, Record, SharedObject and Enumerable — and that is
all. `ArrayBuffer` and `NativeArrayBuffer` conform to `AnyArgument` instead, which
the 1.0 DSL understands and the `@JS` macro does not. A `TypedArray` can only be
*wrapped*, never constructed: `TypedArray.create(from:)` takes a JS typed array
the runtime already owns.

Net effect: **under `@JS` there is no way to return a Swift-allocated buffer.**

Three ways out, and this SDK takes the first two:

1. **Don't move the audio at all.** `enhance({ uri, outputUri })` is the primary
   API. The recording is already a file, the result is a file, and a two-minute
   clip costs the same call as a two-second one. This is also the only path that
   gets the Apple streaming pass, whose peak memory does not grow with the file.
2. **A shared object the caller drains.** `enhanceSamples` allocates a
   `ClearAudio` shared object, JavaScript `write`s each channel in and `read`s
   each channel out into its own `Float32Array`. One memcpy per channel per
   direction, every typed-array touch on the JS thread where it is safe, and the
   same shape on both platforms. ~11 MB each way per minute of 48 kHz mono, which
   is exactly why it is the secondary API.

   Collecting that object takes a **second, synchronous call**
   (`takeEnhancedAudio`) rather than being the async call's return value. That is
   forced -- see the runtime limit below.
3. Mixing a 1.0 `AsyncFunction` returning `NativeArrayBuffer` into the same
   module — supported, since `@ExpoModule` merges its synthesized definition into
   `definition()`. Rejected: it would be zero-copy on Apple and would have no
   Android counterpart, so the two platforms would diverge in exactly the place
   an app is most likely to be measuring.

## What compiling and running it actually changed

Everything above was true on paper. Six things only showed up against a real
toolchain and a real phone, and each one moved the design.

### Expo Modules 2.0 limits (expo-modules-core 57)

1. **`@JS async` works on an `@ExpoModule` class but not on a `@SharedObject`.**
   The `@SharedObject` macro binds members onto the JS prototype through a
   synchronous function type, so an async member fails to compile:
   *"cannot pass function of type `... async throws -> JavaScriptValue` to
   parameter expecting synchronous function type"*. Every asynchronous entry
   point therefore lives on the module and takes the object as its first
   argument.

2. **A `@JS init` cannot throw.** The generated `_constructSharedObject` calls it
   without `try` ("call can throw but is not marked with 'try'"). Construction
   that validates its arguments is a module function returning the object --
   `createModel`, `createAudio` -- not a JS constructor.

3. **Returning a `SharedObject` from a `@JS async` function kills the process.**
   No catchable JS error, no Swift trap: SIGSEGV on device, a silent hang on the
   simulator. The same object returned from a *synchronous* `@JS` function is
   fine. Measured deliberately, with a throwaway `enhanceBufferDirect` probe run
   last in the example's self-test: every step before it logged, the probe logged
   neither success nor failure, and the app was gone. This is why `enhanceBuffer`
   returns metrics and `takeEnhancedAudio` hands over the audio.

4. **A `@JS async` function's return value can be encoded off the JavaScript
   thread, which segfaults.** Found by Ear, and it generalizes limit 3 rather
   than sitting beside it. `supportedLanguages` returned `[String]`; the crash is
   inside `Array<String>.encode(_:in:)` on
   `com.apple.root.user-initiated-qos.cooperative` rather than on
   `com.facebook.react.runtime.JavaScript`:

   ```
   Thread: com.apple.root.user-initiated-qos.cooperative
     hermesvm         createStringFromUtf8(...)
     ExpoModulesJSI   static Array<A>.encode(_:in:)
     DesertAntExample closure #5 in EarModule._decorateModule(object:in:)
   ```

   `@JavaScriptActor` on the function does not prevent it: the return value is
   encoded after the actor hop the annotation governs.

   Three things make it expensive to diagnose. It is a **race**, so it survived a
   first call and a second before taking the process down. The damage it does to
   the Hermes runtime **surfaces later and elsewhere** -- the first two crashes
   seen here were inside an unrelated progress event, one in
   `EventEmitter::emitEvent` and one in `EarProgressEvent.toObject`, which sent
   the investigation after the event emitter for an hour. And the **narrow
   reading is wrong**: the same run then crashed Clear the same way, in
   `Record.encode(_:in:)` off the same thread, so this is not "arrays of
   primitives only".

   ```
   Thread: com.apple.root.user-initiated-qos.cooperative
     ExpoModulesCore  static Record.encode(_:in:)
     DesertAntExample closure #6 in ClearModule._decorateModule(object:in:)
   ```

   That is the concrete explanation for something this repo had already recorded
   as folklore -- "Clear's in-memory path hangs on this simulator". It does not
   hang; it races, and loses.

   Ear's fix is to take the encode off the async path entirely: `loadLanguages`
   returns `Void` and the array is read back through a **synchronous** `@JS`
   member, which runs on the JavaScript thread by construction. That is a general
   shape and not a special case -- for any async call whose result is large or
   whose encoding is not a single scalar, splitting "do the work" from "hand the
   result over" is the safe arrangement here.

   Why five model packages did not hit it earlier is a matter of exposure rather
   than immunity: Uhm and Emo return `@Record`s and small arrays of them, Ear
   returned 99 strings. Clear had it all along. **Emo has since been caught too**
   — see "The async-return crash has two more sites" below — so "small arrays of
   records are fine" was exposure as well, and the rule to design to is the
   general one: an async call whose result is large, or whose encoding is not a
   single scalar, should return `Void` and hand the result over synchronously.
   Gist is the first package here written that way from the start.

Limits 1 and 2 are compile-time and self-announcing. Limits 3 and 4 are not, and
they cost most of the debugging in their respective rounds. For limit 3 the first
fix appeared not to work because the phone was locked, so `expo run:ios` silently
kept running a stale build. For limit 4 the misdirection was in the crash reports
themselves: two of the three named a component that was not at fault.

### Two pods cannot each bridge the same Swift package

Adding a second model was where this stopped being a copy of the first. Both
podspecs declared their own `spm_dependency` on `desert-ant-core`, each naming
only its own product — which reads like careful scoping and is in fact the bug.

Xcode links a package product's static library *into* the linking pod's own
archive, and every model product drags the same shared targets with it. So both
archives ended up holding the same thirteen objects:

```
$ ar -t libDesertAntClear.a
ClearAudio.o ClearModule.o ... Clear.o Regex.o JSON.o TextNormalization.o
PlatformSupport.o Usage.o JSHost.o ModelStore.o FFIBuffer.o ModelCatalog.o
Inference.o HostBridge.o DesertAnt.o NativeBindings.o AudioIO.o AudioDSP.o
$ ar -t libDesertAntVoz.a
VozModule.o ... Voz.o Regex.o JSON.o TextNormalization.o PlatformSupport.o
Usage.o JSHost.o ModelStore.o FFIBuffer.o ModelCatalog.o Inference.o
HostBridge.o DesertAnt.o AudioIO.o
```

and an app with both failed to link with **1,071 duplicate symbols**. Clear alone
had linked cleanly for months, because one copy is not a duplicate — the failure
mode simply did not exist until there were two models.

`use_frameworks! :linkage => :dynamic`, which React Native's own SPM helper
suggests in the warning it prints for exactly this situation, does **not** fix it:
both podspecs set `static_framework = true`, so they stay static frameworks and
keep their embedded copies. Measured — same 1,071.

The fix is to bridge the package exactly once. `packages/core` gains an
Apple-only `DesertAntCore` pod whose only job is to declare the one
`spm_dependency`, listing every model product the family ships; the model pods
`s.dependency 'DesertAntCore'` and add a `SWIFT_INCLUDE_PATHS` entry so their
Swift can still `import Clear` / `import Voz`. Only the linking moved.

```
libDesertAntCore.a    3.7 MB   the package, once
libDesertAntClear.a   808 KB   was 3.6 MB
libDesertAntVoz.a     588 KB   was 3.4 MB
```

The cost is the coupling: `DESERT_ANT_PRODUCTS` in that podspec names every
model, so an app installing one model still links the other's Swift, and adding a
model to this SDK means editing core. That was chosen over the alternatives —
discovering installed siblings from a podspec, which differs between a monorepo
checkout and node_modules, or pushing every consumer onto dynamic frameworks —
because it is the one that is explicit and fails loudly if forgotten. No weights
are involved either way: every model here downloads its artifacts at runtime and
the package bundles none, so this is code size, not hundreds of megabytes.

### A product import does not bring its dependencies' types

`ComputeUnits` is the one option `Clips` takes that is not a plain value, and it
is declared in the `Inference` target, not in `Clips`. Importing the product the
podspec names is not enough:

```
ClipsRecords.swift:27:41: error: cannot find type 'ComputeUnits' in scope
```

`DesertAnt` re-exports `Inference` (along with `ModelStore`, `ModelCatalog`,
`Usage` and six others), so `import DesertAnt` alongside `import Clips` resolves
it. Worth knowing before reaching for `@_spi` or redeclaring an enum: when a type
from this package is missing, the answer is usually a second import rather than a
missing API.

### AAC input crashes the upstream streaming path

`Clear.enhance(path:to:)` -- the SDK's bounded-memory streaming pass -- **kills
the process on an AAC input**. SIGSEGV, before the first progress event, with no
catchable error. A WAV through the identical call is fine, so it is the container
and not the call.

Found the way it would be found in production: the self-test feeds `enhance` a
WAV and passes, while `expo-audio`'s default recording preset produces `.m4a` --
so the first real recording crashed the app and nothing before it did.

`enhanceFile` therefore branches on the input's extension. WAV keeps the
streaming pass. Anything else is read into memory and put through
`Clear.enhance(bytes:)`, a different route into the same decoder that survives
it, and the WAV bytes it returns are written out.

Two consequences the API has to admit to, both documented on `EnhanceFileOptions`
and `EnhanceFileResult`:

- **Peak memory grows with the file** for non-WAV input, because the streaming
  guarantee is exactly what is being given up.
- **The output extension can change.** A `.m4a` request comes back `.wav`, so
  `EnhanceFileResult.uri` reports where the audio actually landed rather than
  echoing what was asked for.

This is worth reporting to Desert Ant Labs: from the outside it looks like a bug
in `Sources/Clear/Streaming.swift`, which has no public API and so cannot be
worked around any more precisely than this.

### Read the tag, not the branch

`Clear.Result.modelRuntime` exists on `main` and **not** in tag `3.1.0`, which is
what `upToNextMajorVersion` resolves. Metrics now report `modelRevision` (which
3.1.0 does have) and derive the runtime from the platform. When checking an
upstream API, read
`~/Library/Developer/Xcode/DerivedData/<app>/SourcePackages/checkouts/`, which is
the source actually being compiled.

### The deployment target needs raising in two places

Setting `ios.deploymentTarget` in **Podfile.properties.json is not enough**.
React Native's post-install aligns every pod target to the *app project's*
deployment target, so an untouched `.xcodeproj` at Expo's 16.4 default drags the
pods back down and the build fails with *"module 'DesertAntClear' has a minimum
deployment target of iOS 18.0"*. The config plugin does both.

Separately, the podspec's guard must be `respond_to?(:spm_dependency, true)`:
`spm_dependency` is a top-level `def` in `react_native_pods.rb`, which Ruby makes
a *private* method on Object, so the public-only check reports false even when the
helper is loaded.

## Verified on device

iPhone 16, iOS 26.3.1, Expo SDK 57, `desert-ant-core` 3.1.0, Debug build:

```
[clear] isSupported=true nativeCore=3.1.0
[clear] enhance(file) ok in 6393ms — selftest-clear.wav exists=true bytes=196096
        2.00s rtf=16.0x LUFS=-31.68 truePeak=-8.68
        variant=clear-studio revision=v0.3.0 runtime=coreml
[clear] enhanceSamples ok in 108ms — 1ch x 96000 @ 48000Hz rtf=18.7x peak=0.3692
```

And the real thing -- microphone in, enhanced file out, an `.m4a` from
`expo-audio` through the in-memory route:

```
[rec] uri=…/ExpoAudio/recording-81CDDEBA….m4a bytes=82354
[rec] ok — recording-81CDDEBA…-clear.wav bytes=200524 2.09s rtf=15.4x
      LUFS=-29.25 truePeak=-4.62
```

The 6.4 s file run includes the first model load; the 108 ms in-memory run that
follows it is the warm cost. Reproduce with the example app's **Run self-test**
button, which needs no microphone and no permission dialog.

The Android half has **not** been run: no Android device or emulator was
available. It compiles as written but should be treated as unverified.

### Voz, as far as it has been taken

Voz compiles, links alongside Clear, and binds. On an iOS 26.4 simulator the
example app logs, before anything touches a model:

```
[clear] isSupported=true nativeCore=3.1.0
[voz] isSupported=true nativeCore=3.1.0 revision=v0.1.0 languages=25
[voz] isDownloaded=false
```

which exercises the `@ExpoModule` registration, every `@JS` property including
the `[String]` return, `createModel` returning a `@SharedObject`, the object's
synchronous `isDownloaded()`, and `release()`. Tapping the prepare button starts
the real download and reports true `0..1` fractions through the `@Event`.

**A transcription has not been run end to end.** It needs the ~490 MB of weights
and a Neural Engine — which a simulator does not have, the model having no CPU or
GPU fallback — and no such device was available. Specifically unverified:
`transcribeFile`, `transcribeSamples`, the `[VozWord]` array crossing the bridge
(sound by construction, per the conformances above, but not observed), the
single-flight `VozLoader`, and whether an `expo-audio` `.m4a` survives
`FileAudioStream` the way the reading of that file says it should. The example
app's **Run self-test** button exercises all of them in order; run it on hardware
before trusting any of it.

### Clips, end to end

Release build, iOS 26.4 simulator, all three models installed. A twelve-sentence
synthetic transcript through `Clips.toSentences` and `clips.find`:

```
Clips found 4
#1  p1.00  11.4s  11.8-15.7, 15.8-19.6, 19.9-23.6
    "The metrics looked fine in staging, which is exactly the problem. Staging
     had a thousand users and production had two million. ..."
#2  p0.67  11.4s  23.9-27.6, 27.9-31.6, 31.9-35.6
#3  p0.33  11.4s  35.9-39.6, 39.9-43.6, 43.9-47.6
#4  p0.00  11.3s  0.0-3.6, 3.9-7.7, 7.8-11.7
    "So thanks everyone for joining, we can probably get started. ..."
```

That output exercises the whole bridge: an array of `@Record`s returned from a
`@JS async` function, each holding a *nested* array of `@Record`s (`ranges`) plus
an `[Int]`, all of which the conformance argument above says should work and none
of which had been observed working until here. It also shows
`Clip.ranges(in:padding:)` doing its job -- three spans per clip rather than one,
because the sentences are separated by pauses the rule cuts rather than plays.

The ranking is sane rather than arbitrary: the substance ranks p1.00 and the
"thanks everyone for joining" opener ranks p0.00, percentiles span the full range,
and no sentence appears in two clips.

Two things about *how* this was verified are worth recording, because both cost
time. A **dev-client build was the wrong harness**: the model load takes minutes
on a simulator and Metro reconnects reload the JS runtime mid-load, which produces
`Trying to send event 'progress' to ClipsModelObject, but the JS runtime has been
lost` and loses the result. A Release build with an embedded bundle has no such
reload. And in Release, **`console.log` does not reliably reach os_log**, so the
rendered UI -- the actual returned objects, laid out -- is the evidence, not the
log.

The example's self-test was also restructured in the process. It was one `try`
block covering all three models, so when Clear's in-memory path hung on the
simulator the Clips leg never ran and reported nothing. Three independent legs
now, each skipped if its model is not prepared: a smoke test that can only tell
you about its first failure is most of a smoke test missing.

### Emo, end to end

Emo was the cheapest model here to verify and the most complete result: no audio
fixture, no permission dialog, no long download. On the same iOS 26.4 simulator,
the module binds and reports every `@JS` property including the `[String]` return:

```
[emo] isSupported=true nativeCore=3.1.0 revision=v0.7.0 repo=desert-ant-labs/emo
      limit=3 tones=default/light/mediumLight/medium/mediumDark/dark
[emo] ready in 7585ms downloaded=true          # ~2.6 s warm on later launches
```

and suggestion works through the app's own text field. "Pay my bills" returns
💰 0.64, 📄 0.12, 💳 0.05, 🏠 0.03 — against the 0.62 upstream's README quotes for
that phrase.

The claim worth testing by hand is the multilingual one, because it is the
difference between this model and a keyword table. One intent, three languages,
three scripts, and the same top answer:

| | Top suggestions |
| --- | --- |
| `Pay my bills` | 💰 📄 💳 🏠 |
| `Pagar mis facturas` | 💰 🧾 📄 💳 ✅ 🏠 |
| `請求書を払う` | 💰 📄 🧾 📮 💳 ✅ |

Latency was 60 ms on the first call and **5–16 ms** after, measured in JavaScript
around `suggest` so the bridge hop is inside the number. Upstream's <2 ms is the
model alone, and a simulator is the CPU path, so this is a ceiling.

The skin-tone path was exercised and behaves as the docs describe rather than as
the name suggests: `skinTone: 'dark'` turned 🏃 into 🏃🏿 (U+1F3C3 U+1F3FF) and left
👟 🏁 🛒 🎽 💨 alone, with the ranking and every confidence identical to the
default-tone run. That is the concrete form of "the tone is applied after the
ranking" — nothing about the ranking moves.

**One dev-only rough edge showed up**, and it is worth recording because it is
structural rather than Emo's:

```
[emo] suggest FAILED: ERR_INFERENCE_FAILED: NotFoundException:
      Unable to find the native shared object associated with given JavaScript object
```

Fast Refresh tears down the native shared-object registry while a pending timer
still holds the JavaScript half of the model. Every package here builds on
`@SharedObject`, so every one is exposed to it — Emo is simply the only model that
calls a model from a *timer* rather than from a tap, so it is the only one that
can fire into the gap. It does not arise in a production build, where nothing
reloads the JS under a live model.

The misleading part is the code. A dead handle is much closer to `ERR_RELEASED`
than to `ERR_INFERENCE_FAILED`, but the exception is raised by ExpoModulesCore
while *converting the argument*, before any code in this repo runs, so there is
nothing to catch and re-map. Re-mapping it would have to happen in
`toDesertAntError` in `packages/core`, for all five models at once, against an
error shape only observed here. The example app recovers instead — release the
handle, re-prepare — which is the right response to any `suggest` failure an app
did not cause.

### Ear, end to end

Same iOS 26.4 simulator. The module binds and reports every `@JS` property:

```
[ear] isSupported=true nativeCore=3.1.0 revision=v0.1.0 repo=desert-ant-labs/ear
      windows=3 margin=0.25 confusable=no/sv/da
[ear] ready in 7218ms downloaded=true        # ~6.9 s warm
[ear] 99 languages, e.g. en zh de es ru ko fr ja pt tr pl ca
[ear] Voz covers 25, Ear names 99; Voz languages Ear cannot name: none
```

That last line is the join checked rather than asserted: every language Voz can
transcribe is one Ear can name, so the routing comparison is never vacuous.

**Identification is correct on real speech**, which is the claim worth testing by
hand. Six labelled samples, half a minute each -- one full window, so the
detector answers with its real context rather than from padding -- generated with
`say` and `afconvert` and dropped into the app's cache:

| Sample | Answer | Confidence | Reliable | Runner-up |
| --- | --- | --- | --- | --- |
| `en` | **en** | 0.998 | yes | nn 0.000 |
| `es` | **es** | 0.997 | yes | en 0.001 |
| `pt` | **pt** | 0.996 | yes | es 0.002 |
| `fr` | **fr** | 0.997 | yes | en 0.002 |
| `de` | **de** | 0.998 | yes | en 0.001 |
| `ja` | **ja** | 0.986 | yes | en 0.005 |

Six of six, four scripts, every one above 0.98 with a runner-up at most 0.005.

The synthetic case is the more interesting half of the same test. A 200 Hz tone
under hiss is not speech in any language, and the model says so through the flag
rather than through an error:

```
en 0.360, ja 0.192, ko 0.077, ru 0.044 — isReliable=false
```

a 0.17 margin against the 0.25 the rule requires. A confidence threshold at 0.3
would have accepted it, which is the concrete form of "do not threshold
`confidence`".

Also exercised: `identifySamples` with a native 48 kHz to 16 kHz resample; the
"fewer windows on short audio" rule, where `windows: 1` and the default both
listen to one window on two seconds of audio; `windows` of 0, -1 and 1.5 rejected
with `ERR_INVALID_ARGUMENT` before reaching native; and a missing file reported as
`ERR_AUDIO_DECODE_FAILED` rather than as an inference failure, which is the
distinction an app offering "your file is gone" versus "the model broke" needs.

Latency is **~5.5 s per identification on the simulator**, and should not be read
as the model's speed -- a simulator has no Neural Engine, so this is the CPU path
against upstream's ~250 ms on device. It is stable across every call above,
including the two-second synthetic clip, which is consistent with a fixed encoder
cost rather than one that scales with the audio.

The crash found along the way, and the one it then exposed in Clear, are limit 4
in **Expo Modules 2.0 limits** above.

### Tongue, as far as it can be taken

The shortest verification section here, and the only one whose limit is not the
hardware.

The seventh pod builds and links into an app that already carries six -- which is
the non-trivial half of adding a model to this repo, and the half that broke
twice before. The module registers and every `@JS` property reads, before
anything touches a model:

```
[tongue] isSupported=false nativeCore=3.1.0 revision=v1.0.0 repo=desert-ant-labs/tongue
         topK=3 tieMargin=0.12 maxChars=512
         reason=desert-ant-core v3.1.0 declares a `Tongue` SwiftPM product and never adds
         it to the package's `products:` array, so no consumer can link the target. The
         Apple half of this SDK is written and waiting behind `#if canImport(Tongue)`;
         the Android half, which binds the pure-Kotlin `ai.desertant:tongue` jar, is
         unaffected.
```

That exercises the `@ExpoModule` registration, all eight `@JS` properties, the
`#if canImport(Tongue)` fallback values, and the refusal crossing the bridge
intact. The example app renders the same sentence in its Tongue section, the
self-test leg skips cleanly (`[tongue] self-test skipped -- model not prepared`),
and the run still ends `[selftest] all prepared models passed` -- so the seventh
package costs the other six nothing.

**No detection has been run, on either platform.** On Apple that is the product
export above. On Android no device or emulator was available, which is where
every other model in this repo also stops. So this section quotes **no latency
and no accuracy numbers**: upstream's "tens of microseconds" and its 0.933 on
three-word FLORES-200 input against 0.887 for a 293 MB detector are upstream's
measurements, and repeating them here as if they had been observed would be the
one thing these sections exist not to do.

What is written and waiting: an eleven-language answer key across seven scripts
in the example app's self-test, a thousand-detection timing loop, assertions on
the router's two shortcuts (Hangul decisive, Cyrillic narrowing), the normalizer
and its 512-scalar cap, `topK` honouring and the argument guards, and an **Ear vs
Tongue** panel that asks both models about one recording -- Ear from the
waveform, Tongue from the words Voz got out of it -- and reports the agreement
rather than enforcing it. That join is the reason the model is in this repo, and
it is the part that has not run.

Off-device, 31 Jest tests cover the argument guards, the no-native-module path,
the module-present-but-model-not-linked path, the cold-load sequencing, the
released-handle path, the error mapping, the read-from-the-binary constants, the
empty-script-list refusal, and the config plugin -- including a permutation test
that runs Tongue's plugin at every position among Clear's, Emo's and Ear's and
asserts the single `abiFilters` block those three agree on is left exactly as
found.

### Gist, end to end

Driven on an iOS 26 simulator (iPhone 17 Pro Max) with a dev build, as the
**eighth** pod in an app that already carried seven.

The module binds and every `@JS` property reads before anything touches a model,
including the two that are not scalars:

```
[gist] isSupported=true nativeCore=3.1.0 revision=v2.2.0 repo=desert-ant-labs/gist
       topK=3 variants=multilingual/english default=multilingual
       rollup={"topN":5,"floor":0.05,"minPosts":3,"halfLifeDays":0,"touch":0.15,"nowMillis":0}
```

`variants` is a `[String]` off a property getter and `defaultRollupOptions` a
`[String: Double]` off another — both synchronous, both encoded on the JavaScript
thread by construction, which is the point.

**Loading.** ~74 MB plus the Core ML session build in **65.3 s** cold, measured on
a model prepared by itself. The first attempt failed on a Hugging Face **HTTP
429**, and that is worth recording rather than retrying past: it surfaced as
`ERR_MODEL_UNAVAILABLE` naming the URL and the status, which is the code a caller
would put a retry button behind, rather than as the `ERR_INFERENCE_FAILED` it
would have been if the load had not been pulled out ahead of the tagging call.
Two later launches loaded cached weights in **42.9 s** and **45.1 s**, both while
Emo, Ear and Uhm were loading on the same mount — an upper bound under
contention, not the session build's cost.

**Tagging.** One headline in four languages, no language passed in:

| | Top topics |
| --- | --- |
| `en` "How to start a podcast with just your iPhone" | **technology 0.931**, business 0.799, creator-economy 0.772 |
| `es` "Cómo empezar un podcast solo con tu iPhone" | **technology 0.861**, business 0.746, creator-economy 0.636 |
| `de` "Wie du nur mit deinem iPhone einen Podcast startest" | **business 0.591**, technology 0.588 |
| `ja` "iPhoneだけでポッドキャストを始める方法" | **technology 0.621**, creator-economy 0.521 |

Three of four lead with `technology`; the German phrasing puts `business` ahead by
0.003. All four rank the same two or three topics, which is the multi-label claim
rather than a near-miss, and the Japanese sentence shares no characters with the
English one. Two other subjects through the app's own field: "Why our index fund
beat the hedge fund over ten years" → **Personal Finance & Investing 0.800**, and
"The best one-pan salmon recipe for a weeknight" → **Food & Cooking 0.915**, each
a single topic — which is this model saying "nothing else cleared the bar", not
that it is unsure.

**Latency.** The first `classify` after a load costs **45.3 ms** natively; after
that, **9–11 ms end to end from JavaScript**. `scores` is **3.6–4.1 ms**
natively. Twelve transcript lines scored and rolled up ran in **74–88 ms** across
six runs. On a simulator, with no Neural Engine — which matters less for an MLP
head than for the transformers in this repo, but it is still not a device number.

**The Clips join.** The twelve-line sample transcript this app ranks with Clips,
rolled up through `scores` and `channelTopics`:

```
technology 13.9% x10   business 12.7% x8   self-improvement 6.8% x5   news-politics 5.2% x2
```

Ten of twelve lines touch `technology` and eight touch `business`. Shares sum to
0.385 rather than 1 because the floor and `topN` drop the tail. Two posts return
**0** topics — `minPosts` declining rather than being confident about two.

Also green, on two consecutive self-test runs: the ranked / bounded / unique /
named / capped invariants; `topK: 1` → one and `topK: 10` → three with the same
winner; `threshold: 1` → exactly the one topic upstream always returns, echoed
back; blank input → zero topics and no download; `scores` → 36 topics, all in
`0..1` and a superset of `classify`'s; every argument guard refusing before
native. Both runs end `[selftest] all prepared models passed`.

**Not verified.** Android was not built — there is no Android SDK on this machine
(`$ANDROID_HOME` has no `platforms` or `build-tools`), so unlike every other
package here its Android half has not even been compiled. The `english` variant
was never loaded; only the refusal path was exercised. And no accuracy claim is
this package's: upstream's "the right topic is in the top three 91% of the time"
over 572 human-labelled posts is upstream's measurement.

### The async-return crash has two more sites, and neither is Gist's

The full self-test ended twice with the process dying afterwards — once stuck with
its busy indicator spinning, once gone — and the crash report names
`hermes::vm::HadesGC::youngGenCollection` on
`com.facebook.react.runtime.JavaScript`. That is a corrupted Hermes heap surfacing
at the next collection: the downstream symptom limit 4 describes, not a site.

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

The first is the Clear defect already recorded above, reproduced by a crash that
predates Gist being in the binary. The second is **new**: Emo's `suggest` returns
`[EmoSuggestionRecord]` from a `@JS async` function, and this is that array being
torn down off the JavaScript thread. The claim in the limit-4 note that "Uhm and
Emo return `@Record`s and small arrays of them" as an explanation for their not
hitting it was exposure, not immunity, and now has a counterexample. Emo's fix is
Ear's and Gist's: return `Void`, hand the result over synchronously. It is not
made here, because it is not this model's package.

A Gist-only session afterwards ran **three `classify` calls and sixty `scores`
calls plus five native `channelTopics`** through the example app with no other
model touched, and the process stayed up. Evidence for the split shape, not proof
of it — a race that did not fire is not a race that cannot.

### Redact, end to end

Driven on an iOS 26 simulator (iPhone 17 Pro Max) with a dev build, as the
**ninth** pod in an app that already carried eight.

The module binds and every `@JS` property reads before anything touches a model,
including the two that are not scalars:

```
[redact] isSupported=true nativeCore=3.1.0 revision=v0.4.0 repo=desert-ant-labs/redact
         minConfidence=0.6 labels=22 default=21 displayNames=22
[redact] displayName(IP_ADDRESS)="IP address" displayName(ORG)="Organisation"
```

`labels` is a `[String]` off a property getter and `labelDisplayNames` a
`[String: String]` off another -- both synchronous, both encoded on the JavaScript
thread by construction, which is the shape Gist established and the one this
package was written to from the start. The two display names are the pair that
proves they are read rather than derived: no title-casing of a slug produces
"IP address" or "Organisation".

**Loading** cost **49.9 s** cold (~12 MB plus the Core ML session build) and
**39.3-46.7 s** on three later launches with the weights already on disk -- every
one of those measured while Emo, Ear and Uhm were building their own sessions on
the same mount, so they are an upper bound under contention rather than a
session-build figure.

**One sentence of nothing but contact details**, which is the case this model
exists for:

```
in   Email Anna Kovács at anna.kovacs@example.com or call +36 1 234 5678; her card is 4111 1111 1111 1111.
out  Email [GIVEN_NAME_1] [SURNAME_1] at [EMAIL_1] or call [PHONE_1]; her card is [CREDIT_CARD_1].

GIVEN_NAME   "Anna"                     1.000  @6..10
SURNAME      "Kovács"                   1.000  @11..17
EMAIL        "anna.kovacs@example.com"  1.000  @21..44
PHONE        "+36 1 234 5678"           0.920  @53..67
CREDIT_CARD  "4111 1111 1111 1111"      1.000  @81..100
```

`restore` returns the input character for character, every sample in every run,
including the label-narrowed and threshold-raised variants. Items are ordered,
non-overlapping, uniquely placeheld, present in the output and absent from it as
originals, and `text.slice(start, end) === original` for all of them.

**Latency** is **620-641 ms** natively for the first redaction after a load and
**574-584 ms end to end from JavaScript** in steady state over five measurements;
the 745-character sample transcript takes **464-477 ms**. Unlike the audio models
there is no warm/cold cliff -- the windowed 256-token pass dominates and is roughly
linear in length. These are simulator CPU numbers on a six-layer transformer,
which is the shape where the missing Neural Engine costs most in this family.

**Four of the 27 languages**, one person's details, no language passed in: English
and Spanish find the same five spans identically; German labels the imperative
*Schreib* as a `SURNAME` and misses the card; Hungarian finds the inflected dative
`Annának` correctly and catches only `+36` of the phone number. Recorded rather
than smoothed over -- upstream's 88.8% / 99.6% is a distribution, not a promise
about any particular string, and four sentences are four sentences.

**The negative case matters as much**, and both came back untouched: the
deliberately clean sample sentence (0 items, 576 ms) and the 134-word transcript
this app also ranks with Clips and tags with Gist (0 items).

**Three consecutive self-test runs ended `[selftest] all prepared models
passed`**, and `~/Library/Logs/DiagnosticReports` gained no new crash report
across those three plus a fourth interactive session. Same caveat as Gist's:
evidence for the `Void`-returning shape, not proof.

#### Two upstream behaviours found by tapping a sample

**A deterministic `IP_ADDRESS` can lose to the address post-processing.** The same
IP in the same position, two sentences:

```
"The server at 192.168.1.14 is down; ping bob.smith@acme.co.uk or SSN 123-45-6789."
  -> "The server at [IP_ADDRESS_1] is down; ping [EMAIL_1] or SSN [SSN_1]."   (3 items, all 1.000)

"The box at 192.168.1.14 logged in from https://example.com."
  -> "The box at [BUILDING_NUMBER_1].168.1.14 logged in from [URL_1]."        (2 items)
```

The second masks only the first octet, as a `BUILDING_NUMBER`, and leaves
`.168.1.14` in the text. It reproduces with and without a trailing IMEI.
`Pipeline.resolve` drops an ML span that conflicts with a deterministic one on a
different label, so from the outside this looks like `attachBuildingNumbers` /
`redactUsStreet` running *after* that resolution rather than before it. There is no
public API to work around it with, which is the same position Clear's AAC crash
left this repo in: report it and say so.

**A `Deterministic.owned` label can arrive with a sub-1 score.** That sentence's
IMEI came back at **0.900**. Together with confident neural spans saturating to
exactly 1.0, it is why this package asserts nothing about provenance from either
`confidence` or `label` and why the self-test logs those numbers rather than
checking them -- an earlier draft of the leg asserted "checksum-owned implies
1.000" and this is what disproved it.

### Shapes, end to end

Driven on an iOS 26 simulator (iPhone 17 Pro Max) with a dev build, as the
**tenth** pod in an app that already carried nine.

The pod built on the first attempt, which is the first thing worth recording
because the two things that would have broken it were both known in advance. The
`_NumericsShims` include path was copied from Gist's and Redact's podspecs rather
than rediscovered, and `ios/ShapesGeometry.swift` — the `Shape` / `Point`
typealias file — was written before the first compile rather than after the first
`'Shape' is ambiguous for type lookup`. Both are rules in this repo now, and this
is the round that tested whether they travel.

The module binds and every `@JS` property reads before anything touches a model:

```
[shapes] isSupported=true nativeCore=3.1.0 revision=v0.3.0 repo=desert-ant-labs/shapes
         minConfidence=0 kinds=line/rectangle/triangle/ellipse/star
```

`kinds` is the one value on that line that did **not** come off the binary — see
the model section above for why there is nothing to read it from — and it is
served from TypeScript rather than from a `@JS var` precisely so that the log line
is not misleading about it.

**Six synthetic strokes**, generated in code with a seeded LCG so they are the
same strokes every run, through the same `recognize` call the canvas uses:

```
[shapes] circle    105 pts -> ellipse   waited 13ms native 9.7ms circle r 72.3 at (120.0, 102.0)
[shapes]   snapped to a circle; outline error 1.4e-14
[shapes] rectangle 116 pts -> rectangle waited  4ms native 3.9ms 149.7 × 149.7 (square) at 90°
[shapes] triangle  106 pts -> triangle  waited  2ms native 1.9ms sides 171.1 / 171.1 / 171.1
[shapes] line       44 pts -> line      waited  2ms native 1.3ms (26.3, 153.1) → (210.2, 57.7)
[shapes] star      124 pts -> star      waited  2ms native 2.1ms 5 points, r 70.1 / 28.0 at 72°
[shapes] scribble   91 pts -> rejected  waited  1ms native 1.0ms
[shapes] 5/6 samples fitted; rejected scribble
```

Three of those rows are the snapping working on input that was not symmetric, and
they are the rows that make the section on it concrete rather than quoted. The
rectangle was drawn 151 × 137 — a 0.907 side ratio, inside the 25% gate — and came
back an exact square. The triangle was drawn with a 176-unit base and 168.7-unit
legs and came back exactly equilateral. The circle was drawn with ±6 units of
jitter and came back with `semiMajor === semiMinor` to the last bit, which is what
the `outline error 1.4e-14` line is measuring: every sample of the ported ellipse
parametrization sitting one radius from the center.

**The scribble was rejected**, which is the half of this model that is easy to
forget to test. It is a bounded random walk with a hard turn every seventh step —
no consistent curvature, no closed outline, nothing for a fitter to agree with —
and the two gates threw it out in 1.0 ms.

**Latency**: **min 1.0 ms, median 2.0 ms, max 9.7 ms** natively over those six
strokes. The 9.7 ms is the first inference after the session was built; everything
after it was 1.0–3.9 ms. Wall clock from JavaScript including the bridge hop was
1–13 ms. Upstream advertises "under 10 ms per stroke" and on this hardware the
steady-state figure was well inside it — which is also why this package reports
`processingSec` *and* the example app times the call separately: at this speed the
bridge is a visible fraction of the total, which is not true of any other model
here.

**Loading**: `[shapes] ready in 39232ms downloaded=true`. That number is honest
and also misleading, so it is worth writing down what it is not. It is a cold
first launch in which Emo, Ear, Uhm, Redact and Shapes were all downloading and
building Core ML sessions concurrently on a simulator; Emo (5 MB) came ready at
35.9 s and Redact (12 MB) at 39.8 s in the same window. It is not a measurement of
a 0.2 MB download, and **no isolated cold-load figure was measured**.

**Invariants asserted on device**, none of which encodes an expected answer —
which class a stroke produces is upstream's business and an answer key here would
turn a legitimate gate change into a red self-test on a working build:

- Every fitted coordinate finite; a `line` outline 2 points, a `rectangle` 4, a
  `triangle` 3; `semiMajor >= semiMinor`; a star's outline exactly
  `2 × pointCount` points alternating between its radii to within 1e-6.
- Every fit inside the stroke's own bounding box expanded by half — which catches
  a fit that landed somewhere else entirely without pretending to measure
  accuracy.
- `isClosed` agrees with the kind.
- **Determinism**: the same stroke twice gave byte-identical geometry. There is no
  sampling anywhere in this model, so anything else would be a session bug.
- **Invariance**, which is a claim upstream makes rather than an opinion of this
  file's: the same stroke translated by (+37, −11) and scaled ×1.7 came back the
  same class both times.
- An empty stroke and a one-point stroke both `null`, without loading the model.
- `minimumConfidence: 1` rejected everything, as arithmetic says it must.
- All five refusals raised `ERR_INVALID_ARGUMENT`: a `NaN` coordinate, an
  `Infinity` coordinate, and `minimumConfidence` of 95, −0.1 and `NaN`.

`[selftest] all prepared models passed`, with no new crash report in
`~/Library/Logs/DiagnosticReports`. The app did not go down during the session at
all; the known `ClearModule` (`Record.encode`) and `EmoModule`
(`JavaScriptValuesBuffer.deinit`) async-return crashes were not tripped, which is
worth noting only because they have been the background noise of the last three
rounds.

**The example app's own flow**, driven through the UI rather than the self-test:
tapping `circle` produced `ellipse` / `circle r 72.3 at (120.0, 102.0)` / native
7.7 ms / waited 47 ms, and tapping `scribble` produced `rejected` with the "nothing
fitted — which for this model is a result rather than a miss" note. The section
renders the stroke as grey ink dots with the fitted shape drawn over it in blue,
built from `outline` and one rotated `View` per segment, so the port is exercised
visually on every tap rather than only in the self-test.

**The canvas is a real drag surface** — a `View` with touch-responder handlers
collecting `locationX`/`locationY`, with the sample buttons beside it feeding the
identical call. A finger drag on the simulator was exercised and recognized:
`drawn · 2 points` → `line`, geometry `(66.0, 169.7) → (152.3, 151.0)`. But the
simulator's synthesized pan delivers a grant, one move and a release rather than a
continuous path, so **only a 2-point drag was verified through the gesture
surface**; the multi-point path is what the buttons exercise. A real finger on
real hardware was not tested, and neither was Android, which as with Gist and
Redact **has never been compiled** — there is no Android SDK on this machine.

No accuracy measurement of any kind was made. Six synthetic strokes is a smoke
test; upstream publishes no accuracy figure for this model and neither does this
repo. The 15° rotation snap was not directly observed either — every sample that
snapped landed on 0°, 72° or 90°, all already multiples of 15.

### Align, as far as a simulator can take it

The eleventh pod in the same app, and the first one whose central claim this repo
could **not** verify. Driven on an iPhone 17 Pro Max simulator running iOS 26.4.

What was verified:

```
[align] isSupported=true nativeCore=3.1.0 revision=main pinned=false
        repo=desert-ant-labs/align appleSpeech=false maxBuffered=30
[align] ready in 33345ms downloaded=true languages=de/en/es/fr/it/ja/ko/pt/zh
[align] refused an empty locale, 'english', an unrefined locale, and zero/NaN buffer windows
[align] transcription skipped — Apple's en-US recognizer is not installed (ERR_MODEL_UNAVAILABLE)
[selftest] all prepared models passed
```

- **The pod builds and links** into an app already carrying ten Desert Ant pods,
  with no duplicate symbols. `DESERT_ANT_PRODUCTS` gained `'Align'` and nothing
  else changed; no `_NumericsShims` include path was added, because
  `alignTargets` depends only on `DesertAnt`. That is the swift-numerics rule
  read off `Package.swift` and correctly *not* applied, which is the first time
  this repo has had the negative case.
- **The download works.** 672,560 bytes across 13 files, on disk under
  `…/desert-ant-models/desert-ant-labs/align/main/` — two `.mlmodelc` directories
  and three sidecars. The last path component is the branch name, which is as
  concrete an illustration of the pinning risk as one could ask for.
- **The nine languages come off the artifact**, not out of TypeScript: they are
  the keys of the `languages` map in the downloaded `refiner_config.json`, and
  they match the nine the product page advertises.
- **Every refusal fires before a native call**: empty locale, `'english'`,
  `'cy-GB'`, `maxBufferedSeconds: 0` and `maxBufferedSeconds: NaN`, all
  `ERR_INVALID_ARGUMENT`.
- **A missing recognizer is classified rather than guessed**: `transcribe` against
  a real 10.93 s speech file with a valid locale raised `ERR_MODEL_UNAVAILABLE`,
  not `ERR_INFERENCE_FAILED`.
- **No crash attributable to Align.** Two `EXC_BAD_ACCESS`es were seen across the
  session and both symbolicate to the same stack: `ClearMetrics.toObject` →
  `Record.encode` → `ClearModule._decorateModule` closure #6, on
  `com.apple.root.user-initiated-qos.cooperative`. That is the known pre-existing
  Clear async-return crash described above, tripped by the Clear leg of the same
  self-test, which runs after Align's. Of four self-test runs, two finished and
  two were taken down by it — which is a useful datum in its own right about the
  limit-4 race: it is roughly a coin flip on this hardware, not a rare event.
  Align's own async entry points return `Void` by construction and never appeared
  on a crashing stack.

**What was not verified is the model itself.** No transcript was ever refined, so
no latency, no word count and no boundary movement is quoted anywhere in this repo
for Align; upstream's 106.4 ms → 20.2 ms remains attributed to upstream.

The reason was diagnosed rather than assumed. On this simulator:

| probe | answer |
| --- | --- |
| `SpeechTranscriber.isAvailable` | **false** |
| `SpeechTranscriber.supportedLocale(equivalentTo: en-US)` | `en_US` — so the supported-locale check does *not* catch it |
| `AssetInventory.status(forModules:)` | **`.unsupported`** |
| `SpeechTranscriber.installedLocales` | **empty** |
| `assetInstallationRequest(supporting:)` after a successful `reserve` | throws `SFSpeechErrorDomain Code=1` |

Apple's on-device recognizer assets are device-only, and no physical device was
available. The SDK now checks `status` first and reports that case as a sentence
naming the simulator, rather than forwarding Apple's message about a download
status — which is the most this could be taken to.

Two real ordering bugs were found on the way to that answer, both invisible to a
compiler and both fixed: `assetInstallationRequest` must come **after**
`reserve`, and the locale reserved must be the one
`SpeechTranscriber.supportedLocale(equivalentTo:)` returns rather than the one the
caller passed.

The other half of the intended join *was* exercised on the same audio: Uhm found
six filler spans in the 10.93 s sample at `rtf=10x`, and `Uhm.reconcileWords` hit
all five of its rules. So the chain is one model short of end to end, and the
missing model is the one that needs hardware.

Also worth not over-reading: the 33.3 s and 33.7 s `load()` figures above are a
ceiling under contention. They were measured at app mount while six other models
downloaded and built Core ML sessions concurrently on a memory-pressured machine
— Uhm reported 57.0 s in the same window — and the second of them had
`downloaded=true`, so neither is a measure of a 0.7 MB download. No isolated load
figure was taken.

## Why not Nitro Modules

Nitro would work. It buys nothing here:

- **The overhead it removes is not on the critical path.** Nitro's published
  benchmark (434 ms vs 7 ms per 100k calls against "ExpoModules") predates 2.0,
  which Expo measured at 2.5–5.6× the old API. Either way this workload is *one
  async call per recording* wrapped around ~200 ms of model time. Call overhead
  is noise.
- **It does not solve the hard part.** The genuinely awkward problem is pulling
  an SPM-only, Xcode-26 Swift package into a React Native build. `spm_dependency`
  in the podspec handles that identically for either framework.
- **The case that would justify it does not exist.** Per-frame streaming
  callbacks would favour Nitro's zero-copy ArrayBuffers — but `Sources/Clear/Streaming.swift`
  in `desert-ant-core` has no public API, so there is nothing to stream.

Against that: a second native-module framework in the tree, its own codegen step,
and no `@Record`/`@SharedObject` to lean on.

## Deliberate platform differences

These are consequences of the upstream SDKs. They are documented in the
TypeScript types rather than papered over.

These are Clear's; Voz, Clips, Uhm and Align have no Android half to differ from.

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Clear.enhance()` takes no progress handler. |
| Audio decode/encode | AVFoundation, streaming | `MediaExtractor`/`MediaCodec` + a WAV and AAC writer in `AudioFiles.kt`, whole file in memory | The Kotlin SDK is samples-only, so this half is ours to write. |
| `variant: 'clear-natural'` | Supported | Throws `ERR_INVALID_ARGUMENT` | `Clear(context, directory)` is the entire Kotlin constructor; there is no variant to pass. |
| `warm()` | Downloads *and* builds the session | Downloads only | LiteRT session construction is lazy inside the first `enhance`. |
| Verified | Yes, on an iPhone 16 | No -- compiles only | No Android hardware was available. |

Ear's are Clear's shape, because the file API is Apple's alone:

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `identify({ uri })` | Upstream's own `AudioIO` | A decoder in this package | Kotlin `Ear` takes samples only; there is no file entry point to call. |
| `supportedLanguages()` | The 99 codes | `ERR_UNSUPPORTED_PLATFORM` | `ai.desertant:ear` publishes no reader for the `languages.json` sidecar. |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Ear.download()` takes no progress handler. |
| `isSupported` | Always true | False on an ABI LiteRT does not ship | The Core ML export has no device constraint; the LiteRT one has two ABIs. |
| `modelRevision` / `modelRepo` / `reliableMargin` | Read from the catalog and the SDK | Constants in the module | `ai.desertant:ear` publishes `Ear`, `Detection`, `LanguageCandidate` and `Options`, and nothing to read them from. |
| Verified | Yes, on a simulator | No -- compiles only | No Android hardware was available. |

Emo's are shorter, because the two SDKs are symmetric:

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Emo.download()` takes no progress handler. |
| `isSupported` | Always true | False on an ABI LiteRT does not ship | The Core ML export has no device constraint; the LiteRT one has two ABIs. |
| `modelRevision` / `modelRepo` | Read from the catalog | Constants in the module | `ai.desertant:emo` publishes `Emo`, `EmoSuggestion` and `EmojiSkinTone`, and nothing to read them from. |
| Verified | Yes, on a simulator | No -- compiles only | No Android hardware was available. |

Gist's is the shortest of the cross-platform ones, and the only table in this
document where the missing capability is a whole *model build*:

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `variant: 'english'` | Supported (~15 MB) | Throws `ERR_UNSUPPORTED_PLATFORM` | `Gist(context, directory)` is the entire Kotlin constructor; there is no variant to pass. `Gist.variants` reports the difference so a picker gates on the list, not the platform. |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Gist.download()` takes no progress handler. It matters more here than for Ear: ~74 MB, not ~9. |
| `isSupported` | Always true | False on an ABI LiteRT does not ship | The Core ML export has no device constraint; the LiteRT one has two ABIs. |
| `modelRevision` / `modelRepo` | Read from the catalog | Constants in the module | `ai.desertant:gist` publishes `Gist`, `Topic`, `GistException`, `PostTopics`, `ChannelTopic`, `RollupOptions` and `channelTopics`, and nothing to read them from. |
| `defaultTopK` | Mirrored | Mirrored | `topK: Int = 3` is a default argument in both signatures, so neither platform can read it. `variants`, `defaultVariant` and `defaultRollupOptions` *are* read. |
| Blank input | Empty tagging, no load | Empty tagging, no load | Kotlin's own guard; the Apple half was given the same one deliberately — upstream Swift would name a topic with nothing behind it. |
| Verified | Yes, on a simulator | **No — not even compiled**; no Android SDK on the machine | Every other package here at least builds on Android. |

Redact's is the only table here whose missing capability is cosmetic rather than
functional — and the only one where a *third* row is a refusal this package adds
that neither upstream SDK makes:

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `labelDisplayNames` | All 22 | `{}` | `Label.displayName` is a Swift computed property; `ai.desertant:redact`'s `Labels` is two sets of bare strings. `Redact.displayName` throws `ERR_UNSUPPORTED_PLATFORM` rather than title-casing a slug. |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Redact.download()` takes no progress handler. |
| `isSupported` | Always true | False on an ABI LiteRT does not ship | The Core ML export has no device constraint; the LiteRT one has two ABIs and a `libRedactAndroid.so` behind JNI. |
| Download size | ~12 MB (`redact.mlmodelc`) | ~25 MB (`redact.tflite`) | Two exports of one model at one revision. |
| `modelRevision` / `modelRepo` | Read from the catalog | Constants in the module | `ai.desertant:redact` publishes `Redact`, `Redaction`, `RedactionItem`, `Options`, `Labels` and `RedactException`, and nothing to read them from. |
| `defaultMinimumConfidence` | Mirrored | Mirrored | `0.6` is a default argument in a Swift initializer and a Kotlin data class, so neither platform can read it. `labels` and `defaultLabels` *are* read. |
| An unknown label name | `ERR_INVALID_ARGUMENT` | `ERR_INVALID_ARGUMENT` | Neither upstream SDK refuses; both silently drop it. Refusing on both is this package's decision, because a dropped label widens a redaction invisibly. |
| Blank input | Text unchanged, no load | Text unchanged, no load | Neither upstream SDK guards it. Same decision, taken on both halves together. |
| Verified | Yes, on a simulator | **No — not even compiled**; no Android SDK on the machine | Same position as Gist. |

Shapes' is the only table here with **no capability gap at all** — the two SDKs
expose the same recognizer with the same one option — so what is in it is the
platform machinery plus the one thing this package added on both halves:

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Shapes.download()` takes no progress handler. For a 1.3 MB download the difference is close to academic. |
| `isSupported` | Always true | False on an ABI LiteRT does not ship | The Core ML export has no device constraint; the LiteRT one has two ABIs and a `libShapesAndroid.so` behind JNI. |
| Download size | **0.2 MB** (`shapes.mlmodelc`) | 1.3 MB (`shapes.tflite`) | Two exports of one model at revision `v0.3.0`. The smallest pair in the family. |
| `modelRevision` / `modelRepo` | Read from the catalog | Constants in the module | `ai.desertant:shapes` publishes `Shapes`, `Shape`, `Point`, `Options` and `ShapesException`, and its `companion object` is empty. |
| `defaultMinimumConfidence` | Mirrored | Mirrored | `0` is a default argument in a Swift initializer and a Kotlin data class, so neither platform can read it. |
| `Shapes.kinds` | Not readable | Not readable | The only vocabulary in this repo neither SDK publishes: `ShapeKind` is `internal`, `Shape` has associated values, Kotlin's is a sealed class. Lives in TypeScript; an exhaustive Swift `switch` is what stops it going stale. |
| `outline` / `isClosed` | `Shape.outline`, `cgOutline`, `CGPath` | **Nothing** | Ported to TypeScript rather than bridged, because this is the rendering path and refusing it on Android would leave the package unable to draw its own output. The opposite call to `Redact.displayName`, deliberately. |
| An unknown shape class | Fails the **build** | `ERR_INFERENCE_FAILED` | A Swift `switch` over a public enum is exhaustive at compile time; a Kotlin sealed class from a Maven artifact is not. Upstream's own decoder answers `null` here; both halves of this package refuse instead, because `null` already means "rejected". |
| A non-finite coordinate | `ERR_INVALID_ARGUMENT` | `ERR_INVALID_ARGUMENT` | Neither upstream SDK refuses; the preprocessor drops the point and classifies what is left, producing `NaN` geometry. |
| `minimumConfidence` out of range | `ERR_INVALID_ARGUMENT` | `ERR_INVALID_ARGUMENT` | Upstream clamps `95` to `1.0` (rejects everything) and `NaN` to `0` (rejects nothing), silently. |
| Fewer than two points | `null`, no load | `null`, no load | Upstream's own answer on both platforms, not this package's. |
| Verified | Yes, on a simulator | **No — not even compiled**; no Android SDK on the machine | Same position as Gist and Redact. |

Tongue's table is the only one where the *Apple* column is the constrained one,
and the only one with no progress row at all -- it emits none:

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `isSupported` | **False today** | Always true | desert-ant-core v3.1.0 never exports its `Tongue` product; `ai.desertant:tongue` is published and binds normally. |
| ABI | n/a | **Every ABI** | Pure Kotlin. No NDK, no `.so`, and so no `abiFilters` block from the config plugin -- the only cross-platform model here without one. |
| `supportedScripts()` | The 32 names | `ERR_UNSUPPORTED_PLATFORM` | Swift's `Script` is a public `CaseIterable`; Kotlin's `Router` and `ScriptTables` are `internal`. `route.script` still works on both. |
| `maxCharacters` | `Normalizer.maxCharacters` | `Normalizer.MAX_CHARACTERS` | Public on both, so it is read rather than duplicated -- the one constant in this package that is symmetric. |
| `modelRevision` / `modelRepo` / `tieMargin` | Catalog, catalog, mirrored | Constants in the module | `ai.desertant:tongue` publishes `Tongue`, `Detection`, `Prediction`, `Route`, `Reliability` and `Verdict`, and nothing to read the first two from. `tieMargin` is written inline in `isTooCloseToCall` on *both* platforms, so neither can read it. |
| Progress | None | None | Nothing downloads and no entry point takes a handler. No `ModelPhase` was added for this model. |
| Verified | Module binds; no detection run | No -- compiles only | The product gap on one side, no Android hardware on the other. |

Align's table is the only one with **no Android column to fill**, so the axis is
the OS version instead -- which is the split that actually matters for this model:

| | iOS 26+ | iOS 17-25 | Android / web | Why |
| --- | --- | --- | --- | --- |
| The pod | Builds and links | **Builds and links** | Not built at all | Every Speech reference sits inside `@available(iOS 26, *)`, so the pod's own floor is the desert-ant-core package floor of 17. |
| `isSupported` | True | **False**, with a reason | False, module is `null` | `SpeechAnalyzer` is iOS 26 and the only public `refine` takes one of its results. The artifact itself would load on iOS 16. |
| `transcribe` | The whole model | `ERR_UNSUPPORTED_PLATFORM` | `ERR_UNSUPPORTED_PLATFORM` | Same reason. |
| The config plugin | Raises the app to 17 | Raises the app to 17 | Touches no `build.gradle` | Raising to 26 would take iOS 17-25 devices away from every other Desert Ant model installed beside it. |
| Downloads | Two: 0.7 MB + Apple's recognizer | n/a | n/a | Only the first is desert-ant-core's. `isDownloaded()` answers only the first. |
| Progress | `loadingModel`, `transcribing` | n/a | n/a | Both fractions are real -- the catalog's bytes, Apple's `Progress`, and `result.range.end / durationSec`. Refinement itself reports nothing because `refine` takes no handler. |
| Verified | **Binding and refusals only** | Not reachable to test | Not built | A simulator reports Apple's speech assets as `unsupported` and installs none, so no transcript was ever refined. See "Align, as far as a simulator can take it". |

## Constraints an app inherits

- **iOS 18.0 deployment target.** Above Expo's 16.4 default; the config plugin
  raises it. Drops iOS 16 and 17 devices.
- **Xcode 26 / Swift 6.2** on whatever builds the app, EAS included.
- **`arm64-v8a` + `x86_64` only**, for Clear, Emo, Ear, Gist and Redact. The config plugin
  narrows `abiFilters`; `Clear.isSupported` answers honestly if something slips
  through. Tongue imposes none of this and its plugin writes nothing, so an app
  that installs Tongue alone keeps every ABI.
- **Not Expo Go.** Dev build or bust.
- **One `desert-ant-core` bridge.** Adding a model package to an app is free;
  adding one to *this SDK* means naming its product in `DESERT_ANT_PRODUCTS` in
  `packages/core/ios/DesertAntCore.podspec`, and an app that installs one model
  links every listed model's Swift. The product has to *exist*: Tongue's does
  not, and naming a product the manifest does not export fails the build rather
  than the import.
- **Expo Modules 2.0 is experimental in SDK 57**, beta in 58. The macros are
  additive, so any function can fall back to the 1.0 DSL individually if an
  upgrade breaks it.
- **Licensing.** `LicenseRef-DAL-Source-Available-1.0` reaches the consuming app:
  free below 100k MAU per platform per model, attribution required, no training
  competing models. This wrapper redistributes no weights and no model code — it
  references SPM and Maven coordinates — but the terms still apply downstream.

## Version coupling

`DESERT_ANT_CORE_VERSION` in `packages/core/ios/DesertAntCore.podspec` — now
the only place the Swift package's version is named — the `ai.desertant:clear`,
`ai.desertant:emo`, `ai.desertant:ear`, `ai.desertant:gist`,
`ai.desertant:redact`, `ai.desertant:shapes` and
`ai.desertant:tongue` coordinates in the seven `android/build.gradle` files, and the
`coreVersion` constants in each model's Swift and Kotlin module files must move
together. The Apple and
Android native cores share an FFI payload schema (see the comments in Desert
Ant's own `Clear.kt`), so a mismatched pair is a wire bug that builds cleanly.

Tongue couples differently, and more tightly. Its two halves share no FFI, because
they share no native code: they are independent ports of a frozen specification,
kept honest upstream by golden vectors rather than by a wire format. A mismatched
pair there is not a wire bug — it is two models that quietly disagree about the
same three words, with nothing to fail. Upstream's `ModelCatalogTests` enforces
that `TongueModel.sdkVersion`, `packages/tongue-node/package.json` and
`packages/tongue-kotlin/build.gradle.kts` all say `3.1.0`; this repo's job is
simply not to pin a Maven coordinate the podspec does not name.

Gist adds one coupling of its own, and it is to a package neither half of this
repo owns. `Sources/Gist/Channel.swift` imports **`RealModule`** from
swift-numerics for `log` and `exp`, so that the roll-up compiles on Android and
wasm as well as Apple — and `RealModule` depends on `_NumericsShims`, a *clang*
target whose module map is a file in the SwiftPM checkout rather than something
Xcode regenerates into `GeneratedModuleMaps-<platform>/`. Gist is the first
product in `DESERT_ANT_PRODUCTS` with a transitive C module, and `import Gist`
therefore fails to compile its pod with `missing required module
'_NumericsShims'` until that checkout's `include` directory is on the pod's
`SWIFT_INCLUDE_PATHS` — Swift forwards `-I` to the clang importer, and clang finds
a `module.modulemap` by scanning its include paths. `packages/gist/ios/DesertAntGist.podspec`
carries the line and the reasoning. It names another package's source layout,
which is the part to dislike; it is also the narrowest fix available from a
podspec, which CocoaPods evaluates before the SPM package is resolved at all.

Redact inherits that same swift-numerics coupling and nothing new of its own.
`Sources/Redact/Model.swift` imports `RealModule` for `Double.exp` in the BIOES
softmax — two lines, for the same portability reason Gist has — and `Package.swift`
gives its target `.product(name: "RealModule", package: "swift-numerics")` exactly
as it gives Gist's. So `packages/redact/ios/DesertAntRedact.podspec` carries the
same `SWIFT_INCLUDE_PATHS` entry, and the failure without it is the identical
`missing required module '_NumericsShims'`. Worth stating as a rule rather than as
two incidents: **any desert-ant-core product that depends on swift-numerics needs
that line**, and the way to know before building is to read the `models` array in
`Package.swift` rather than to wait for the error.

Shapes inherits the same swift-numerics coupling, and it is the case that turns
the rule from a pattern into something you can read off the manifest before you
build. `Package.swift` carries a comment above its entry saying it outright:

```swift
// The geometric fitters and snapping replace `simd` (Apple-only) with a
// portable V2, so their transcendental math comes from swift-numerics.
.init(
    name: "Shapes",
    dependencies: [.product(name: "RealModule", package: "swift-numerics")]
),
```

`Sources/Shapes` then imports `RealModule` in `Geometry.swift`, `Shape.swift`,
`Fitter.swift` and `Snapping.swift` for `Double.cos`, `Double.sin` and
`Double.atan2`. So `packages/shapes/ios/DesertAntShapes.podspec` carries the same
`SWIFT_INCLUDE_PATHS` entry Gist's and Redact's do — written before the first
compile, from reading that array rather than from meeting the error — and the pod
built on the first attempt. Three products in, the rule is settled: **read the
`models` array in `Package.swift`; if the target names swift-numerics, the pod
needs the line.**

The Maven coordinate list grows with it: `ai.desertant:shapes:3.1.0` joins the
others in the `android/build.gradle` files that must move with
`DESERT_ANT_CORE_VERSION`. Shapes' FFI payload is a point count and `f64` x/y
pairs in, a present flag plus a kind tag and that kind's fields out — a wire
schema like the rest, so a mismatched pair is a wire bug that builds cleanly.

Align couples in two directions at once, and one of them is not to a version
number at all.

The first is ordinary: `DESERT_ANT_PRODUCTS` gains `'Align'`, and it is the one
entry in that list that reaches desert-ant-core's manifest through
`alignProducts` rather than `modelProducts` — being Apple-only, its target lives
outside the `models` array. The line to check before adding it is therefore a
different line than for Gist, Redact or Shapes: `products: products +
modelProducts + alignProducts + vozProducts`, which does include it. It adds no
Maven coordinate, because there is no Android half, and no `SWIFT_INCLUDE_PATHS`
entry, because `alignTargets` depends only on `DesertAnt` and pulls no C module.

The second has no version to pin, and that is the problem.
`Sources/Align/Catalog.swift` sets `revision = "main"` — a **branch** — with
upstream's own `// TODO: pin to a tagged revision once the align model repo is
tagged` above it. Every other model in the catalog names a `v`-prefixed tag, and
`Sources/Ear/Catalog.swift` says why in as many words: *"A branch means a push to
the Hub silently changes what already-shipped SDKs download, which is the kind of
change nobody is looking for when something starts behaving differently."*

So Align is the one model here where the coupling that matters cannot be checked
by reading two files. The weights an app downloads are whatever `main` pointed at
the moment it ran, and nothing in the version graph moves when they change — not
this package's version, not `DESERT_ANT_CORE_VERSION`, and not
`AlignedTranscript.modelRevision`, which reads `main` either way. On disk the
branch name is literally the cache directory: `…/desert-ant-labs/align/main/`.

Two things follow. `Align.revisionIsPinned` is computed from
`AlignModel.revision.hasPrefix("v")` rather than hardcoded, so it reports the
situation today and flips on its own the day upstream tags the repo; the example
app prints it on every launch and shows it in the UI. And an app that needs
reproducibility should resolve the weights once, ship that directory, and pass it
as `directory` to `load` so the download never runs — which is the same escape
hatch every model here has, used for a reason no other model has.

The other Tongue coupling is the one that is currently unsatisfiable:
`DESERT_ANT_PRODUCTS` in the same podspec must gain `'Tongue'` the moment
desert-ant-core exports the product, and not a release earlier — naming it before
then fails the build outright rather than degrading. `packages/tongue/ios` is
written against that future and compiles either way.
