# Desert Ant Labs — React Native SDKs

React Native and Expo bindings for [Desert Ant Labs](https://github.com/Desert-Ant-Labs)'
on-device models. Desert Ant ships Swift, Kotlin and JavaScript/WebAssembly SDKs
from [`desert-ant-core`](https://github.com/Desert-Ant-Labs/desert-ant-core); this
repository is the React Native one they do not.

Four models so far, and they compose into one pipeline: **Clear** cleans a
recording up — denoise, dereverb, loudness-normalize — **Voz** reads it back as a
transcript with word-level timestamps, **Clips** picks the moments worth cutting,
and **Uhm** finds every "um" in the same audio without reading a word of it.
Entirely offline.

```ts
import { Clear } from '@desert-ant-labs/react-native-clear';
import { Voz } from '@desert-ant-labs/react-native-voz';
import { Clips } from '@desert-ant-labs/react-native-clips';
import { Uhm } from '@desert-ant-labs/react-native-uhm';

const { uri } = await (await Clear.load()).enhance({ uri: recording.uri });
const { words } = await (await Voz.load()).transcribe({ uri });

const clips = await Clips.load();
const moments = await clips.find({ sentences: Clips.toSentences(words) });
// moments[0].ranges -> [{ start: 32.1, end: 41.4 }]

const { fillers } = await (await Uhm.load()).analyze({ uri });
// fillers[0] -> { type: 'um', start: 4.21, end: 4.47, confidence: 0.88 }
const clean = Uhm.reconcileWords(words, fillers);  // word spans that miss the ums
```

Uhm is the one that does not sit in the chain: it reads the waveform, so it runs
on the same file the others do but waits for none of them. What it wants a
transcript *for* is `reconcileWords`, which trims the word spans around the
fillers so a cut lands on silence rather than through a word.

## Packages

| Package | What it is |
| --- | --- |
| [`@desert-ant-labs/react-native-clear`](packages/clear) | The Clear model: file in, enhanced file out. iOS + Android. |
| [`@desert-ant-labs/react-native-voz`](packages/voz) | The Voz model: file in, transcript with word timings out. **iOS only.** |
| [`@desert-ant-labs/react-native-clips`](packages/clips) | The Clips model: transcript in, ranked highlights with playable spans out. **iOS 18+ only.** |
| [`@desert-ant-labs/react-native-uhm`](packages/uhm) | The Uhm model: audio in, frame-precise filler-word spans out. No transcript needed. **iOS only.** |
| [`@desert-ant-labs/react-native-core`](packages/core) | Types, error codes and lifecycle contracts shared by every model SDK here — and the single native bridge to the `desert-ant-core` Swift package. |
| [`apps/example`](apps/example) | Record → enhance → transcribe → rank highlights → find the fillers, on a dev build. |

## How it is built

The native work is **not** a reimplementation. Each package is a thin Expo module
over Desert Ant's own platform SDKs:

- **iOS** links the `Clear`, `Voz`, `Clips` and `Uhm` products of the `desert-ant-core`
  Swift package, pulled in through React Native's `spm_dependency` bridge — that
  package ships as SPM only, with no podspec and no XCFramework. The bridge is
  declared exactly once, by the `DesertAntCore` pod, because two pods each
  linking the same package duplicates its thirteen shared objects and fails to
  link; see [`packages/core`](packages/core#the-desertantcore-pod).
- **Android** depends on `ai.desertant:clear` from Maven Central, which brings
  LiteRT and the shared native core with it. Only Clear has an Android half:
  **Voz** drives Core ML directly and upstream ships no artifact for it at all,
  **Clips** has LiteRT files declared but no published Android package to bind to
  yet, and **Uhm** has neither half — no LiteRT export of the detector, and a type
  labeller that is a SoundAnalysis classifier and so Apple-only by construction.

The Apple half is written against the **Expo Modules 2.0** macros (`@ExpoModule`,
`@JS`, `@SharedObject`, `@Record`, `@Event`), which ship for Swift in
`expo-modules-core` 57. The Android half is the classic Kotlin DSL, because 2.0
has no Kotlin implementation yet. Both answer to the same TypeScript surface.

[`docs/architecture.md`](docs/architecture.md) is the long version: why Expo
Modules rather than Nitro, what the buffer-marshaling constraint is and how it is
resolved, which platform differences are real, and the three Expo Modules 2.0
limits that only showed up against a real toolchain and a real phone.

**Status:** Clear is verified end to end on iOS on an iPhone 16 (iOS 26.3.1).
Clips is verified end to end on a simulator — it downloads, loads, and returns
ranked non-overlapping clips with playable spans from a real transcript. Uhm is
verified end to end on a simulator too: it downloads, loads, and finds six
filler spans in eleven seconds of real speech, with the type labeller and
`reconcileWords` both exercised. Voz binds and reports correctly but its
transcription has not been run; that needs ~490 MB of weights and a Neural
Engine, which a simulator does not have. Android compiles but has not been run —
no device was available. Each package's README says exactly what was and was not
exercised.

## Requirements

| | |
| --- | --- |
| Expo SDK | 57+ (`expo-modules-core` 57 is where the 2.0 macros live) |
| React Native | 0.75+ for `spm_dependency`; 0.83 in the example |
| iOS | **18.0+** with Clear or Clips (their Core ML artifacts' floors); 17.0+ for Voz or Uhm alone |
| Xcode | 26 (`desert-ant-core` is `swift-tools-version: 6.2`) |
| Android | API 24+, `arm64-v8a` and `x86_64` only |
| Expo Go | Not supported — these are native modules, so use a dev build |

Each package's bundled config plugin raises the iOS deployment target — and
Clear's also narrows the Android ABIs — so add whichever packages you use to
`plugins` in your app config. The plugins only ever raise, so they compose.

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
