# Desert Ant Labs — React Native SDKs

React Native and Expo bindings for [Desert Ant Labs](https://github.com/Desert-Ant-Labs)'
on-device models. Desert Ant ships Swift, Kotlin and JavaScript/WebAssembly SDKs
from [`desert-ant-core`](https://github.com/Desert-Ant-Labs/desert-ant-core); this
repository is the React Native one they do not.

Two models so far, and they compose: **Clear** cleans a recording up — denoise,
dereverb, loudness-normalize — and **Voz** reads it back as a transcript with
word-level timestamps. Both entirely offline.

```ts
import { Clear } from '@desert-ant-labs/react-native-clear';
import { Voz } from '@desert-ant-labs/react-native-voz';

const clear = await Clear.load();
const { uri } = await clear.enhance({ uri: recording.uri });

const voz = await Voz.load();
const { text, words } = await voz.transcribe({ uri });
```

## Packages

| Package | What it is |
| --- | --- |
| [`@desert-ant-labs/react-native-clear`](packages/clear) | The Clear model: file in, enhanced file out. iOS + Android. |
| [`@desert-ant-labs/react-native-voz`](packages/voz) | The Voz model: file in, transcript with word timings out. **iOS only.** |
| [`@desert-ant-labs/react-native-core`](packages/core) | Types, error codes and lifecycle contracts shared by every model SDK here — and the single native bridge to the `desert-ant-core` Swift package. |
| [`apps/example`](apps/example) | Record → enhance → transcribe → A/B playback, on a dev build. |

## How it is built

The native work is **not** a reimplementation. Each package is a thin Expo module
over Desert Ant's own platform SDKs:

- **iOS** links the `Clear` and `Voz` products of the `desert-ant-core` Swift
  package, pulled in through React Native's `spm_dependency` bridge — that
  package ships as SPM only, with no podspec and no XCFramework. The bridge is
  declared exactly once, by the `DesertAntCore` pod, because two pods each
  linking the same package duplicates its thirteen shared objects and fails to
  link; see [`packages/core`](packages/core#the-desertantcore-pod).
- **Android** depends on `ai.desertant:clear` from Maven Central, which brings
  LiteRT and the shared native core with it. **Voz has no Android half at all** —
  it drives Core ML directly, so upstream ships no artifact for it.

The Apple half is written against the **Expo Modules 2.0** macros (`@ExpoModule`,
`@JS`, `@SharedObject`, `@Record`, `@Event`), which ship for Swift in
`expo-modules-core` 57. The Android half is the classic Kotlin DSL, because 2.0
has no Kotlin implementation yet. Both answer to the same TypeScript surface.

[`docs/architecture.md`](docs/architecture.md) is the long version: why Expo
Modules rather than Nitro, what the buffer-marshaling constraint is and how it is
resolved, which platform differences are real, and the three Expo Modules 2.0
limits that only showed up against a real toolchain and a real phone.

**Status:** Clear is verified end to end on iOS on an iPhone 16 (iOS 26.3.1).
Voz compiles, links and binds — the module reports its version, revision and 25
languages, and its download reports real progress — but a transcription has not
been run end to end; that needs the ~490 MB weights and a Neural Engine. Android
compiles but has not been run — no device was available.

## Requirements

| | |
| --- | --- |
| Expo SDK | 57+ (`expo-modules-core` 57 is where the 2.0 macros live) |
| React Native | 0.75+ for `spm_dependency`; 0.83 in the example |
| iOS | **18.0+** with Clear (its Core ML artifact's floor); 17.0+ for Voz alone |
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
