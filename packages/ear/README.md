# @desert-ant-labs/react-native-ear

On-device spoken language identification for React Native and Expo: which of 99
languages a recording is in, in about a quarter of a second, before anything
transcribes it. Nothing leaves the device.

Wraps Desert Ant Labs' own [Ear](https://desertant.com/models/ear/) Swift and
Kotlin SDKs as an Expo module.

**iOS and Android.** Ear is the third model in this repo with both halves, after
Clear and Emo: upstream publishes a Core ML export *and* a LiteRT one, and
`ai.desertant:ear` is on Maven Central. Voz, Clips and Uhm are Apple-only because
upstream ships nothing else for them; this one is not.

## Install

```bash
npx expo install @desert-ant-labs/react-native-ear
```

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-ear"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios   # or run:android
```

The plugin raises the iOS deployment target to 17.0 — tied with Emo and Uhm for
the lowest floor of any model here — and narrows the Android ABIs to
`arm64-v8a` and `x86_64`, which are the two LiteRT ships. Both only ever raise or
narrow, so they compose with the other Desert Ant plugins; pass
`restrictAbis: false` to keep your own ABI list.

## Use

```ts
import { Ear } from '@desert-ant-labs/react-native-ear';

const ear = await Ear.load();

const heard = await ear.identify({ uri: recording.uri });
// { language: 'pt', confidence: 0.91, isReliable: true, candidates: [...], windows: 3 }

if (heard.isReliable) {
  route(heard.language);
} else {
  ask();                 // the answer is a bet, not a fact
}

ear.release();
```

### Branch on `isReliable`, not on `confidence`

This is the one thing to get right, and the two tests disagree exactly where it
matters.

`isReliable` is false for two different reasons:

1. **The margin.** The top two candidates are within `Ear.reliableMargin` (0.25)
   of each other, so the answer is a choice between them rather than a reading.
2. **The Nordic three.** The answer is `no`, `sv` or `da`. The detector reads
   Norwegian as Swedish in roughly 40% of clips and is *confident* when it does —
   the error is confident rather than uncertain, so the probability does not
   reveal it and no threshold can catch it.

That second case is why a confidence threshold is not a substitute. A high
`confidence` with `isReliable === false` is not a contradiction; it is the flag
doing the thing it exists for.

```ts
const nordic = heard.language !== null && Ear.confusableLanguages.includes(heard.language);
```

Nothing is hidden when it is false — `language` still holds the detector's
answer. The flag says that acting on it unattended is a bet.

`isReliable` is decided natively on both platforms. Three SDKs reimplementing a
calibrated rule would be three chances to differ.

### Routing to a transcriber

This is what the model is for, and it pairs with Voz in this repo:

```ts
const heard = await ear.identify({ uri });
if (heard.isReliable && Voz.supportedLanguages.includes(heard.language!)) {
  const { words } = await voz.transcribe({ uri });
}
```

Voz does **not** detect what it is hearing. Audio in a language outside its 25
comes back as fluent, confident nonsense rather than as an error or a low score,
so the only way to catch it is to ask a model whose job is asking. Ear names all
25 of Voz's languages, so the comparison is always meaningful.

### How much to listen to

```ts
await ear.identify({ uri, windows: 6 });
```

Windows are thirty seconds each, chosen by how speech-like they sound and spread
across the recording rather than taken from the front — the opening of a file is
titles and music. A recording shorter than one window uses one.

Raising it buys less than it looks like it should. Desert Ant measured one window
and six windows misrouting the same 11 files out of 162: a recording is one
speaker in one room, so when the detector is wrong it is wrong in *every* window
of that file. The errors are unanimous, not independent, and there is nothing for
an average to cancel. Three is the default because it costs ~45 ms in total and
covers the one case a single window cannot — a file whose opening is music.

### Samples you already hold

```ts
await ear.identifySamples(float32Samples, 44_100);
```

Prefer `identify` for anything that is, or could be, a file: samples cross into
native memory by copy (~3.8 MB per minute at 16 kHz, more before resampling),
while a file never crosses the JavaScript boundary at all.

## API

| | |
| --- | --- |
| `Ear.isSupported` | True on iOS and on Android with a LiteRT ABI. |
| `Ear.unsupportedReason` | Why, in a sentence, or null. On Android it names the device's ABIs. |
| `Ear.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Ear.modelRevision` | The pinned model revision, or null. |
| `Ear.modelRepo` | The Hub repo the weights come from, or null. |
| `Ear.defaultWindows` | How many windows `identify` listens to untold. `3`. |
| `Ear.reliableMargin` | The gap `isReliable` requires. `0.25`. |
| `Ear.confusableLanguages` | `['no', 'sv', 'da']` — always unreliable. |
| `Ear.load(options?)` | Create, download and prepare. |
| `Ear.create(options?)` | Create without touching the network. |
| `ear.isDownloaded()` | Whether `identify` can run offline. Synchronous. |
| `ear.warm(onProgress?)` | Download and build the session. |
| `ear.download(onProgress?)` | The same call — see below. |
| `ear.identify({ uri, windows?, onProgress? })` | A file in, a `Detection` out. |
| `ear.identifySamples(samples, sampleRate?, options?)` | Mono floats in, a `Detection` out. |
| `ear.supportedLanguages()` | The 99 codes. **iOS only** — see below. |
| `ear.release()` | Hand the model back. |

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_AUDIO_DECODE_FAILED`, `ERR_INVALID_ARGUMENT`,
`ERR_RELEASED`, `ERR_UNSUPPORTED_PLATFORM`.

## Things the types cannot tell you

- **`identify` reports no progress.** Upstream's `identify` takes no progress
  handler on either platform, so the only phase an Ear ever emits is
  `loadingModel`. At ~250 ms there is nothing a bar could usefully show, and
  inventing a fraction would mean making one up.
- **`warm` and `download` are the same call.** Upstream exposes one entry point
  that downloads *and* builds the session, so unlike Clear and Voz there is no
  download-only step. Both names exist so the six models read alike.
- **~9 MB.** Second-smallest here after Emo's 5 — Uhm is 45 MB, Clips 288, Voz
  490 — so loading on mount is reasonable, and it has to be: Ear is the step that
  runs *before* the transcriber.
- **Three codes are rewritten on the way out.** The detector's label space and
  the codes an app routes on are not the same vocabulary: `tl` → `fil`, `nb` →
  `no`, and `yue` is folded into `zh`. Upstream does this, not this package.
- **`windows` is what was heard, not what was asked.** A recording shorter than
  one window comes back with `windows: 1` however many you requested.
- **`supportedLanguages()` is iOS-only.** It reads the `languages.json` sidecar
  through the loaded model, and `ai.desertant:ear` publishes no reader for it —
  the Kotlin SDK's whole surface is `Ear`, `Detection`, `LanguageCandidate` and
  `Options`. Android raises `ERR_UNSUPPORTED_PLATFORM` rather than returning a
  list this package hardcoded, which would be right until the next model revision
  and then quietly wrong with no way for a caller to tell.
- **No `computeUnits` knob**, unlike Uhm. Upstream's `Ear.init` takes `directory`
  alone.
- **Android decodes files in this package.** The Kotlin SDK takes samples only,
  so `identify({ uri })` is backed by a `MediaCodec`/WAV decoder here — which
  means the whole decoded file is resident while it runs. Fine for a recording,
  not for a two-hour podcast. The Apple path uses upstream's own `AudioIO`.
- **Android reports progress as phase boundaries, not fractions.**
  `ai.desertant:ear`'s `download()` takes no callback, so it emits 0 on entering
  `loadingModel` and 1 on leaving. It matters less here than for Clear: the
  download is ~9 MB, not ~490.
- **Speech under loud music is about 60% accurate**, per upstream. `isReliable`
  is the guard for it rather than a reason to avoid the case.

## Verified

Driven on an iOS 26.4 simulator (iPhone 17 Pro Max) with a dev build, alongside
Clear, Voz, Clips, Uhm and Emo.

The module binds and reports, before anything touches a model:

```
[ear] isSupported=true nativeCore=3.1.0 revision=v0.1.0 repo=desert-ant-labs/ear
      windows=3 margin=0.25 confusable=no/sv/da
```

which exercises the `@ExpoModule` registration, every `@JS` property,
`createModel` returning a `@SharedObject`, its synchronous `isDownloaded()`, and
`release()`.

The ~9 MB download completes and builds a Core ML session in **7.2–7.6 s cold**
and **~6.9 s warm**. `supportedLanguages()` returns **99 unique codes**, and
every one of Voz's 25 is among them.

**Identification is correct on real speech, in six languages and four scripts.**
Half a minute of speech each — one full window, so the detector is answering with
its real context rather than from padding:

| Sample | Answer | Confidence | Reliable | Runner-up |
| --- | --- | --- | --- | --- |
| `en` | **en** | 0.998 | yes | nn 0.000 |
| `es` | **es** | 0.997 | yes | en 0.001 |
| `pt` | **pt** | 0.996 | yes | es 0.002 |
| `fr` | **fr** | 0.997 | yes | en 0.002 |
| `de` | **de** | 0.998 | yes | en 0.001 |
| `ja` | **ja** | 0.986 | yes | en 0.005 |

Six of six, every one above 0.98 and every one marked reliable. The margins are
enormous — the runner-up is at most 0.005 — which is what a model that is sure
looks like, and worth contrasting with the synthetic case below.

Reproduce the fixtures on a Mac:

```bash
say -v Paulina -o es.aiff "<about 30 seconds of Spanish>"
afconvert -f WAVE -d LEI16@16000 -c 1 es.aiff ear-es.wav
```

then drop `ear-<code>.wav` into the example app's cache and run its self-test.

**The synthetic case behaves correctly too**, and is the more interesting one: a
200 Hz tone under hiss is not speech in any language, and the model says so
through the flag rather than through an error —

```
en at 0.360, ja 0.192, ko 0.077, ru 0.044 — isReliable=false
```

a 0.17 margin, under the 0.25 the rule requires. A confidence threshold at, say,
0.3 would have accepted it.

Also exercised: `identifySamples` with a native 48 kHz → 16 kHz resample; the
"fewer windows on short audio" rule (`windows: 1` and the default both listen to
one window on two seconds of audio); `windows` of 0, -1 and 1.5 all rejected with
`ERR_INVALID_ARGUMENT` before reaching native; and a missing file reported as
`ERR_AUDIO_DECODE_FAILED` rather than as an inference failure.

**Latency is ~5.5 s per identification on the simulator** and should not be read
as the model's speed. A simulator has no Neural Engine, so this is the CPU path;
upstream measures ~250 ms on device. The number is stable across every call
above, including the two-second synthetic clip, which is consistent with a fixed
encoder cost rather than one that scales with the audio.

**Android has not been compiled**, let alone run. The machine this was developed
on has no Android SDK — `ANDROID_HOME` points at a directory that does not exist,
and there is no `sdkmanager` or `gradle`. An earlier version of this file claimed
it compiled; that was never verified, and saying so is more useful than repeating
it. The Kotlin half is written against the same DSL as Clear's and Emo's, and it
is the first thing to check before trusting this package on Android.

### One crash found and fixed, and one found and not

Getting here turned up a real defect in Expo Modules 2.0, and the fix is why
`supportedLanguages()` is shaped the way it is.

**A `@JS async` function returning `[String]` encodes its result off the
JavaScript thread**, and segfaults:

```
Thread: com.apple.root.user-initiated-qos.cooperative
  hermesvm            createStringFromUtf8(...)
  ExpoModulesJSI      static Array<A>.encode(_:in:)
  DesertAntExample    closure #5 in EarModule._decorateModule(object:in:)
```

`@JavaScriptActor` on the function does not prevent it — the return value is
encoded after the actor hop the annotation governs. It is a race, so it survived
a first call and a second and then took the process down; worse, the damage it
does to the Hermes runtime surfaces later and elsewhere, so the first symptom was
a crash inside an unrelated progress event.

The fix is the split you can see in the API: the async half returns `Void`, and
the array comes back through a **synchronous** member, which runs on the
JavaScript thread by construction. Uhm and Emo never hit this because nothing
they return asynchronously is an array of a bare primitive — their results are
`@Record`s, which encode through `toObject` instead.

The same run then found **the same defect in Clear**, which this package does not
fix:

```
Thread: com.apple.root.user-initiated-qos.cooperative
  ExpoModulesCore     static Record.encode(_:in:)
  DesertAntExample    closure #6 in ClearModule._decorateModule(object:in:)
```

Clear's in-memory path was already documented as unreliable on this simulator;
what is new is the reason. It is a `Record` rather than an `[String]`, so the
"arrays of primitives only" reading of the first crash is too narrow — the
general statement is that an async return can be encoded off the JavaScript
thread. See `docs/architecture.md`.
