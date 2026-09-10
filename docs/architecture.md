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

Views are also unsupported in 2.0 — irrelevant, Clear is headless.

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
3. Mixing a 1.0 `AsyncFunction` returning `NativeArrayBuffer` into the same
   module — supported, since `@ExpoModule` merges its synthesized definition into
   `definition()`. Rejected: it would be zero-copy on Apple and would have no
   Android counterpart, so the two platforms would diverge in exactly the place
   an app is most likely to be measuring.

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

| | iOS | Android | Why |
| --- | --- | --- | --- |
| `ProgressEvent.fraction` | A real fraction | `0` entering a phase, `1` leaving it | Kotlin `Clear.enhance()` takes no progress handler. |
| Audio decode/encode | AVFoundation, streaming | `MediaExtractor`/`MediaCodec` + a WAV and AAC writer in `AudioFiles.kt`, whole file in memory | The Kotlin SDK is samples-only, so this half is ours to write. |
| `variant: 'clear-natural'` | Supported | Throws `ERR_INVALID_ARGUMENT` | `Clear(context, directory)` is the entire Kotlin constructor; there is no variant to pass. |
| `warm()` | Downloads *and* builds the session | Downloads only | LiteRT session construction is lazy inside the first `enhance`. |

## Constraints an app inherits

- **iOS 18.0 deployment target.** Above Expo's 16.4 default; the config plugin
  raises it. Drops iOS 16 and 17 devices.
- **Xcode 26 / Swift 6.2** on whatever builds the app, EAS included.
- **`arm64-v8a` + `x86_64` only.** The config plugin narrows `abiFilters`;
  `Clear.isSupported` answers honestly if something slips through.
- **Not Expo Go.** Dev build or bust.
- **Expo Modules 2.0 is experimental in SDK 57**, beta in 58. The macros are
  additive, so any function can fall back to the 1.0 DSL individually if an
  upgrade breaks it.
- **Licensing.** `LicenseRef-DAL-Source-Available-1.0` reaches the consuming app:
  free below 100k MAU per platform per model, attribution required, no training
  competing models. This wrapper redistributes no weights and no model code — it
  references SPM and Maven coordinates — but the terms still apply downstream.

## Version coupling

`DESERT_ANT_CORE_VERSION` in `ios/DesertAntClear.podspec`, the
`ai.desertant:clear` coordinate in `android/build.gradle`, and
`NATIVE_CORE_VERSION` in both module files must move together. The Apple and
Android native cores share an FFI payload schema (see the comments in Desert
Ant's own `Clear.kt`), so a mismatched pair is a wire bug that builds cleanly.
