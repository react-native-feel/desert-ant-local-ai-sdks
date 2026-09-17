# @desert-ant-labs/react-native-emo

On-device emoji suggestion for React Native and Expo: a short phrase in, the
emoji that fit it out, in 22 languages and about two milliseconds. Nothing leaves
the device.

Wraps Desert Ant Labs' own [Emo](https://desertant.com/models/emo/) Swift and
Kotlin SDKs as an Expo module.

**iOS and Android.** Emo is the second model in this repo with both halves, after
Clear: upstream publishes a Core ML export *and* a LiteRT one, and
`ai.desertant:emo` is on Maven Central. Voz, Clips and Uhm are Apple-only because
upstream ships nothing else for them; this one is not.

## Install

```bash
npx expo install @desert-ant-labs/react-native-emo
```

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-emo"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios   # or run:android
```

The plugin raises the iOS deployment target to 17.0 — the lowest floor of any
model here — and narrows the Android ABIs to `arm64-v8a` and `x86_64`, which are
the two LiteRT ships. Both only ever raise or narrow, so they compose with the
other Desert Ant plugins; pass `restrictAbis: false` to keep your own ABI list.

## Use

```ts
import { Emo } from '@desert-ant-labs/react-native-emo';

const emo = await Emo.load();

const suggestions = await emo.suggest('Pay my bills');
// [{ emoji: '💰', confidence: 0.62 }, { emoji: '💳', ... }, { emoji: '🧾', ... }]

const one = await emo.best('go for a run', { skinTone: 'medium' });
// { emoji: '🏃🏽', confidence: 0.55 }

emo.release();
```

Empty or whitespace-only input returns `[]` (and `best` returns `null`) without
reaching the model, so a cleared field costs nothing.

### Why not a lookup table

A table matches words. This reads the phrase. "Pay my bills" gets 💰 without
either word appearing in an emoji's name, and the same phrase in Spanish or
Japanese gets the same answer — the semantic stream is one multilingual
embedding, not 22 tables. That is also why it generalizes to words it has never
seen, and why it is 5 MB rather than a dictionary.

### Per keystroke

This is the one model in this repo where per-keystroke inference is the intended
use: ~2 ms, no audio, no file. Still debounce the *field*, not to protect the
model but to stop React re-rendering a suggestion row on every frame:

```ts
useEffect(() => {
  const timer = setTimeout(() => void suggest(text), 150);
  return () => clearTimeout(timer);
}, [text]);
```

### Skin tone

```ts
await emo.suggest('go for a run', { skinTone: 'dark' });
```

Applied after the ranking, not by the model: the vocabulary is toneless, and the
modifier is appended to whichever labels accept one. So a tone never changes
*which* emoji come back or in what order — only how the tone-capable ones render.
`Emo.skinTones` reads the accepted set off the linked binary rather than
repeating it here.

## API

| | |
| --- | --- |
| `Emo.isSupported` | True on iOS and on Android with a LiteRT ABI. |
| `Emo.unsupportedReason` | Why, in a sentence, or null. On Android it names the device's ABIs. |
| `Emo.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Emo.modelRevision` | The pinned model revision, or null. |
| `Emo.modelRepo` | The Hub repo the weights come from, or null. |
| `Emo.skinTones` | Every tone `skinTone` accepts, read off the binary. |
| `Emo.defaultLimit` | How many suggestions `suggest` returns untold. `3`. |
| `Emo.load(options?)` | Create, download and prepare. |
| `Emo.create(options?)` | Create without touching the network. |
| `emo.isDownloaded()` | Whether `suggest` can run offline. Synchronous. |
| `emo.warm(onProgress?)` | Download and build the session. |
| `emo.download(onProgress?)` | The same call — see below. |
| `emo.suggest(text, options?)` | Text in, ranked emoji out. |
| `emo.best(text, options?)` | The top one, or null. |
| `emo.release()` | Hand the model back. |

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_INVALID_ARGUMENT`, `ERR_RELEASED`,
`ERR_UNSUPPORTED_PLATFORM`.

## Things the types cannot tell you

- **`suggest`, not `suggestions`.** Upstream's Swift, Kotlin and JavaScript SDKs
  all spell it `suggestions`. Here it is the verb, matching `enhance`,
  `transcribe`, `find` and `analyze` — the two names cannot both be the house
  style, and the house won.
- **`warm` and `download` are the same call.** Upstream exposes one entry point
  that downloads *and* builds the session, so unlike Clear and Voz there is no
  download-only step. Both names exist so the five models read alike.
- **~5 MB on Apple, ~11 MB on Android.** The smallest model here by an order of
  magnitude — Uhm is 45 MB, Clips 288, Voz 490 — and the only one to load on
  mount with nothing to justify.
- **`confidence` is a softmax over the whole ~800-emoji vocabulary**, so it sums
  to 1 across the vocabulary, not across the handful you asked for. Expect a top
  suggestion in the 0.2–0.7 range rather than near 1, and expect near-ties at the
  top — upstream calls those normal for emoji. Use it to order and to gate, not
  as a probability of being right.
- **Tuned for short, intent-oriented text** — a task, a calendar entry, a message
  draft. Long-form input still returns something, and it gets noisier the further
  it is from that. Truncate rather than feeding it a paragraph.
- **Top-1 is what it is optimized for.** `best` exists because the tail of the
  ranking is weaker than its head; a row of three is about where the accuracy
  still earns the space.
- **No `computeUnits` knob**, unlike Uhm. That is upstream's shape rather than an
  omission: `Emo.init` takes `directory` alone. On a model this size the
  specialization a backend choice would trade against is milliseconds either way.
- **No vocabulary accessor.** The ~800 labels live in the model's `emo_meta.json`
  sidecar and upstream keeps them internal, so there is nothing to expose. The
  set is also free to change with a model revision, which is a good reason not to
  build UI over it.
- **Android reports progress as phase boundaries, not fractions.**
  `ai.desertant:emo`'s `download()` takes no callback, so it emits 0 on entering
  `loadingModel` and 1 on leaving. It matters less here than for Clear: the
  download is a few megabytes, not a few hundred.

## Languages

English, Spanish, Portuguese, French, German, Italian, Dutch, Russian, Polish,
Turkish, Arabic, Chinese (Simplified and Traditional), Japanese, Korean, Hindi,
Indonesian, Thai, Vietnamese, Ukrainian, Swedish, Danish, Czech.

Per-language quality varies, and upstream says the lower-resource languages in
that set are weaker.

That list has 23 entries and upstream calls it 22 languages — Chinese Simplified
and Traditional are two scripts of one. The Swift doc comment says 23 and the
model page says 22 for that reason; neither is wrong.

## Every async call returns nothing, on purpose

`suggest` is `@JS async` functions that return `Void` and stash the result on
the shared object under the caller's job id; the result comes back through a
**synchronous** `takeSuggestions`. `src/Emo.ts` makes both calls, so the public API above never
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
of `ios/EmoModule.swift`. Both halves, the crash reports behind them and what could not
be settled are in `docs/architecture.md`.

Kotlin has no encode-on-the-wrong-thread hazard. The Android half holds the
result anyway, so that the TypeScript above it stays one implementation rather
than two.

## Verified

Driven on an iOS 26.4 simulator (iPhone 17 Pro Max) with a dev build, alongside
Clear, Voz, Clips and Uhm.

The module binds and reports, before anything touches a model:

```
[emo] isSupported=true nativeCore=3.1.0 revision=v0.7.0 repo=desert-ant-labs/emo
      limit=3 tones=default/light/mediumLight/medium/mediumDark/dark
```

which exercises the `@ExpoModule` registration, every `@JS` property including the
`[String]` return, `createModel` returning a `@SharedObject`, its synchronous
`isDownloaded()`, and `release()`.

The ~5 MB download completes and builds a Core ML session in **7.6 s cold** and
**~2.6 s warm** on every later launch. `isDownloaded()` answers true across
relaunches.

**Suggestion works end to end.** "Pay my bills" through the app's own text field:

```
💰 0.64   📄 0.12   💳 0.05   🏠 0.03   …
```

💰 at 0.64 against the 0.62 upstream's own README quotes for the same phrase.

**The multilingual claim holds**, which is the one worth checking by hand rather
than taking on trust — one intent, three languages, three scripts:

| | Top suggestions |
| --- | --- |
| `Pay my bills` | 💰 📄 💳 🏠 |
| `Pagar mis facturas` | 💰 🧾 📄 💳 ✅ 🏠 |
| `請求書を払う` | 💰 📄 🧾 📮 💳 ✅ |

All three rank 💰 first. Neither Spanish nor Japanese has "pay" or "bill" in it
anywhere a keyword table could find; the semantic stream is doing the work.

A different intent gives a different answer rather than a fixed list —
"go for a run" returns 🏃 👟 🏁 🛒 🎽 💨.

**Latency**: 60 ms on the first call, then **5–16 ms**, measured in JavaScript
around `suggest` so it includes the bridge hop both ways. Upstream's <2 ms is the
model alone, and a simulator has no Neural Engine, so treat these as the ceiling
rather than the number.

**Skin tone works, and works the way the docs claim.** With `skinTone: 'dark'`,
"go for a run" returns:

```
🏃🏿  U+1F3C3 U+1F3FF      👟 🏁 🛒 🎽 💨   (unchanged)
```

The modifier lands only on the one emoji whose base accepts one, and the ranking
and the confidences are identical to the default-tone run — which is the concrete
form of "the tone is applied after the ranking, not by the model".
`mediumDark` was exercised the same way through the picker and gave U+1F3FE.

### One rough edge, and it is a development one

A suggestion fired from the example app's debounce once failed with:

```
[emo] suggest FAILED: ERR_INFERENCE_FAILED: NotFoundException:
      Unable to find the native shared object associated with given JavaScript object
```

That is Fast Refresh: it tears down the native shared-object registry while a
pending timer still holds the JavaScript half of the model. Emo is the only model
in this repo that can hit it, because it is the only one that calls a model from
a timer rather than from a tap — and it does not happen in a production build,
where nothing reloads the JS under a live model.

Worth knowing rather than hiding, because the code it surfaces is misleading:
`ERR_INFERENCE_FAILED` for what is really a dead handle. The example app now
recovers by releasing the handle and re-preparing, which is what an app should do
with any `suggest` failure it did not cause.

### Not verified

- **Android — not compiled.** Written against the same DSL as Clear's Android
  half, but no `prebuild --platform android` has been run, and it could not be:
  the machine this was developed on has no Android SDK (`ANDROID_HOME` points at
  a directory that does not exist; no `sdkmanager`, no `gradle`). An earlier
  version of this file said it "compiles as written" — that was never verified,
  and is corrected here.
- **Real-device latency.** A simulator has no Neural Engine, so the numbers above
  are the CPU path.

## License

This wrapper is MIT. The model it loads is not: it ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0)
— free below 100,000 monthly active devices per platform per model, attribution
required in your app, and no using the model or its outputs to train a competing
on-device model.
