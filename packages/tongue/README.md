# @desert-ant-labs/react-native-tongue

On-device language identification for short text in React Native and Expo: which
of 84 languages three words are in, in tens of microseconds, with nothing
downloaded and nothing leaving the device.

Wraps Desert Ant Labs' own [Tongue](https://desertant.com/models/tongue/) Swift
and Kotlin SDKs as an Expo module.

**Android today; iOS as soon as upstream exports one product.** The Android half
binds `ai.desertant:tongue` and works. The Apple half is written, compiles, and
is switched off, because desert-ant-core v3.1.0 declares a `Tongue` SwiftPM
product and never adds it to its manifest's `products:` array — so no consumer
can link the target at all. [The whole story is below](#the-apple-half-is-written-and-switched-off).

## Install

```bash
npx expo install @desert-ant-labs/react-native-tongue
```

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-tongue"] } }
```

```bash
npx expo prebuild --clean && npx expo run:android   # or run:ios
```

The plugin raises the iOS deployment target to 17.0 — tied with Emo, Uhm and Ear
for the lowest floor of any model here — and does **nothing** to your Android
build. That absence is the point: Clear, Emo and Ear each narrow `abiFilters` to
`arm64-v8a` and `x86_64` because each binds LiteRT. Tongue binds no native
library, so every ABI works and narrowing yours would be a restriction this model
does not have.

## Use

```ts
import { Tongue } from '@desert-ant-labs/react-native-tongue';

const tongue = await Tongue.load();

const read = tongue.detectSync('kann ich das haben');
// { language: 'de', confidence: 0.87, reliability: 'likely',
//   isTooCloseToCall: false, normalized: 'kann ich das haben',
//   route: { verdict: 'ambiguous', candidates: [], script: 'Latin' }, ... }

if (read.reliability === 'confident' || read.reliability === 'likely') {
  route(read.language);
} else {
  ask();                 // three words is often genuinely undecidable
}

tongue.release();
```

### `detectSync` is the point, not a shortcut

Every other model in this repo answers asynchronously because every other model
takes milliseconds to seconds. A detection here is an int8 embedding gather, a
sum over the n-grams present, one 59×32 matmul and a masked softmax — a few
thousand multiply-adds, which upstream measures in tens of microseconds and
documents as a main-thread call. Awaiting that costs more than doing it.

```ts
<TextInput onChangeText={(text) => setRead(tongue.detectSync(text))} />
```

No debounce, no timer, no promise. `detect()` exists as well, returns a promise,
and calls the same synchronous native function underneath — it is there so this
package reads like the other six, and so it can load the model for a caller who
forgot to.

It is also the shape that cannot hit the Expo Modules 2.0 hazard this repo lost a
day to. A `@JS async` function's return value can be encoded off the JavaScript
thread and segfault the runtime; a synchronous one is encoded on the JavaScript
thread by construction. Exactly one function in this module is `async` — `load` —
and it returns `void`.

### Branch on `reliability`, not on `confidence`

This is the one thing to get right, and the two disagree exactly where it
matters.

`reliability` is keyed off **evidence** — how much text survived normalization,
and how far the winner leads the runner-up — rather than off the softmax, which
is badly overconfident on very short text:

| | condition |
| --- | --- |
| `confident` | 18+ characters and a 0.30+ margin, **or** a script only one language uses |
| `likely` | 12+ characters and a 0.20+ margin |
| `tentative` | everything else that produced an answer |
| `empty` | normalization left nothing; `language` is null |

`"hi i am"` reads as Welsh to any character model at high probability. The
probability does not reveal that; the length and the margin do. Treat `tentative`
as **unknown** rather than as an answer with an asterisk.

`isTooCloseToCall` is a separate question, not a weaker `reliability`. It is true
when the top two are within `Tongue.tieMargin` (0.12) of each other:

```ts
const read = tongue.detectSync('la casa');
read.isTooCloseToCall;   // true — equally Italian and Spanish
read.candidates;         // show both rather than crowning one
```

A long sentence can be `confident` and still too close to call between two sister
languages, and a short one can be a runaway winner and still `tentative`.

### The router answers before the model does

25 of the 84 languages never reach the model at all. `route` says which stage
answered, and it is the best available explanation of a result:

```ts
tongue.detectSync('안녕하세요').route;
// { verdict: 'decisive', candidates: ['ko'], script: 'Hangul' }
// probability 1, reliability 'confident' — only Korean uses Hangul,
// so there is no guessing involved however short the text is.

tongue.detectSync('привет как дела').route;
// { verdict: 'narrowing', candidates: ['ru','uk','bg','sr','mk','be','kk','ky'], script: 'Cyrillic' }
// the head decoded among those eight, not among all 59.

tongue.detectSync('la casa').route;
// { verdict: 'ambiguous', candidates: [], script: 'Latin' }
// no script narrowed it, so the head decoded over the 42 Latin-script labels.
```

So the 84 languages are 59 the model decodes plus 25 the script settles, across
31 scripts. `Route.script` carries a UAX#24 script name — plus `'Japanese'`,
which is not one: Japanese mixes Han with kana, so any kana settles the route
even when Han characters outnumber it, and without that special case kanji-heavy
Japanese misroutes to Chinese.

### Read `normalized` when an answer surprises you

It is what the model actually saw: NFC-composed, lowercased, with URLs, emails,
mentions and digits stripped, whitespace collapsed, and truncated to
`Tongue.maxCharacters` (512) Unicode scalars.

```ts
tongue.detectSync('Check HTTPS://example.com/x @someone — 2024 très bien').normalized;
// 'check très bien'
```

That is also why empty input is an answer rather than an error: a string that
normalizes to nothing comes back `reliability: 'empty'` with a null `language`,
which is what a field someone just cleared should get.

## API

| | |
| --- | --- |
| `Tongue.isSupported` | True on Android. False on iOS today — see below. |
| `Tongue.unsupportedReason` | Why, in a sentence, or null. |
| `Tongue.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Tongue.modelRevision` | The pinned revision. **Not a download** — see below. |
| `Tongue.modelRepo` | The Hub repo mirroring the bundled bytes, or null. |
| `Tongue.defaultTopK` | How many candidates `detect` ranks untold. `3`. |
| `Tongue.tieMargin` | The gap `isTooCloseToCall` requires. `0.12`. |
| `Tongue.maxCharacters` | The normalizer's scalar cap. `512`. |
| `Tongue.supportedScripts()` | The 32 script names. **Apple only** — see below. |
| `Tongue.load()` | Create and read the bundled weights. |
| `Tongue.create()` | Create without reading them. |
| `tongue.isLoaded()` | Whether `detectSync` will answer. Synchronous. |
| `tongue.warm()` | Read the 2 MB and build the pipeline. |
| `tongue.detect(text, options?)` | A promise, for symmetry with the other six. |
| `tongue.detectSync(text, options?)` | The same call, without the promise. |
| `tongue.release()` | Hand the model back. |

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_INVALID_ARGUMENT`, `ERR_RELEASED`,
`ERR_UNSUPPORTED_PLATFORM`.

## Things the types cannot tell you

- **Nothing downloads, ever.** The whole model is 2 MB of int8 weights plus a
  metadata JSON, shipped *inside* the package — a SwiftPM target resource on
  Apple, a jar resource on Android. So this is the only model here with no
  `directory` load option, no `isDownloaded()`, no `ProgressEvent`, and no
  `onProgress` anywhere. `modelRevision` names a Hub tag that mirrors bytes
  sha256-identical to the bundled ones, for the website demo; no `ModelStore`
  path in any Desert Ant SDK resolves it.
- **No progress is emitted at all**, and no phase was added to `ModelPhase` in
  `packages/core`. There is no download to report on, and neither `Tongue()` nor
  `detect` takes a handler on either platform. Inventing a fraction for a file
  read would mean making one up.
- **`warm` is a file read**, not a network call — 2 MB widened into `[Int8]` plus
  ~7,500 fp32s decoded, which is the only millisecond-scale part of this model.
  It is asynchronous only so that work stays off the JavaScript thread.
- **The Kotlin SDK is a port, not a binding.** Every other Android half in this
  repo calls into the shared native core through JNI. `ai.desertant:tongue` is a
  second implementation of the same frozen specification in pure Kotlin, using
  only `java.text.Normalizer` and `java.util.regex` — upstream's reasoning is
  that bridging the Swift core would cost ~51 MB of static Swift runtime per ABI
  to serve 2 MB of weights. The safety normally bought by having one
  implementation is bought instead by golden vectors the Swift, Kotlin and
  JavaScript ports all replay byte for byte.
- **So there is no ABI constraint.** No NDK, no `.so`, no `abiFilters`. This is
  the only cross-platform model here whose `isSupported` on Android is not a
  statement about the device.
- **`supportedScripts()` is Apple-only by design.** Swift exposes `Script` as a
  public `CaseIterable` enum and `Router.route` as a public function; in
  `ai.desertant:tongue` both `Router` and `ScriptTables` are `internal`. Android
  raises `ERR_UNSUPPORTED_PLATFORM` rather than returning a list this package
  hardcoded, which would be right until the next model revision and then quietly
  wrong with no way for a caller to tell. `detection.route.script` still works on
  both platforms — it is the *catalogue* that is missing, not the field.
- **There is no language list, on either platform.** `Metadata` is `internal` in
  both SDKs, so neither exposes its 59 labels. The 84 is a product claim, and this
  package does not turn it into an array it would then have to keep true.
- **`tieMargin` is mirrored, not read.** Upstream writes `0.12` inline inside
  `isTooCloseToCall` on both platforms and names no constant, so there is nothing
  to read. `defaultTopK` and `maxCharacters` *are* read off the binary.
  Nothing branches on `tieMargin`; it is there to explain a `true`.
- **Empty and whitespace-only input are answers**, not errors. So is text over
  the cap — it is truncated, and `normalized` shows exactly what was seen.
- **One or two words is often undecidable**, per upstream, and the model says so
  through `reliability` rather than through a low probability.

## The Apple half is written and switched off

desert-ant-core v3.1.0's `Package.swift` declares the product:

```swift
let tongueProducts: [Product] = [
    .library(name: "Tongue", targets: ["Tongue"]),
]
```

and then builds the manifest without it:

```swift
products: products + modelProducts + alignProducts + vozProducts,
```

`swift package dump-package` on the pinned tag reports 45 products — `Clear`,
`Voz`, `Clips`, `Uhm`, `Emo`, `Ear`, `Align`, `Title`, and no `Tongue`. The only
thing in the whole package that depends on the target is the `ModelCatalogTests`
**test** target, which is a target and not a product, which is why it builds green
upstream and is invisible from there.

It is not an import error. Naming `'Tongue'` in `DESERT_ANT_PRODUCTS` fails the
build outright, before a line is compiled:

```
Missing package product 'Tongue' (in target 'DesertAntCore' from project 'Pods')
```

So `packages/tongue/ios` compiles behind `#if canImport(Tongue)` into an inert
branch that registers the module, answers every property, and refuses to make a
model with that sentence attached. When upstream adds `+ tongueProducts`, the
change on this side is adding `'Tongue'` to the array in
`packages/core/ios/DesertAntCore.podspec` — one entry — and `canImport` does the
rest.

One design decision came out of expecting to link it, and is worth keeping.
Tongue would be the first product in that array to ship SwiftPM **resources**, and
the package is linked into a *pod* rather than into the app target. Upstream's own
`Tongue()` resolves them through `Bundle.module`, whose generated accessor calls
`fatalError` when the bundle is missing — an unreportable crash rather than an
error a caller can act on. `TongueModel.swift` therefore searches the loaded
bundles for the two files itself, which is a superset of what `Bundle.module`
checks, and raises `ERR_MODEL_UNAVAILABLE` when it finds nothing.

## Verified

Driven on an iOS 26.4 simulator (iPhone 17 Pro Max) with a dev build, alongside
Clear, Voz, Clips, Uhm, Ear and Emo.

**What was exercised.** The seventh pod builds and links into an app that already
carries six, the module registers, and every `@JS` property reads — before
anything touches a model:

```
[tongue] isSupported=false nativeCore=3.1.0 revision=v1.0.0 repo=desert-ant-labs/tongue
         topK=3 tieMargin=0.12 maxChars=512
         reason=desert-ant-core v3.1.0 declares a `Tongue` SwiftPM product and never adds
         it to the package's `products:` array, so no consumer can link the target. ...
```

That is the `@ExpoModule` registration, all eight `@JS` properties, the
`#if canImport(Tongue)` fallback values, and the refusal reaching JavaScript
intact. The example app renders the same sentence in its Tongue section, its
self-test leg skips cleanly with `[tongue] self-test skipped — model not
prepared`, and the run ends `[selftest] all prepared models passed` — so adding
this package breaks none of the six.

**What was not, and why.** No detection has been run on any device. On iOS that
is the product gap above; on Android no device or emulator was available, which
is where every other model in this repo also stops. So there are **no measured
latency or accuracy numbers here**, and none are quoted: upstream's "tens of
microseconds" and "0.933 on three-word FLORES-200 input, against 0.887 for a
293 MB detector" are upstream's measurements, not this package's.

Everything that can be checked without the weights is checked and green: 31 Jest
tests over the argument guards, the no-native-module path, the cold-load
sequencing, the released-handle path, the error mapping, the
read-from-the-binary constants, the empty-script-list refusal, and the config
plugin — including a permutation test that runs this plugin at every position
among Clear's, Emo's and Ear's and asserts the single `abiFilters` block they
agree on is left exactly as found.

The example app's Tongue work is written and waiting with the Apple half: a text
field wired straight to `detectSync` with no debounce, seven tappable phrases
across seven scripts, a self-test leg with an eleven-language answer key and a
thousand-detection timing loop, and an **Ear vs Tongue** panel that asks both
models about one recording — Ear from the waveform, Tongue from the words Voz got
out of it — and reports the agreement rather than enforcing it. None of it has
run.
