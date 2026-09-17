# Desert Ant Labs — React Native SDKs

React Native and Expo bindings for [Desert Ant Labs](https://github.com/Desert-Ant-Labs)'
on-device models. Desert Ant ships Swift, Kotlin and JavaScript/WebAssembly SDKs
from [`desert-ant-core`](https://github.com/Desert-Ant-Labs/desert-ant-core); this
repository is the React Native one they do not.

Eleven models so far. Five of them compose into one pipeline: **Clear** cleans a
recording up — denoise, dereverb, loudness-normalize — **Ear** names the language
it is in, **Voz** reads it back as a transcript with word-level timestamps,
**Clips** picks the moments worth cutting, and **Uhm** finds every "um" in the
same audio without reading a word of it. The other four read text rather than
audio: **Emo** takes a phrase and gives back the emoji that fit it, **Tongue**
takes three words and names the language they are in — the same question Ear
answers, from the other kind of evidence — **Gist** takes a headline or a
post and names what it is *about*, from a fixed 36-topic taxonomy across 101
languages, and **Redact** finds the people in a piece of text and masks them,
reversibly, before it goes anywhere. The tenth reads neither sound nor words:
**Shapes** takes one hand-drawn stroke and gives back a clean line, rectangle,
triangle, ellipse or star — or nothing, when what was drawn was not a shape. And
the eleventh answers no question at all: **Align** takes the transcript Apple's
own `SpeechAnalyzer` produced and moves its word boundaries, by tens of
milliseconds, so a caption highlights the word you are hearing and a cut lands
between two of them. Entirely offline.

```ts
import { Clear } from '@desert-ant-labs/react-native-clear';
import { Voz } from '@desert-ant-labs/react-native-voz';
import { Clips } from '@desert-ant-labs/react-native-clips';
import { Uhm } from '@desert-ant-labs/react-native-uhm';
import { Emo } from '@desert-ant-labs/react-native-emo';
import { Ear } from '@desert-ant-labs/react-native-ear';
import { Tongue } from '@desert-ant-labs/react-native-tongue';
import { Gist, channelTopics } from '@desert-ant-labs/react-native-gist';
import { Redact, restore } from '@desert-ant-labs/react-native-redact';
import { Shapes, outline } from '@desert-ant-labs/react-native-shapes';
import { Align, timestampShift } from '@desert-ant-labs/react-native-align';

const { uri } = await (await Clear.load()).enhance({ uri: recording.uri });

const heard = await (await Ear.load()).identify({ uri });
// heard -> { language: 'pt', confidence: 0.99, isReliable: true, ... }

const { words } = await (await Voz.load()).transcribe({ uri });

const clips = await Clips.load();
const moments = await clips.find({ sentences: Clips.toSentences(words) });
// moments[0].ranges -> [{ start: 32.1, end: 41.4 }]

const { fillers } = await (await Uhm.load()).analyze({ uri });
// fillers[0] -> { type: 'um', start: 4.21, end: 4.47, confidence: 0.88 }
const clean = Uhm.reconcileWords(words, fillers);  // word spans that miss the ums

const emoji = await (await Emo.load()).suggest('Pay my bills');
// emoji[0] -> { emoji: '💰', confidence: 0.62 }

const tongue = await Tongue.load();
tongue.detectSync(transcript.text).language;   // "pt" — the same answer as Ear,
                                               // from the words rather than the sound

const gist = await Gist.load();
const { topics } = await gist.classify('How to start a podcast with your iPhone');
// topics[0] -> { slug: 'technology', name: 'Technology & Software', score: 0.93 }

const scored = await Promise.all(moments.map((m) => gist.scores(m.text)));
channelTopics(scored.map((s) => ({ topics: s.scores })));
// [{ slug: 'technology', share: 0.14, postCount: 10 }] — what the whole thing is about

const masked = await (await Redact.load()).redaction(words.map((w) => w.text).join(' '));
masked.redactedText;   // '… [GIVEN_NAME_1] … [EMAIL_1] …' — safe to send somewhere
restore(masked, summaryFromAnLLM);   // the originals put back, on device

const { shape } = await (await Shapes.load()).recognize(strokePoints);
// shape -> { kind: 'ellipse', center: {...}, semiMajor: 72.3, semiMinor: 72.3 }
//          semiMajor === semiMinor: a wobbly loop snapped to an exact circle
outline(shape);   // the polyline to draw. No model, no bridge hop.

const align = await Align.load();              // 0.7 MB
await align.prepareLocale('en-US');            // Apple's recognizer — the big half
const refined = await align.transcribe({ uri, locale: 'en-US' });
refined.words[0];
// { text: 'so', start: 0.31, end: 0.47, originalStart: 0.28, originalEnd: 0.52,
//   refined: true }   — Apple's numbers and Align's, side by side
timestampShift(refined.words).meanAbsSec;      // how far they disagreed, on YOUR audio
Uhm.reconcileWords(refined.words, fillers);    // now the cut lands on silence
```

Ear sits ahead of Voz rather than beside it, and that is the point of it: Voz does
not detect what it is hearing, so audio outside its 25 languages comes back as
confident nonsense rather than as an error. `isReliable` is the field to branch
on — it is false both when the top two candidates are too close *and* for
Norwegian, Swedish and Danish, which the detector confuses with each other
confidently, where no confidence threshold could catch it.

Uhm is the one that does not sit in the chain: it reads the waveform, so it runs
on the same file the others do but waits for none of them. What it wants a
transcript *for* is `reconcileWords`, which trims the word spans around the
fillers so a cut lands on silence rather than through a word.

Emo is not in the chain either, and not in the medium: it takes text. It is here
because it is the same lifecycle — create, load, call, release — over a model
that shares nothing else with the other four, and because at ~5 MB and ~2 ms it
is the one you can call on every keystroke.

Tongue is Ear's sibling across that divide: same question, different evidence.
Ear listens to ninety seconds of a recording; Tongue reads three words. Asking
both about one recording — Ear from the waveform, Tongue from the transcript — is
two independent models on one piece of content, and where they disagree the
disagreement is the useful output: a transcriber out of its depth produces text
that *looks* like a language it is not. It is also the odd one out mechanically.
Nothing about it downloads — the whole model is 2 MB of int8 inside the package —
and at tens of microseconds it is the only model here whose inference is
synchronous, which is why `detectSync` exists and why a text field needs no
debounce behind it.

Gist is the other half of describing a piece of content, and it pairs with Clips
rather than with the audio chain: given one transcript, Clips ranks which moments
are worth cutting and Gist says what the thing is *about*. It is also the model in
this family with the most lopsided cost — ~74 MB of weights and a forward pass in
single-digit milliseconds, because it is a static embedding table plus hashed
n-grams plus one MLP head with no transformer in it. So it is the one text model
here that does *not* load on mount. Its `channelTopics` roll-up is the only call
in the whole family that needs no model at all: pure arithmetic, bound from
upstream rather than reimplemented, so it answers on a device that has never
downloaded a weight.

Redact is the last step rather than another question, and it is the only model
here that changes the text instead of describing it. A transcript is exactly the
artifact an app then forwards to a summarizer, writes to a log, or attaches to a
support ticket — so Redact takes the people out of it first, replacing every name,
address, email, card and national ID with a numbered placeholder, and hands back
the mapping needed to put them all back afterwards. The mapping never leaves the
device; `restore` needs no model and no network. It is also the only model here
that is two detectors rather than one: a six-layer multilingual token classifier
for names and places, and a checksum layer in front of it that owns cards, IBANs,
SSNs and the rest outright.

Shapes is in neither medium and neither chain. Its input is a *stroke* — an
ordered list of x, y points off a canvas — which makes it the first model here
that reads the screen rather than the microphone or a string, and the only one
whose whole output is geometry. It is also the smallest by a long way: 0.2 MB on
Apple, a twenty-fifth of Emo, with a pass upstream advertises at under ten
milliseconds and this repo measured at a 2.0 ms median. It is two stages, and
knowing that explains most of what it does: a tiny classifier proposes a class, a
geometric fitter produces the clean parameters *and* a fit residual, and the
stroke is kept only if it clears that class's calibrated confidence **and**
residual gates. So a scribble comes back as nothing — which is half the product,
because a whiteboard that turns a scribble into a triangle is worse than one that
leaves it alone.

Align is the odd one out in a way none of the others are: it does not answer a
question, it corrects an answer. Apple's `SpeechAnalyzer` transcribes well and
times loosely — upstream measures its mean word-boundary error at 106.4 ms — and
Align takes the same words, unchanged, and moves the numbers on them to a measured
20.2 ms on LibriSpeech test-clean. Tens of milliseconds is the whole product,
which is also why it is the only model here that hands back **both** timelines: a
result carrying only the corrected span would be indistinguishable from Apple's
output with a flag bolted on, so `timestampShift` lets an app measure the
difference on its own audio rather than take a benchmark's word for it. It is also
the only model with **two** downloads — its own 0.7 MB, and Apple's per-locale
recognizer, which is hundreds of megabytes and is not Desert Ant's to ship. And it
is the only one that resolves a **branch** rather than a tag, which is a real risk
a consumer inherits; `Align.revisionIsPinned` reports it rather than hiding it.

## Packages

| Package | What it is |
| --- | --- |
| [`@desert-ant-labs/react-native-clear`](packages/clear) | The Clear model: file in, enhanced file out. iOS + Android. |
| [`@desert-ant-labs/react-native-voz`](packages/voz) | The Voz model: file in, transcript with word timings out. **iOS only.** |
| [`@desert-ant-labs/react-native-clips`](packages/clips) | The Clips model: transcript in, ranked highlights with playable spans out. **iOS 18+ only.** |
| [`@desert-ant-labs/react-native-uhm`](packages/uhm) | The Uhm model: audio in, frame-precise filler-word spans out. No transcript needed. **iOS only.** |
| [`@desert-ant-labs/react-native-ear`](packages/ear) | The Ear model: audio in, the language it is spoken in out, across 99. iOS + Android. |
| [`@desert-ant-labs/react-native-emo`](packages/emo) | The Emo model: short text in, ranked emoji with confidences out, 22 languages. iOS + Android. |
| [`@desert-ant-labs/react-native-tongue`](packages/tongue) | The Tongue model: three words in, the language they are in out, across 84. 2 MB bundled, nothing downloaded. **Android; the Apple half is written and blocked on an upstream product export.** |
| [`@desert-ant-labs/react-native-gist`](packages/gist) | The Gist model: text in, ranked topics from a fixed 36-topic taxonomy out, 101 languages. Plus a channel roll-up that needs no model. iOS + Android. |
| [`@desert-ant-labs/react-native-redact`](packages/redact) | The Redact model: text in, the same text with every person masked by a numbered placeholder out — plus the mapping to put them back. 27 languages. iOS + Android. |
| [`@desert-ant-labs/react-native-shapes`](packages/shapes) | The Shapes model: one hand-drawn stroke in, a clean line, rectangle, triangle, ellipse or star out — snapped to circles, squares and axes. 0.2 MB. iOS + Android. |
| [`@desert-ant-labs/react-native-align`](packages/align) | The Align model: an audio file in, Apple's transcript out with word boundaries refined to the word — and Apple's original timings beside them. 0.7 MB. **iOS 26+ only.** |
| [`@desert-ant-labs/react-native-core`](packages/core) | Types, error codes and lifecycle contracts shared by every model SDK here — and the single native bridge to the `desert-ant-core` Swift package. |
| [`apps/example`](apps/example) | Record → enhance → identify the language → transcribe → rank highlights → find the fillers, plus a text field each for Emo, Tongue, Gist and Redact — a roll-up of what the sample transcript is about, and the same transcript with its people masked — a canvas you draw one stroke on for Shapes, and an Align section that refines the word timestamps in a speech sample and shows Apple's numbers next to Align's. A dev build. |

## How it is built

The native work is **not** a reimplementation. Each package is a thin Expo module
over Desert Ant's own platform SDKs:

- **iOS** links the `Clear`, `Voz`, `Clips`, `Uhm`, `Emo`, `Ear`, `Gist`, `Redact`, `Shapes` and `Align` products of the `desert-ant-core`
  Swift package, pulled in through React Native's `spm_dependency` bridge — that
  package ships as SPM only, with no podspec and no XCFramework. The bridge is
  declared exactly once, by the `DesertAntCore` pod, because two pods each
  linking the same package duplicates its thirteen shared objects and fails to
  link; see [`packages/core`](packages/core#the-desertantcore-pod). Gist was the
  first product in that list with a *transitive C module* — its channel roll-up
  imports swift-numerics' `RealModule`, which needs `_NumericsShims` — so its
  podspec was the first to put a SwiftPM checkout on `SWIFT_INCLUDE_PATHS`.
  Redact is the second and needs the identical line, for `Double.exp` in its
  BIOES softmax; Shapes is the third, and the most explicit — `Package.swift`
  carries a comment above its entry saying its geometric fitters replace
  Apple-only `simd` with a portable `V2`, so their transcendental math comes from
  swift-numerics. Any `desert-ant-core` product that depends on swift-numerics
  needs that include path, which is now a rule rather than an incident: Shapes'
  pod was written with the line already in it and built on the first attempt.
  **Align is the case that proves the rule is a rule and not a habit** — its
  target declaration is `.target(name: "Align", dependencies: [.byName(name:
  "DesertAnt")])` and nothing else, so it needs no such line and does not have
  one. It is also the only product in that list that does not reach
  `desert-ant-core`'s manifest through `modelProducts`: being Apple-only it lives
  outside the `models` array in its own `alignProducts`, which the `products:`
  sum does include — the same sum `tongueProducts` is missing from.
  **Tongue is
  the one model not in that list**, and not by choice: desert-ant-core v3.1.0
  declares a `Tongue` product and never adds it to the manifest's `products:`
  array, so naming it fails the build rather than the import. Its Apple sources
  are written and guarded by `#if canImport(Tongue)`.
- **Android** depends on `ai.desertant:clear`, `ai.desertant:emo`,
  `ai.desertant:ear`, `ai.desertant:gist`, `ai.desertant:redact` and
  `ai.desertant:shapes` from Maven
  Central, which bring
  LiteRT and the shared native core with them, and on `ai.desertant:tongue`, which
  brings **nothing** — it is a pure-Kotlin port of the same frozen specification
  the Swift target implements, with no NDK and no `.so`, so it is the only model
  here with no ABI constraint on Android. Shapes is the one that makes that
  distinction worth stating: its fitters and its snapping are pure portable
  arithmetic, which makes a Tongue-shaped pure-Kotlin AAR sound plausible, and it
  is not one — stage one is a neural classifier, the catalog ships
  `shapes.tflite`, and `ShapesNative.ensureLoaded()` loads `libShapesAndroid.so`.
  What settles the question is whether the Kotlin SDK has a `NativeModelApi`
  under it. Those seven are the only models with an
  Android half: **Voz**
  drives Core ML directly and
  upstream ships no artifact for it at all, **Clips** has LiteRT files declared
  but no published Android package to bind to yet, **Uhm** has neither half —
  no LiteRT export of the detector, and a type labeller that is a SoundAnalysis
  classifier and so Apple-only by construction — and **Align** is Apple-only by
  design rather than by omission: upstream's manifest records its Kotlin and
  JavaScript SDKs as `none`, and `Package.swift` keeps its target outside the
  `models` array so it gets no Android, Node or Web products at all. `packages/align`
  has no `android/` directory.

The Apple half is written against the **Expo Modules 2.0** macros (`@ExpoModule`,
`@JS`, `@SharedObject`, `@Record`, `@Event`), which ship for Swift in
`expo-modules-core` 57. The Android half is the classic Kotlin DSL, because 2.0
has no Kotlin implementation yet. Both answer to the same TypeScript surface.

[`docs/architecture.md`](docs/architecture.md) is the long version: why Expo
Modules rather than Nitro, what the buffer-marshaling constraint is and how it is
resolved, which platform differences are real, and the four Expo Modules 2.0
limits that only showed up against a real toolchain and a real phone.

**Status:** Clear is verified end to end on iOS on an iPhone 16 (iOS 26.3.1).
Clips is verified end to end on a simulator — it downloads, loads, and returns
ranked non-overlapping clips with playable spans from a real transcript. Uhm is
verified end to end on a simulator too: it downloads, loads, and finds six
filler spans in eleven seconds of real speech, with the type labeller and
`reconcileWords` both exercised — and the example app's own record, clean and
detect flow returns them through the UI. Voz binds and reports correctly but its
transcription has not been run; that needs ~490 MB of weights and a Neural
Engine, which a simulator does not have. Ear is verified end to end on a simulator:
it downloads, loads, names all 99 languages it knows, and identifies six
half-minute recordings — English, Spanish, Portuguese, French, German and
Japanese — correctly, every one above 0.98 and every one marked reliable. Emo is
verified end to end on a simulator too: it
downloads, loads in 7.6 s, and answers "Pay my bills" with 💰 at 0.64 in 5–16 ms
— and the same phrase in Spanish and Japanese ranks 💰 first as well, which is
the multilingual claim rather than a keyword table. Its skin-tone path is
exercised and the ranking is unchanged by it, as documented. Tongue is the one
model here that has **not** been run at all: its Apple half cannot be linked
until desert-ant-core exports its `Tongue` SwiftPM product, and no Android device
was available for the half that does bind. What is verified is that the seventh
pod builds and links into an app that already carries six, that the module
registers and every `@JS` property reads, and that the refusal reaches JavaScript
as a sentence naming the cause — the example app's self-test still ends with all
prepared models passing. Android compiles but
has not been run — no device was available. Gist is verified end to end on a
simulator as the eighth pod in the same app: it downloads ~74 MB and builds a
Core ML session in 65.3 s, tags one headline in English, Spanish, German and
Japanese with the same two or three topics and no language passed in, answers a
finance headline with Personal Finance & Investing at 0.800 and a recipe with
Food & Cooking at 0.915, and rolls the sample transcript's twelve lines up into
technology 13.9%, business 12.7%, self-improvement 6.8% and news-politics 5.2%.
Steady-state tagging is 9–11 ms end to end from JavaScript, and twelve lines
scored and rolled up cost 74–88 ms. Redact is verified end to end on a simulator
as the ninth pod in the same app: it downloads ~12 MB and builds a Core ML session,
masks a sentence of contact details into
`Email [GIVEN_NAME_1] [SURNAME_1] at [EMAIL_1] or call [PHONE_1]; her card is [CREDIT_CARD_1].`,
and `restore` gives the input back character for character — on every sample, in
every run, including the label-narrowed and threshold-raised variants. One
redaction costs 574–584 ms end to end from JavaScript and the 134-word sample
transcript 464–477 ms. English and Spanish find the same five spans; German and
Hungarian each miss the card, and German labels an imperative verb as a surname —
recorded rather than smoothed over. Two sentences that should come back untouched
do. Two upstream behaviours are worth reporting and are written up: a
checksum-validated `IP_ADDRESS` can lose to the address post-processing and leave
three of its four octets in the text, and a label the deterministic layer owns can
arrive with a sub-1 confidence — so neither field reads as provenance. Gist's and
Redact's Android halves are the two in this repo that have **not even been
compiled** — there is no usable Android SDK on the machine this was built on, and
the older packages' "Android compiles but has not been run" is itself an
unverified claim that is being corrected separately. Shapes is verified end to end
on a simulator as the tenth pod in the same app, and it is the fastest and
smallest thing here: 0.2 MB of weights, and six synthetic hand-drawn strokes
recognized at **min 1.0 ms, median 2.0 ms, max 9.7 ms** natively — the maximum
being the first inference after the session was built. A wobbly loop came back an
**exact circle** (`semiMajor === semiMinor`, r 72.3), a 151 × 137 box came back a
**149.7 × 149.7 square**, a triangle drawn with a 176-unit base and 168.7-unit
legs came back **exactly equilateral**, a five-pointed star came back with
`pointCount: 5`, and a scribble came back as **nothing**, which is the half worth
having. The same stroke twice gave byte-identical geometry; the same stroke
translated and scaled ×1.7 gave the same class both times. Its Android half is the
third in this repo that has not been compiled, for the same reason as Gist's and
Redact's. Align is the eleventh pod in the same app, and it is the one model here
whose central claim is **not** verified: its 0.7 MB downloads (672,560 bytes in 13
files), the module binds, every property reads, the nine languages come off the
downloaded `refiner_config.json` rather than out of TypeScript, and all five
argument refusals fire — but **no transcript has ever been refined**, because
refining one needs Apple's on-device recognizer and a simulator cannot install it.
Measured rather than assumed: `SpeechTranscriber.isAvailable` is false,
`AssetInventory.status` answers `unsupported`, `installedLocales` is empty, and
the installation request throws `SFSpeechErrorDomain Code=1` even after a
successful `reserve`. Two real ordering bugs were found and fixed against the
device on the way to that answer — Apple's assets must be reserved before they can
be asked about, and reserved under the identifier
`SpeechTranscriber.supportedLocale(equivalentTo:)` returns rather than the one the
caller passed. So no latency, no word count and no boundary movement is quoted
anywhere for Align; upstream's 106.4 ms → 20.2 ms is attributed to upstream. Each
package's
README says exactly what was and was not exercised.

## Requirements

| | |
| --- | --- |
| Expo SDK | 57+ (`expo-modules-core` 57 is where the 2.0 macros live) |
| React Native | 0.75+ for `spm_dependency`; 0.83 in the example |
| iOS | **18.0+** with Clear or Clips (their Core ML artifacts' floors); 17.0+ for Voz, Uhm, Emo, Ear, Tongue, Gist, Redact, Shapes or Align alone. **Align itself needs iOS 26 at runtime** — `SpeechAnalyzer` is iOS 26 — but its pod builds at 17 and reports `isSupported: false` below 26, so installing it does not raise anyone else's floor |
| Xcode | 26 (`desert-ant-core` is `swift-tools-version: 6.2`) |
| Android | API 24+; `arm64-v8a` and `x86_64` only for Clear, Emo, Ear, Gist, Redact and Shapes — Tongue needs no native library and runs on any ABI |
| Expo Go | Not supported — these are native modules, so use a dev build |

Each package's bundled config plugin raises the iOS deployment target — and
Clear's, Emo's, Ear's, Gist's, Redact's and Shapes' also narrow the Android ABIs
to the two LiteRT ships — so add
whichever packages you use to `plugins` in your app config. The plugins only ever
raise, and the six that touch `build.gradle` defer to each other's block, so they
compose (there is a test that asserts it over all 720 orderings). Tongue's and
Align's touch `build.gradle` not at all, deliberately: Tongue has no native
library, so narrowing an app's ABIs on its behalf would take away devices it can
serve, and Align has no Android half to narrow. Align's plugin also declines to
raise iOS past 17 even though the model needs 26, for the same reason: an app is
given one deployment target, and taking it to 26 would cost every other installed
model its iOS 17–25 devices.

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
