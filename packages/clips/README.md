# @desert-ant-labs/react-native-clips

On-device clip selection for React Native and Expo: turn a transcript into
ranked, non-overlapping highlights, with the spans of the recording to play.
Nothing leaves the device.

Wraps Desert Ant Labs' own [Clips](https://desertant.com/models/clips/) Swift SDK
as an Expo module.

**iOS 18+ only.** `clips.mlmodelc` is a multifunction Core ML package — two
graphs over one stored copy of a shared trunk — and multifunction is an iOS 18
feature. Upstream declares LiteRT files for Android but publishes no artifact to
bind to yet. `Clips.isSupported` is false in both cases, and
`Clips.unsupportedReason` says which.

## Install

```bash
npx expo install @desert-ant-labs/react-native-clips
```

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-clips"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios
```

The plugin raises the iOS deployment target to 18.0. It only ever raises, so it
composes with the other Desert Ant plugins.

## Use

```ts
import { Clips } from '@desert-ant-labs/react-native-clips';

if (!Clips.isSupported) {
  console.log(Clips.unsupportedReason);
  return;
}

const clips = await Clips.load({ onProgress: (e) => setProgress(e.fraction) });

const moments = await clips.find({ sentences });

for (const moment of moments) {
  moment.text;        // "The single biggest lesson is that we should have shipped a fake version first."
  moment.percentile;  // 0.95 — comparable across recordings; `score` is not
  moment.ranges;      // [{ start: 32.1, end: 41.4 }] — what to actually play
  moment.durationSec; // 9.3
}

clips.release();
```

### Where the sentences come from

`find` wants one sentence per element, in spoken order, each with the span of the
recording it occupies. Position in the array is the sentence's identity:
`clip.sentenceIds` indexes back into the array you passed, so reordering it after
selection resolves to different audio.

If you are coming from a recognizer, `Clips.toSentences` is the join — and it is
upstream's own splitter rather than a regex, because where a sentence ends is
something selection was trained on:

```ts
import { Voz } from '@desert-ant-labs/react-native-voz';

const { words } = await voz.transcribe({ uri });
const sentences = Clips.toSentences(words);
const moments = await clips.find({ sentences });
```

`toSentences` is pure and synchronous — no model, no download.

### Ranges, not just text

A clip is a set of sentences, and `ranges` is what turns that back into audio. It
is computed natively by upstream's own rule, so a cut lands in the same place
whatever calls it:

- Sentences spoken without a gap become **one span**; sentences separated by a
  pause become **one span each**, so the pause is cut rather than played.
- Each end is padded by up to `padding` (0.15 s by default) — but **only into
  actual silence**, so a cut never reaches into a neighbouring word.
- Spans that overlap once padded are merged.

## API

| | |
| --- | --- |
| `Clips.isSupported` | False on Android, and below iOS 18. |
| `Clips.unsupportedReason` | Why, in a sentence, or null. The two cases want different UI. |
| `Clips.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Clips.modelRevision` | The pinned model revision, or null. |
| `Clips.defaultLimit` | How many clips `find` returns by default. 10. |
| `Clips.toSentences(words, options?)` | Timed words → sentences. Pure; no model. |
| `Clips.load(options?)` | Create, download and prepare. |
| `Clips.create(options?)` | Create without touching the network. |
| `clips.isDownloaded()` | Whether `find` can run offline. Synchronous. |
| `clips.warm(onProgress?)` | Download and build the session. |
| `clips.download(onProgress?)` | The same call — see below. |
| `clips.find(options)` | Transcript in, ranked clips out. |
| `clips.release()` | Hand the model back. |

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_INVALID_ARGUMENT`, `ERR_RELEASED`,
`ERR_UNSUPPORTED_PLATFORM`.

## Things the types cannot tell you

- **`warm` and `download` are the same call.** Upstream exposes one entry point
  that downloads *and* builds the session, so unlike Clear and Voz there is no
  download-only step. Both names exist so the three models read alike.
- **`limit` sizes the work, it does not trim the result.** The candidate pool is
  four anchors wide per clip of budget and scoring those is 60–85% of the
  runtime, so asking for fewer is genuinely faster. It also means the answer at
  `10` is not the first ten of the answer at `14`: selection returns the best
  non-overlapping *set* of at most k, and the best set of ten is not the best set
  of fourteen with four dropped. Pass `null` to let the transcript's duration
  choose the count.
- **`score` is not comparable across transcripts.** Threshold on `percentile`.
- **Under three sentences returns `[]`** — there is nothing to choose between.
  This SDK answers that case without downloading anything.
- **The download is ~288 MB**, and the first load specializes the graph for the
  Neural Engine. Put it behind an explicit step, not on mount. `computeUnits: 'all'`
  is measurably worse here, not better: it compiles two graphs for three backends
  and took 3–4 minutes to specialize against roughly 41 s, for selection latency
  that did not improve.
- **100 languages**, from an xlm-roberta-base trunk. Unlike Voz, this one is not
  narrow.

## Verified

Driven on an iOS 26.4 simulator with a Release build, alongside Clear and Voz:

- The module binds and reports `isSupported=true` (the iOS 18 floor check
  passing), `nativeCore=3.1.0`, `revision=v0.1.0`, `defaultLimit=10`.
- `isDownloaded()` answers correctly, and its answer survives a relaunch.
- The 288 MB download completes and builds a Core ML session.
- A rate-limited download surfaces as a clean `ERR_MODEL_UNAVAILABLE` carrying
  the HTTP status, and the app recovers and retries successfully.
- **`toSentences` and `find` work end to end.** A twelve-sentence synthetic
  transcript came back as four ranked, non-overlapping clips, each with playable
  multi-span ranges:

  ```
  #1  p1.00  11.4s  11.8-15.7, 15.8-19.6, 19.9-23.6
      "The metrics looked fine in staging, which is exactly the problem. ..."
  #2  p0.67  11.4s  23.9-27.6, 27.9-31.6, 31.9-35.6
  #3  p0.33  11.4s  35.9-39.6, 39.9-43.6, 43.9-47.6
  #4  p0.00  11.3s  0.0-3.6, 3.9-7.7, 7.8-11.7
      "So thanks everyone for joining, we can probably get started. ..."
  ```

  Worth reading rather than skimming: the substance ranks first and the
  throat-clearing opener ranks last, percentiles span 0-1, no sentence appears in
  two clips, and each clip is three spans rather than one because its sentences
  are separated by pauses — which is `Clip.ranges(in:padding:)` cutting the pause
  instead of playing it.

Selection latency here is not worth quoting: a simulator has no Neural Engine and
the model has no GPU fallback. Desert Ant measures 9.19 s for a 25-minute
transcript on an iPhone 17 Pro.

Reproduce with the example app's **Run self-test** button, which needs no
microphone and no recording.

## License

MIT for this wrapper. The model ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0):
free below 100,000 monthly active devices per platform per model,
[attribution](https://license.desertant.com/attribution) required in your app.
