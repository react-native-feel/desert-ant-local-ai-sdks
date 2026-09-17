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
   returned 99 strings. Clear had it all along.

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

These are Clear's; Voz, Clips and Uhm have no Android half to differ from.

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

## Constraints an app inherits

- **iOS 18.0 deployment target.** Above Expo's 16.4 default; the config plugin
  raises it. Drops iOS 16 and 17 devices.
- **Xcode 26 / Swift 6.2** on whatever builds the app, EAS included.
- **`arm64-v8a` + `x86_64` only.** The config plugin narrows `abiFilters`;
  `Clear.isSupported` answers honestly if something slips through.
- **Not Expo Go.** Dev build or bust.
- **One `desert-ant-core` bridge.** Adding a model package to an app is free;
  adding one to *this SDK* means naming its product in `DESERT_ANT_PRODUCTS` in
  `packages/core/ios/DesertAntCore.podspec`, and an app that installs one model
  links every listed model's Swift.
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
`ai.desertant:emo` and `ai.desertant:ear` coordinates in the three
`android/build.gradle` files, and the
`coreVersion` constants in each model's Swift and Kotlin module files must move
together. The Apple and
Android native cores share an FFI payload schema (see the comments in Desert
Ant's own `Clear.kt`), so a mismatched pair is a wire bug that builds cleanly.
