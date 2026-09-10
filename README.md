# Desert Ant Labs — React Native SDKs

React Native and Expo bindings for [Desert Ant Labs](https://github.com/Desert-Ant-Labs)'
on-device models. Desert Ant ships Swift, Kotlin and JavaScript/WebAssembly SDKs
from [`desert-ant-core`](https://github.com/Desert-Ant-Labs/desert-ant-core); this
repository is the React Native one they do not.

Starting with **Clear**: on-device speech enhancement — denoise, dereverb, and
loudness-normalize a messy recording into podcast-ready audio, entirely offline.

```ts
import { Clear } from '@desert-ant-labs/react-native-clear';

const clear = await Clear.load();
const { uri, realtimeFactor } = await clear.enhance({ uri: recording.uri });
```

## Packages

| Package | What it is |
| --- | --- |
| [`@desert-ant-labs/react-native-clear`](packages/clear) | The Clear model: file in, enhanced file out. |
| [`@desert-ant-labs/react-native-core`](packages/core) | Types, error codes and lifecycle contracts shared by every model SDK here. |
| [`apps/example`](apps/example) | Record → enhance → A/B playback, on a dev build. |

## How it is built

The native work is **not** a reimplementation. Each package is a thin Expo module
over Desert Ant's own platform SDKs:

- **iOS** links the `Clear` product of the `desert-ant-core` Swift package,
  pulled in through React Native's `spm_dependency` bridge — that package ships
  as SPM only, with no podspec and no XCFramework.
- **Android** depends on `ai.desertant:clear` from Maven Central, which brings
  LiteRT and the shared native core with it.

The Apple half is written against the **Expo Modules 2.0** macros (`@ExpoModule`,
`@JS`, `@SharedObject`, `@Record`, `@Event`), which ship for Swift in
`expo-modules-core` 57. The Android half is the classic Kotlin DSL, because 2.0
has no Kotlin implementation yet. Both answer to the same TypeScript surface.

[`docs/architecture.md`](docs/architecture.md) is the long version: why Expo
Modules rather than Nitro, what the buffer-marshaling constraint is and how it is
resolved, and which platform differences are real.

## Requirements

| | |
| --- | --- |
| Expo SDK | 57+ (`expo-modules-core` 57 is where the 2.0 macros live) |
| React Native | 0.75+ for `spm_dependency`; 0.83 in the example |
| iOS | **18.0+** — the Core ML artifact's floor, not ours |
| Xcode | 26 (`desert-ant-core` is `swift-tools-version: 6.2`) |
| Android | API 24+, `arm64-v8a` and `x86_64` only |
| Expo Go | Not supported — these are native modules, so use a dev build |

The bundled config plugin raises the iOS deployment target and narrows the
Android ABIs for you; add the package to `plugins` in your app config.

## Develop

```bash
npm install
npm run build          # both packages, including the config plugin
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
