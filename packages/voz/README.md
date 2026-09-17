# @desert-ant-labs/react-native-voz

On-device speech recognition for React Native and Expo: a transcript with
word-level timestamps, in 25 European languages, running entirely on the Neural
Engine. Nothing leaves the device.

Wraps Desert Ant Labs' own [Voz](https://desertant.com/models/voz/) Swift SDK as
an Expo module.

**iOS only.** Voz drives Core ML directly — preallocated buffers, `outputBackings`
and a lane-batched decode loop — so `desert-ant-core` publishes no Android, Linux
or web artifact for it. `Voz.isSupported` is `false` off Apple platforms rather
than throwing at import, so one bundle can ship everywhere.

## Install

```bash
npx expo install @desert-ant-labs/react-native-voz
```

Add the plugin to your app config, then build a dev client (this is a native
module; Expo Go cannot load it):

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-voz"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios
```

The plugin raises the iOS deployment target to 17.0 — the `desert-ant-core`
Swift package's own floor, above Expo's 16.4 default. It only ever raises, so it
composes with `@desert-ant-labs/react-native-clear`'s 18.0.

## Use

```ts
import { Voz } from '@desert-ant-labs/react-native-voz';

if (!Voz.isSupported) return; // Android: this model has no build

// ~490 MB on first run, then a one-time ~20 s Neural Engine specialization.
// Put it behind a button and a progress bar — see "The download" below.
const voz = await Voz.load({
  onProgress: (e) => console.log(e.phase, e.fraction),
});

const result = await voz.transcribe({ uri: recording.uri });

result.text;            // "the quick brown fox"
result.words[0];        // { text: 'the', start: 0, end: 0.24 }
result.realtimeFactor;  // ~300x on an iPhone 16 Pro

voz.release();
```

`transcribe` takes whatever `expo-audio` gave you — `.m4a`, `.wav`, `.mp3`,
anything AVFoundation decodes. The file is downmixed to mono and resampled to
16 kHz a chunk at a time, so peak memory does not grow with the recording.

### Samples, if you have to

For mono audio you already hold as floats.

```ts
const { text } = await voz.transcribeSamples(pcm, 48_000);
```

Cheaper than Clear's equivalent — the audio only travels one way and the result
is text — but it still copies every sample into native memory and gives up the
chunked read. Prefer `transcribe` whenever the audio is, or could be, a file.

## The download

The weights are **~490 MB** (a 460 MB encoder, a 16 MB decoder, a 10 MB embedding
table). That is about fifty times Clear's, and it changes how an app should treat
loading:

- Do **not** call `Voz.load()` on mount. Check `isDownloaded()` first and put the
  fetch behind an explicit action with a progress bar.
- `download()` fetches without loading; `warm()` fetches *and* pays the one-time
  Neural Engine specialization (~20 s). Every load after that is ~0.2 s.
- Files are verified and cached, so an interrupted download is not a corrupt
  model. Pass `directory` to adopt weights you shipped or fetched yourself.

`Voz.load()` is `create()` + `warm()`, which is the right call once the user has
agreed to the download.

## API

| | |
| --- | --- |
| `Voz.isSupported` | **False on Android** — the model has no build there. Check before offering the feature. |
| `Voz.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null off iOS. |
| `Voz.modelRevision` | The pinned model revision, or null off iOS. |
| `Voz.supportedLanguages` | The 25 ISO 639-1 codes the model was trained on. |
| `Voz.load(options?)` | Create, download, and warm. Resolves when the next `transcribe` will not wait. |
| `Voz.create(options?)` | Create without touching the network; the weights resolve on first use. |
| `voz.isDownloaded()` | Whether `transcribe` can run offline. Synchronous. |
| `voz.download(onProgress?)` | Fetch the weights only. |
| `voz.warm(onProgress?)` | Download, then build the Core ML session. |
| `voz.transcribe(options)` | File in, transcript out. **The API to use.** |
| `voz.transcribeSamples(samples, sampleRate?, options?)` | Mono floats in, transcript out. |
| `voz.release()` | Hand the model back. |

Failures are `DesertAntError` with a stable `code` — the same vocabulary
`@desert-ant-labs/react-native-clear` raises: `ERR_MODEL_UNAVAILABLE`,
`ERR_MODEL_LOAD_FAILED`, `ERR_INFERENCE_FAILED`, `ERR_AUDIO_DECODE_FAILED`,
`ERR_INVALID_ARGUMENT`, `ERR_RELEASED`, `ERR_UNSUPPORTED_PLATFORM`.

## Things the types cannot tell you

- **It does not detect the language.** Audio in a language outside
  `Voz.supportedLanguages` comes back as confident nonsense, not an error and not
  a low score. If your input is mixed, establish the language another way and
  check it against that set before trusting a transcript.
- **Word timings resolve to 80 ms**, one encoder frame — Desert Ant measures mean
  error at 83 ms on the start and 95 ms on the end. Good for captions and
  click-to-seek; not good enough to cut on a word boundary without a crossfade.
- **The Neural Engine is not optional.** The model runs there with no CPU or GPU
  fallback, so a simulator is for checking that your code compiles and links, not
  for measuring anything.
- **Transcribe the enhanced audio**, if you also use Clear. Removing noise and
  reverb before recognition is the reason to have both.

## Every async call returns nothing, on purpose

`transcribeFile` and `transcribeSamples` are `@JS async` functions that return `Void` and stash the result on
the shared object under the caller's job id; the result comes back through a
**synchronous** `takeTranscript`. `src/Voz.ts` makes both calls, so the public API above never
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
of `ios/VozModule.swift`. Both halves, the crash reports behind them and what could not
be settled are in `docs/architecture.md`.

## Verified

Compiles, links and binds: the native module resolves on device and reports
`isSupported=true`, `nativeCore=3.1.0`, `revision=v0.1.0`, 25 languages, and a
working `isDownloaded()` — verified in the example app on iOS 26.4 alongside
`@desert-ant-labs/react-native-clear`, with the model download reporting real
progress fractions.

**Transcription itself has not been run end to end.** It needs the ~490 MB
download and a Neural Engine, and no such device was available when this was
written. Treat the transcribe paths as untested until you have run the example
app's **Run self-test** on hardware.

Requires iOS 17+, Expo SDK 57+, and Xcode 26 to build.

## License

MIT for this wrapper. The model ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0):
free below 100,000 monthly active devices per platform per model,
[attribution](https://license.desertant.com/attribution) required in your app.
The base model is NVIDIA Parakeet TDT 0.6B v3, CC BY 4.0.
