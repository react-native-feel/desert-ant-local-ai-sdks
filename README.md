# Desert Ant Labs — React Native SDKs

React Native and Expo bindings for [Desert Ant Labs](https://github.com/Desert-Ant-Labs)'
on-device models. Desert Ant ships Swift, Kotlin and JavaScript/WebAssembly SDKs
from [`desert-ant-core`](https://github.com/Desert-Ant-Labs/desert-ant-core); this
repository is the React Native one they do not.

Seven models so far. Five of them compose into one pipeline: **Clear** cleans a
recording up — denoise, dereverb, loudness-normalize — **Ear** names the language
it is in, **Voz** reads it back as a transcript with word-level timestamps,
**Clips** picks the moments worth cutting, and **Uhm** finds every "um" in the
same audio without reading a word of it. The other two read text rather than
audio: **Emo** takes a phrase and gives back the emoji that fit it, and
**Tongue** takes three words and names the language they are in — the same
question Ear answers, from the other kind of evidence. Entirely offline.

```ts
import { Clear } from '@desert-ant-labs/react-native-clear';
import { Voz } from '@desert-ant-labs/react-native-voz';
import { Clips } from '@desert-ant-labs/react-native-clips';
import { Uhm } from '@desert-ant-labs/react-native-uhm';
import { Emo } from '@desert-ant-labs/react-native-emo';
import { Ear } from '@desert-ant-labs/react-native-ear';
import { Tongue } from '@desert-ant-labs/react-native-tongue';

const { uri } = await (await Clear.load()).enhance({ uri: recording.uri });

const heard = await (await Ear.load()).identify({ uri });
// heard -> { language: 'pt', confidence: 0.99, isReliable: true, ... }

const { words } = await (await Voz.load()).transcribe({ uri });

const clips = await Clips.load();
const moments = await clips.find({ sentences: Clips.toSentences(words) });
// moments[0].ranges -> [{ start: 32.1, end: 41.4 }]

const { fillers } = await (await Uhm.load()).analyze({ uri });
// fillers[0] -> { type: 'um', start: 4.21, end: 4.47, confidence: 0.88 }
const clean = Uhm.reconcileWords(words, fillers);  // word spans that miss the ums

const emoji = await (await Emo.load()).suggest('Pay my bills');
// emoji[0] -> { emoji: '💰', confidence: 0.62 }

const tongue = await Tongue.load();
tongue.detectSync(transcript.text).language;   // "pt" — the same answer as Ear,
                                               // from the words rather than the sound
```

Ear sits ahead of Voz rather than beside it, and that is the point of it: Voz does
not detect what it is hearing, so audio outside its 25 languages comes back as
confident nonsense rather than as an error. `isReliable` is the field to branch
on — it is false both when the top two candidates are too close *and* for
Norwegian, Swedish and Danish, which the detector confuses with each other
confidently, where no confidence threshold could catch it.

Uhm is the one that does not sit in the chain: it reads the waveform, so it runs
on the same file the others do but waits for none of them. What it wants a
transcript *for* is `reconcileWords`, which trims the word spans around the
fillers so a cut lands on silence rather than through a word.

Emo is not in the chain either, and not in the medium: it takes text. It is here
because it is the same lifecycle — create, load, call, release — over a model
that shares nothing else with the other four, and because at ~5 MB and ~2 ms it
is the one you can call on every keystroke.

Tongue is Ear's sibling across that divide: same question, different evidence.
Ear listens to ninety seconds of a recording; Tongue reads three words. Asking
both about one recording — Ear from the waveform, Tongue from the transcript — is
two independent models on one piece of content, and where they disagree the
disagreement is the useful output: a transcriber out of its depth produces text
that *looks* like a language it is not. It is also the odd one out mechanically.
Nothing about it downloads — the whole model is 2 MB of int8 inside the package —
and at tens of microseconds it is the only model here whose inference is
synchronous, which is why `detectSync` exists and why a text field needs no
debounce behind it.

## Packages

| Package | What it is |
| --- | --- |
| [`@desert-ant-labs/react-native-clear`](packages/clear) | The Clear model: file in, enhanced file out. iOS + Android. |
| [`@desert-ant-labs/react-native-voz`](packages/voz) | The Voz model: file in, transcript with word timings out. **iOS only.** |
| [`@desert-ant-labs/react-native-clips`](packages/clips) | The Clips model: transcript in, ranked highlights with playable spans out. **iOS 18+ only.** |
| [`@desert-ant-labs/react-native-uhm`](packages/uhm) | The Uhm model: audio in, frame-precise filler-word spans out. No transcript needed. **iOS only.** |
| [`@desert-ant-labs/react-native-ear`](packages/ear) | The Ear model: audio in, the language it is spoken in out, across 99. iOS + Android. |
| [`@desert-ant-labs/react-native-emo`](packages/emo) | The Emo model: short text in, ranked emoji with confidences out, 22 languages. iOS + Android. |
| [`@desert-ant-labs/react-native-tongue`](packages/tongue) | The Tongue model: three words in, the language they are in out, across 84. 2 MB bundled, nothing downloaded. **Android; the Apple half is written and blocked on an upstream product export.** |
| [`@desert-ant-labs/react-native-core`](packages/core) | Types, error codes and lifecycle contracts shared by every model SDK here — and the single native bridge to the `desert-ant-core` Swift package. |
| [`apps/example`](apps/example) | Record → enhance → identify the language → transcribe → rank highlights → find the fillers, plus a text field each for Emo and Tongue, on a dev build. |

## How it is built

The native work is **not** a reimplementation. Each package is a thin Expo module
over Desert Ant's own platform SDKs:

- **iOS** links the `Clear`, `Voz`, `Clips`, `Uhm`, `Emo` and `Ear` products of the `desert-ant-core`
  Swift package, pulled in through React Native's `spm_dependency` bridge — that
  package ships as SPM only, with no podspec and no XCFramework. The bridge is
  declared exactly once, by the `DesertAntCore` pod, because two pods each
  linking the same package duplicates its thirteen shared objects and fails to
  link; see [`packages/core`](packages/core#the-desertantcore-pod). **Tongue is
  the one model not in that list**, and not by choice: desert-ant-core v3.1.0
  declares a `Tongue` product and never adds it to the manifest's `products:`
  array, so naming it fails the build rather than the import. Its Apple sources
  are written and guarded by `#if canImport(Tongue)`.
- **Android** depends on `ai.desertant:clear`, `ai.desertant:emo` and
  `ai.desertant:ear` from Maven Central, which bring LiteRT and the shared native
  core with them, and on `ai.desertant:tongue`, which brings **nothing** — it is a
  pure-Kotlin port of the same frozen specification the Swift target implements,
  with no NDK and no `.so`, so it is the only model here with no ABI constraint on
  Android. Those four are the only models with an Android half: **Voz**
  drives Core ML directly and
  upstream ships no artifact for it at all, **Clips** has LiteRT files declared
  but no published Android package to bind to yet, and **Uhm** has neither half —
  no LiteRT export of the detector, and a type labeller that is a SoundAnalysis
  classifier and so Apple-only by construction.

The Apple half is written against the **Expo Modules 2.0** macros (`@ExpoModule`,
`@JS`, `@SharedObject`, `@Record`, `@Event`), which ship for Swift in
`expo-modules-core` 57. The Android half is the classic Kotlin DSL, because 2.0
has no Kotlin implementation yet. Both answer to the same TypeScript surface.

[`docs/architecture.md`](docs/architecture.md) is the long version: why Expo
Modules rather than Nitro, what the buffer-marshaling constraint is and how it is
resolved, which platform differences are real, and the four Expo Modules 2.0
limits that only showed up against a real toolchain and a real phone.

**Status:** Clear is verified end to end on iOS on an iPhone 16 (iOS 26.3.1).
Clips is verified end to end on a simulator — it downloads, loads, and returns
ranked non-overlapping clips with playable spans from a real transcript. Uhm is
verified end to end on a simulator too: it downloads, loads, and finds six
filler spans in eleven seconds of real speech, with the type labeller and
`reconcileWords` both exercised — and the example app's own record, clean and
detect flow returns them through the UI. Voz binds and reports correctly but its
transcription has not been run; that needs ~490 MB of weights and a Neural
Engine, which a simulator does not have. Ear is verified end to end on a simulator:
it downloads, loads, names all 99 languages it knows, and identifies six
half-minute recordings — English, Spanish, Portuguese, French, German and
Japanese — correctly, every one above 0.98 and every one marked reliable. Emo is
verified end to end on a simulator too: it
downloads, loads in 7.6 s, and answers "Pay my bills" with 💰 at 0.64 in 5–16 ms
— and the same phrase in Spanish and Japanese ranks 💰 first as well, which is
the multilingual claim rather than a keyword table. Its skin-tone path is
exercised and the ranking is unchanged by it, as documented. Tongue is the one
model here that has **not** been run at all: its Apple half cannot be linked
until desert-ant-core exports its `Tongue` SwiftPM product, and no Android device
was available for the half that does bind. What is verified is that the seventh
pod builds and links into an app that already carries six, that the module
registers and every `@JS` property reads, and that the refusal reaches JavaScript
as a sentence naming the cause — the example app's self-test still ends with all
prepared models passing. Android compiles but
has not been run — no device was available. Each package's
README says exactly what was and was not exercised.

## Requirements

| | |
| --- | --- |
| Expo SDK | 57+ (`expo-modules-core` 57 is where the 2.0 macros live) |
| React Native | 0.75+ for `spm_dependency`; 0.83 in the example |
| iOS | **18.0+** with Clear or Clips (their Core ML artifacts' floors); 17.0+ for Voz, Uhm, Emo, Ear or Tongue alone |
| Xcode | 26 (`desert-ant-core` is `swift-tools-version: 6.2`) |
| Android | API 24+; `arm64-v8a` and `x86_64` only for Clear, Emo and Ear — Tongue needs no native library and runs on any ABI |
| Expo Go | Not supported — these are native modules, so use a dev build |

Each package's bundled config plugin raises the iOS deployment target — and
Clear's, Emo's and Ear's also narrow the Android ABIs to the two LiteRT ships — so add
whichever packages you use to `plugins` in your app config. The plugins only ever
raise, and the three that touch `build.gradle` defer to each other's block, so they
compose. Tongue's touches `build.gradle` not at all, deliberately: it has no
native library, so narrowing an app's ABIs on its behalf would take away devices
it can serve.

## Develop

```bash
npm install
npm run build          # every package, including the config plugins
npm test               # the pure-TypeScript surface

cd apps/example
npx expo prebuild --clean
npx expo run:ios       # or run:android — a dev build, not Expo Go
```

## License

This wrapper is MIT. The models it loads are not: they ship under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0)
— free below 100,000 monthly active devices per platform per model, attribution
required in your app, and no using the models or their outputs to train a
competing on-device model. Those terms reach your app whichever SDK you use.
