# @desert-ant-labs/react-native-clear

On-device speech enhancement for React Native and Expo: denoise, dereverb, and
loudness-normalize a messy recording into podcast-ready audio. Nothing leaves the
device.

Wraps Desert Ant Labs' own [Clear](https://github.com/Desert-Ant-Labs/desert-ant-core/blob/main/docs/models/clear.md)
SDKs — Core ML on Apple, LiteRT on Android — as an Expo module.

## Install

```bash
npx expo install @desert-ant-labs/react-native-clear
```

Add the plugin to your app config, then build a dev client (this is a native
module; Expo Go cannot load it):

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-clear"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios
```

The plugin raises the iOS deployment target to 18.0 and narrows the Android
`abiFilters` to `arm64-v8a` and `x86_64`. Both are requirements of the underlying
model artifacts, not preferences — see [the architecture notes](../../docs/architecture.md).

## Use

```ts
import { Clear } from '@desert-ant-labs/react-native-clear';

// Downloads ~9 MB on first run and, on Apple, compiles the Core ML program for
// the Neural Engine. Seconds once per install, ~62 ms every time after.
const clear = await Clear.load({
  onProgress: (e) => console.log(e.phase, e.fraction),
});

const result = await clear.enhance({
  uri: recording.uri,          // whatever expo-audio gave you
  targetLUFS: 'applePodcasts', // or 'spotify' | 'youtube' | 'broadcast' | a number | null
});

result.uri;                 // file:// URI of the enhanced audio
result.realtimeFactor;      // ~300x on an iPhone 16 Pro
result.measuredTruePeakDBFS;

clear.release();
```

`enhance` writes next to the input with a `-clear` suffix unless you pass
`outputUri`, and the output encoding follows that path's extension: `.wav` is
16-bit PCM, `.m4a`/`.mp4`/`.aac` is AAC, and on Apple `.caf`/`.aiff` is PCM.

### Samples, if you have to

For audio you already hold as floats. It copies every sample into native memory
and back — ~11 MB each way per minute of 48 kHz mono — so prefer `enhance`
whenever the audio is, or could be, a file.

```ts
const { samples, channels, measuredLUFS } = await clear.enhanceSamples(pcm, 48_000);

// Stereo in, stereo out. Mono is the default because keeping the pair costs an
// inference pass per channel.
const stereo = await clear.enhanceSamples([left, right], 48_000, {
  channelMode: 'preserve',
});
```

## API

| | |
| --- | --- |
| `Clear.load(options?)` | Create, download, and warm. Resolves when the next `enhance` will not wait. |
| `Clear.create(options?)` | Create without touching the network; the weights resolve on first use. |
| `Clear.isSupported` | False on an Android ABI with no LiteRT binary. |
| `clear.isDownloaded()` | Whether `enhance` can run offline. Synchronous. |
| `clear.download(onProgress?)` | Fetch the weights only. |
| `clear.warm(onProgress?)` | Download, then build the session (Apple; Android downloads only). |
| `clear.enhance(options)` | File in, file out. **The API to use.** |
| `clear.enhanceSamples(samples, sampleRate?, options?)` | Floats in, floats out. |
| `clear.release()` | Hand the model back. |

Failures are `DesertAntError` with a stable `code`: `ERR_MODEL_UNAVAILABLE`,
`ERR_MODEL_LOAD_FAILED`, `ERR_INFERENCE_FAILED`, `ERR_AUDIO_DECODE_FAILED`,
`ERR_AUDIO_ENCODE_FAILED`, `ERR_INVALID_ARGUMENT`, `ERR_RELEASED`,
`ERR_UNSUPPORTED_PLATFORM`.

## Platform notes

- **`onProgress` fractions are iOS-only.** Android reports phase boundaries (`0`
  on entering, `1` on leaving) because `ai.desertant:clear` exposes no progress
  callback. Render a determinate bar on iOS and an indeterminate one on Android.
- **`variant: 'clear-natural'` is Apple-only** and throws `ERR_INVALID_ARGUMENT`
  on Android, where the Kotlin SDK has no variant parameter.
- **Android holds the whole file in memory** while enhancing; iOS streams. A
  very long recording will be felt on Android first.
- Requires iOS 18+, Android API 24+, Expo SDK 57+, and Xcode 26 to build.

## License

MIT for this wrapper. The model ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0):
free below 100,000 monthly active devices per platform per model,
[attribution](https://license.desertant.com/attribution) required in your app.
