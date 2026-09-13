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

Limits 1 and 2 are compile-time and self-announcing. Limit 3 is not, and it cost
most of the debugging: the first fix appeared not to work because the phone was
locked, so `expo run:ios` silently kept running a stale build.

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

These are Clear's; Voz has no Android half to differ from.

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Clear.enhance()` takes no progress handler. |
| Audio decode/encode | AVFoundation, streaming | `MediaExtractor`/`MediaCodec` + a WAV and AAC writer in `AudioFiles.kt`, whole file in memory | The Kotlin SDK is samples-only, so this half is ours to write. |
| `variant: 'clear-natural'` | Supported | Throws `ERR_INVALID_ARGUMENT` | `Clear(context, directory)` is the entire Kotlin constructor; there is no variant to pass. |
| `warm()` | Downloads *and* builds the session | Downloads only | LiteRT session construction is lazy inside the first `enhance`. |
| Verified | Yes, on an iPhone 16 | No -- compiles only | No Android hardware was available. |

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
the only place the Swift package's version is named — the `ai.desertant:clear`
coordinate in `android/build.gradle`, and the `coreVersion` constants in each
model's Swift and Kotlin module files must move together. The Apple and
Android native cores share an FFI payload schema (see the comments in Desert
Ant's own `Clear.kt`), so a mismatched pair is a wire bug that builds cleanly.
