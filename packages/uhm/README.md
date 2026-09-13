# @desert-ant-labs/react-native-uhm

On-device filler-word detection for React Native and Expo: every "uh", "um" and
"hmm" in a recording, to within 20 ms, without transcribing it. Nothing leaves
the device.

Wraps Desert Ant Labs' own [Uhm](https://desertant.com/models/uhm/) Swift SDK as
an Expo module.

**iOS only.** Upstream publishes a Core ML export and no LiteRT one, and the type
labeller is a SoundAnalysis classifier — Apple-only by construction. So this is
not "Android is coming"; it is two halves that would both need building.
`Uhm.isSupported` is false there.

## Install

```bash
npx expo install @desert-ant-labs/react-native-uhm
```

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-uhm"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios
```

The plugin raises the iOS deployment target to 17.0. It only ever raises, so it
composes with the other Desert Ant plugins.

## Use

```ts
import { Uhm } from '@desert-ant-labs/react-native-uhm';

if (!Uhm.isSupported) return;

const uhm = await Uhm.load();

const { fillers, realtimeFactor } = await uhm.analyze({ uri: recording.uri });

for (const filler of fillers) {
  filler.type;        // 'um' | 'uh' | 'hmm' | 'and' | 'other' | null
  filler.start;       // 4.21
  filler.end;         // 4.47
  filler.confidence;  // 0.88
}

uhm.release();
```

Any file AVFoundation can decode, including the audio track of a video.

### Why acoustic

A recognizer is trained to produce readable text, so it drops disfluencies or
spells them inconsistently — asking one where the "um"s are means asking for the
thing it was taught to throw away. Uhm reads the waveform instead. That is why it
needs no transcript, why it finds fillers a transcript never contained, and why
it costs about 12 seconds per hour of audio rather than a transcription's worth.

### Precision or recall, per call

A `Uhm` holds no settings: the gate is chosen per `analyze`, so two callers can
ask the same loaded model different questions.

```ts
await uhm.analyze({ uri, bias: 'precision' });  // 0.75 — safest for an automatic cut
await uhm.analyze({ uri, bias: 'balanced' });   // 0.65 — the default
await uhm.analyze({ uri, bias: 'recall' });     // 0.50 — for review-and-confirm
```

The thresholds are stable across model revisions — the published models are
pre-calibrated — and `Uhm.biasThresholds` reads them off the Swift enum rather
than repeating them. Which means one analysis can serve two actions:

```ts
const { fillers } = await uhm.analyze({ uri, bias: 'recall' });
const offerToCut = fillers;
const cutWithoutAsking = fillers.filter((f) => f.confidence >= Uhm.biasThresholds.precision);
```

### With a transcript: `reconcileWords`

Uhm needs no transcript, but an editor that has one needs the two to agree.
`Uhm.reconcileWords` is upstream's geometry for that, and the cases are not
obvious: a recognizer's word span can straddle a filler, contain one, or *be*
one — it heard "um" and wrote it down.

```ts
const { words } = await voz.transcribe({ uri });
const { fillers } = await uhm.analyze({ uri });
const clean = Uhm.reconcileWords(words, fillers);
```

- A word **inside** a filler is dropped — it was the filler.
- A word running **into** one has its end pulled back to the filler's start.
- A word running **out of** one has its start pushed forward to its end.
- A word **containing** one is split; the longer half is kept, or both with
  `splitContainedWords`.
- Anything that does not overlap passes through.

`minOverlapFraction` (0.5) gates the trims, because the two models measure the
same audio to different resolutions — Voz places a word boundary to about 80 ms,
Uhm places a filler edge to 20 ms — and a small overlap is that disagreement
rather than a word running into an "um".

Pure and synchronous — no model, no download.

## API

| | |
| --- | --- |
| `Uhm.isSupported` | False on Android. |
| `Uhm.unsupportedReason` | Why, in a sentence, or null. |
| `Uhm.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Uhm.modelRevision` | The pinned model revision, or null. |
| `Uhm.biasThresholds` | `{ precision: 0.75, balanced: 0.65, recall: 0.5 }`, read from Swift. |
| `Uhm.fillerTypes` | Every type the labeller can return. |
| `Uhm.reconcileWords(words, fillers, options?)` | Trim a transcript around the fillers. Pure; no model. |
| `Uhm.load(options?)` | Create, download and prepare. |
| `Uhm.create(options?)` | Create without touching the network. |
| `uhm.isDownloaded()` | Whether `analyze` can run offline. Synchronous. |
| `uhm.warm(onProgress?)` | Download and build the session. |
| `uhm.download(onProgress?)` | The same call — see below. |
| `uhm.analyze(options)` | File in, fillers out. |
| `uhm.analyzeSamples(samples, sampleRate?, options?)` | Mono floats in, fillers out. |
| `uhm.release()` | Hand the model back. |

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_AUDIO_DECODE_FAILED`, `ERR_INVALID_ARGUMENT`,
`ERR_RELEASED`, `ERR_UNSUPPORTED_PLATFORM`.

## Things the types cannot tell you

- **`warm` and `download` are the same call.** Upstream exposes one entry point
  that downloads *and* builds the session, so unlike Clear and Voz there is no
  download-only step. Both names exist so the four models read alike.
- **~45 MB, and a session build measured in seconds.** This is the one model here
  an app can reasonably load on mount. Voz is 490 MB and Clips 288 MB; those are
  not.
- **`type` is nil more often than you would guess.** The labeller is a separate
  ~13 KB SoundAnalysis head, and it round-trips a one-second clip per detection
  through a temporary WAV. `includeTypes: false` skips it — real time saved on
  audio with many fillers, and the spans are unchanged.
- **`and` is a filler type.** Mid-sentence "and"-as-connector. Treat it
  differently from `um` if you are cutting: dropping it changes the sentence.
  Show `other` as a neutral "filler" rather than as a category — it is the
  labeller's "not sure which kind" bucket.
- **English, with untested transfer.** Trained on English; Desert Ant reports it
  transfers acoustically to Spanish, French, German and Dutch without retraining,
  but has not measured per-language accuracy. Treat those four as "works,
  unquantified".
- **One published tier.** Upstream's `Uhm.Quality` selects between model tiers
  and currently has one — the distilled DistilHuBERT — so this SDK does not
  expose the knob. It appears here when a second tier is published, not before.
- **`computeUnits` defaults to `all`**, which is upstream's own default rather
  than a choice made here. The detector is small enough that the specialization
  `all` pays is seconds, so the cautious setting is not obviously better; use
  `cpuOnly` to take the Neural Engine out of the picture while diagnosing.

## Verified

Driven on an iOS 26.4 simulator with a dev build, alongside Clear, Voz and Clips.

The module binds and reports, before anything touches a model:

```
[uhm] isSupported=true nativeCore=3.1.0 revision=612592c
      bias={"precision":0.75,"balanced":0.65,"recall":0.5} types=uh/um/hmm/and/other
```

which exercises the `@ExpoModule` registration, every `@JS` property including the
`[String: Double]` return, `createModel` returning a `@SharedObject`, its
synchronous `isDownloaded()`, and `release()`.

The 45 MB download completes and builds a Core ML session: **39 s cold**, and
**~20 s warm** on every later launch — the session build, since a simulator has no
Neural Engine cache to hit. `isDownloaded()` answers true across relaunches.

**Detection works end to end.** Eleven seconds of real speech containing six
fillers:

```
[uhm] analyze(file) ok in 1208ms — 6 fillers, 10.93s rtf=9x
      decode=21ms inference=934ms labeling=189ms
[uhm]   other  0.70–1.14s (440ms, conf 0.91)
[uhm]   other  2.46–2.94s (480ms, conf 0.86)
[uhm]   other  4.56–4.98s (420ms, conf 0.92)
[uhm]   um     6.10–6.28s (180ms, conf 0.89)
[uhm]   other  7.70–8.14s (440ms, conf 0.88)
[uhm]   other  9.34–9.82s (480ms, conf 0.91)
[uhm] ordered=true insideAudio=true aboveThreshold=true typesKnown=true
```

Every filler was found and placed, and the spans are 180–480 ms — which is what a
filler is. The types are the honest part: one `um`, five `other`. The audio is
macOS `say` output, and a synthesized "ummm" is not acoustically what the labeller
was trained on, so `other` — its "something is here, not sure which kind" bucket —
is the right answer rather than a wrong one. On that input every confidence landed
above 0.86, so `recall`, `balanced` and `precision` all returned the same six; the
presets were exercised, not distinguished.

Also exercised: `analyzeSamples` on 48 kHz audio, which proves the native resample
and the `Float32Array` copy; and `includeTypes: false`, which returned the same six
spans with every `type` null.

**`reconcileWords` was checked rule by rule**, on seven word spans chosen to hit
each case at once:

```
[uhm] reconcileWords: 7 words -> 6 ranges
      [["so",0,0.4],["think",0.8,0.95],["we",1.3,1.9],["I",1.35,1.5],["should",2,2.4],["go",4,4.3]]
[uhm] dropped(um)=true trimmedEnd(think->0.95)=true pushedStart(I->1.35)=true
      splitKeptLongerHalf(should->2.0-2.4)=true underGateUntouched(we->1.3-1.9)=true
      untouched(so,go)=true sortedByStart=true
```

The one to read twice is `we`. It **does** still overlap a filler afterwards, by
50 ms, and that is correct: the overlap is 8% of its length against a
`minOverlapFraction` of 0.5, so the gate leaves it alone. Asserting "no word
overlaps a filler" after reconciliation is the wrong assertion — this README's own
self-test made it first.

Latency here is not worth quoting as a product number: a simulator has no Neural
Engine, so 9x realtime is the CPU path. Desert Ant measures 296x realtime on an
iPhone 17 Pro.

Reproduce with the example app's **Run self-test** button. It needs no microphone
and no permission dialog: without a real sample it analyzes synthetic audio, where
zero fillers is the correct answer and the plumbing is what is being asserted.
Drop a speech file at `uhm-sample.wav` in the app's cache directory to have it
analyze that instead — which is how the numbers above were produced.

## License

MIT for this wrapper. The model ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0):
free below 100,000 monthly active devices per platform per model,
[attribution](https://license.desertant.com/attribution) required in your app.
