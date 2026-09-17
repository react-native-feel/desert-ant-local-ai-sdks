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

## Every async call returns nothing, on purpose

`enhanceFile` and `enhanceBuffer`, the native halves of `enhance` and
`enhanceSamples`, are `@JS async` functions that return `Void` and stash the result on
the shared object under the caller's job id; the result comes back through a
**synchronous** `takeMetrics` -- next to the `takeEnhancedAudio` that already
handed the buffer over. `src/Clear.ts` makes both calls, so the public API above never
sees the seam.

That is the fourth Expo Modules 2.0 limit in `docs/architecture.md`, and the
short version is that **a `@JS async` function does its last work on the wrong
thread**. `@JavaScriptActor` is not a hop: `expo-modules-jsi`'s executor runs
jobs "synchronously without hopping to the proper thread" and says so in its own
doc comment, so once the call suspends on real work the closure the
`@ExpoModule` macro generated resumes on
`com.apple.root.user-initiated-qos.cooperative`. Two things it does from there
touch the Hermes runtime without the JavaScript thread: it encodes the return
value, and it destroys the owning copy of the call's *arguments* that
`createAsyncFunction` handed it. The downstream symptom is
`HadesGC::youngGenCollection` killing the process later and blaming nothing.

Returning `Void` removes the first of those. It does not remove the second --
`ShapesModule.load` crashed in `JavaScriptValuesBuffer.deinit` while returning
nothing at all -- so every async function here also lands back on the JavaScript
thread before it returns, through the `onJavaScriptThread` helper at the bottom
of `ios/ClearModule.swift`. Both halves, the crash reports behind them and what could not
be settled are in `docs/architecture.md`.

Kotlin has no encode-on-the-wrong-thread hazard. The Android half holds the
result anyway, so that the TypeScript above it stays one implementation rather
than two.

## Verified

iOS is verified on hardware -- an iPhone 16 on iOS 26.3.1, Expo SDK 57 -- for
both APIs and for the real path: `enhance` wrote a real WAV, `enhanceSamples`
round-tripped 96,000 samples, and a live microphone recording (`.m4a`, 82 KB)
came back enhanced at 15.4x realtime. The example app's **Run self-test** button
reproduces the first two without a microphone or a permission dialog.

**Android is unverified, and unbuilt.** The Kotlin half is written against the
same Expo Modules DSL as the rest of this repo, but it has not been compiled: the
machine this was developed on has no Android SDK (`ANDROID_HOME` points at a
directory that does not exist, and there is no `sdkmanager` or `gradle`). An
earlier version of this file said it "compiles as written"; that was never
verified here, and it is corrected rather than repeated. Treat the Android half
as unbuilt and untested until you build it yourself.

## Platform notes

- **`onProgress` fractions are iOS-only.** Android reports phase boundaries (`0`
  on entering, `1` on leaving) because `ai.desertant:clear` exposes no progress
  callback. Render a determinate bar on iOS and an indeterminate one on Android.
- **`variant: 'clear-natural'` is Apple-only** and throws `ERR_INVALID_ARGUMENT`
  on Android, where the Kotlin SDK has no variant parameter.
- **The output extension can change.** On iOS only a WAV input keeps the
  requested encoding; anything else (an `.m4a` from `expo-audio`, say) is decoded
  in memory and written back as WAV, to route around a crash in the upstream
  SDK's streaming path. Always read `result.uri` rather than assuming
  `outputUri`.
- **Memory grows with the file** for non-WAV input on iOS, and for *every* input
  on Android. Only a WAV on iOS gets the bounded-memory streaming pass. A very
  long recording will be felt first on Android, then on iOS with compressed
  input.
- Requires iOS 18+, Android API 24+, Expo SDK 57+, and Xcode 26 to build.

## License

MIT for this wrapper. The model ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0):
free below 100,000 monthly active devices per platform per model,
[attribution](https://license.desertant.com/attribution) required in your app.
