# @desert-ant-labs/react-native-redact

On-device PII detection and **reversible** redaction for React Native and Expo:
text in, the same text with every name, address, email, card and national ID
replaced by a numbered placeholder out — plus the mapping needed to put the
originals back afterwards. 27 languages. Nothing leaves the device.

Wraps Desert Ant Labs' own [Redact](https://desertant.com/models/redact/) Swift
and Kotlin SDKs as an Expo module.

**iOS and Android.** Redact is the fifth model in this repo with two working
halves, after Clear, Emo, Ear and Gist: upstream publishes a Core ML export *and*
a LiteRT one, and `ai.desertant:redact` is on Maven Central. See
[Verified](#verified) for what that claim is and is not worth here.

## Install

```bash
npx expo install @desert-ant-labs/react-native-redact
```

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-redact"] } }
```

```bash
npx expo prebuild --clean && npx expo run:ios   # or run:android
```

The plugin raises the iOS deployment target to 17.0 — tied with Emo, Uhm, Ear,
Tongue and Gist for the lowest floor of any model here — and narrows the Android
ABIs to `arm64-v8a` and `x86_64`, which are the two LiteRT ships. Both only ever
raise or narrow, so they compose with the other Desert Ant plugins; pass
`restrictAbis: false` to keep your own ABI list.

## Use

```ts
import { Redact, restore } from '@desert-ant-labs/react-native-redact';

if (!Redact.isSupported) return;             // an ABI LiteRT does not ship

const redact = await Redact.load();          // ~12 MB on iOS, ~25 MB on Android
const r = await redact.redaction('Email Anna Kovács at anna@example.hu.');

r.redactedText;   // 'Email [GIVEN_NAME_1] [SURNAME_1] at [EMAIL_1].'
r.items[0];       // { label: 'GIVEN_NAME', original: 'Anna', placeholder: '[GIVEN_NAME_1]',
                  //   confidence: 1, start: 6, end: 10 }

redact.release();
```

`redactedText` is the string that may leave the device. `items` is the string
that may not — `original` is the personal data itself.

### The round trip is the product

```ts
const r = await redact.redaction(userText);
const reply = await myLLM.rewrite(r.redactedText);   // sees only [EMAIL_1], [GIVEN_NAME_1], …
const final = restore(r, reply);                     // originals filled back in
```

Placeholders are bracket-delimited and numbered, so none is a prefix of another,
every occurrence is substituted, and the order of the items does not matter.
`restore` is **pure, synchronous and needs no model** — it would answer on a
device that had never downloaded a weight.

It is *ported* rather than bound, which is the opposite of the choice
`channelTopics` makes in `packages/gist`, and for the opposite reason: that is
probability arithmetic a third implementation could get subtly and silently
wrong, while this is a literal substitution that `String.replacing` in Swift and
`String.replace` in Kotlin both already agree on. Porting it means the call needs
no handle and no trip back across the bridge carrying the personal data that was
just brought over it.

### Highlighting in place

`start` and `end` are **UTF-16 code-unit offsets** — the units
`String.prototype.slice` uses — so no conversion is needed:

```ts
for (const item of r.items) {
  text.slice(item.start, item.end) === item.original;   // always
}
```

Items come back in document order and never overlap.

### Choosing what to mask

```ts
await redact.redaction(text, { labels: ['EMAIL', 'PHONE', 'CREDIT_CARD'] });
await redact.redaction(text, { minimumConfidence: 0.8 });
```

`Redact.labels` is all 22 categories and `Redact.defaultLabels` is the 21 that
are redacted when you name none — everything except `ORG`, because a company is
not a natural person. `ORG` is still *detected*, so that a company name is
recognised as one instead of being mislabelled `SURNAME`; opt in by naming it.

Both lists are read off the native binary, so gate a label picker on them.

**A typo is refused rather than ignored.** Upstream's binding resolves label
names with `compactMap(Label.init(rawValue:))`, which drops a name it does not
recognise: one typo silently widens the redaction, and a set of nothing but typos
silently redacts nothing at all. Both are privacy bugs that look like nothing. So
an unknown label raises `ERR_INVALID_ARGUMENT`, and so does `labels: []` — omit
the option instead.

`minimumConfidence` likewise raises `ERR_INVALID_ARGUMENT` outside `0..1`, where
upstream would quietly clamp it. A clamped threshold is a redaction policy that
is not the one you asked for.

### Two kinds of detection, and only one of them has a score

`Redact` is a hybrid, and the halves behave differently:

- A six-layer multilingual BIOES token classifier (~23 M parameters, XLM-R
  lineage) finds the **contextual** categories — names, cities, streets,
  organisations. This is what `minimumConfidence` tunes.
- In front of it, a deterministic layer of regexes and real checksums (Luhn,
  ISO-13616 IBAN, ISO-7064, per-country national IDs) **owns** the structured
  ones — `EMAIL`, `URL`, `IP_ADDRESS`, `CREDIT_CARD`, `SSN`, `BANK_ACCOUNT`,
  `ROUTING_NUMBER`, `TAX_ID`, `GOVERNMENT_ID`, `PASSPORT`, `DRIVERS_LICENSE`,
  `IMEI` — and reports them at confidence **exactly 1**, whatever the threshold
  says.

Raising `minimumConfidence` therefore trims names and cities rather than cards
and IBANs.

**But do not read the score backwards.** A deterministic detection always reports
exactly `1`; a `1` does not mean a deterministic detection. Both directions of
that were observed on the simulator: a confident neural `GIVEN_NAME` comes back at
exactly `1.0` because a saturated softmax rounds there in a `Double`, and several
of upstream's address post-processing stages build their spans through
`Span(start, end, label)`, whose `score` defaults to `1.0`. The **label** is what
says how something was found.

This package does not export the owned-label set, which would make that branch
easy to write: `Deterministic.owned` is `internal` upstream, and a copy here would
be right until the next revision moved a label across the line — the same refusal
`Tagging.threshold` makes in `packages/gist`.

### Display names are iOS-only

```ts
Redact.labelDisplayNames;             // iOS: all 22 — Android: {}
Redact.labelDisplayNames[item.label] ?? item.label;   // the safe read
Redact.displayName('IP_ADDRESS');     // 'IP address' — throws off iOS
```

`Label.displayName` is a Swift computed property and `ai.desertant:redact`
publishes nothing equivalent: its whole `Labels` object is two sets of bare
strings. `Redact.displayName` therefore refuses with `ERR_UNSUPPORTED_PLATFORM`
where there are none rather than deriving one from the slug — upstream's own
names include "IMEI", "SSN", "Organisation" and "IP address", none of which
title-casing produces, and a wrong display name is invisible in exactly the place
it matters, which is a privacy UI telling someone what was masked.

Gate on `Redact.labelDisplayNames`, which is read off the binary, rather than on
`Platform.OS`.

## API

| | |
| --- | --- |
| `Redact.isSupported` | True on iOS and on Android with a LiteRT ABI. |
| `Redact.unsupportedReason` | Why, in a sentence, or null. On Android it names the device's ABIs. |
| `Redact.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Redact.modelRevision` | The pinned model revision, or null. |
| `Redact.modelRepo` | The Hub repo the weights come from, or null. |
| `Redact.labels` | All 22 categories, read off the binary. |
| `Redact.defaultLabels` | The 21 redacted when you name none (no `ORG`). |
| `Redact.labelDisplayNames` | Label → human name. iOS all, Android none. |
| `Redact.displayName(label)` | One human name; throws off iOS. |
| `Redact.defaultMinimumConfidence` | `0.6`. Neural detections only. |
| `Redact.load(options?)` | Create, download and prepare. |
| `Redact.create(options?)` | Create without touching the network. |
| `redact.isDownloaded()` | Whether redaction can run offline. Synchronous. |
| `redact.warm(onProgress?)` | Download and build the session. |
| `redact.download(onProgress?)` | The same call — see below. |
| `redact.redaction(text, options?)` | Text in, a `Redaction` out. |
| `redact.release()` | Hand the model back. |
| `restore(redaction, processed)` | Put the originals back. No model, synchronous. |

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_INVALID_ARGUMENT`, `ERR_RELEASED`,
`ERR_UNSUPPORTED_PLATFORM`. There is no `ERR_AUDIO_*` here — the input is a
string, so nothing can fail to decode.

## Things the types cannot tell you

- **It is a reduction in exposure, not a guarantee.** Upstream measures **88.8%
  recall and 99.6% precision** on its own benchmark — the best of the on-device
  field it publishes, ahead of Rampart (61.4% recall) and OpenAI's privacy filter
  (60.2%) and behind GLiNER-PII (91.1% recall at 90.4% precision and 2.3 GB).
  Those are upstream's numbers, measured by upstream. None of them is 100%.
- **Not masking ordinary words matters as much as catching real ones.** A false
  positive corrupts the text whatever reads it next. Upstream reports 94.1% of
  rows untouched on an 11,528-row negative set built to provoke exactly that.
- **Redaction reports no progress.** Upstream's `redaction(of:)` takes no handler
  on either platform, so the only phase a `Redact` emits is `loadingModel`, and no
  phase was added to `ModelPhase` in `packages/core`. `onProgress` on a
  `redaction` still fires — for the load the first call does implicitly.
- **`warm` and `download` are the same call.** Upstream exposes one entry point
  that downloads *and* builds the session, so unlike Clear and Voz there is no
  download-only step. Both names exist so the nine models read alike.
- **Blank input is an answer, and it never reaches the weights.** Whitespace-only
  text comes back unchanged with no items and without loading the model. Neither
  upstream SDK guards this — unlike Gist, where the two disagree and one side had
  to be picked, this is straightforwardly a decision of this package's, taken on
  both platforms together. It is a safe one: the deterministic recognizers match
  nothing in whitespace and the tagger has no token to label. What it buys is a
  text field wired straight to `redaction` costing nothing while it is empty,
  which for this model is the ordinary way to use it.
- **The two platforms download different artifacts and different amounts.**
  `redact.mlmodelc` is ~12 MB; `redact.tflite` is ~25 MB. Same model, same
  revision, two exports.
- **`modelRevision` and `modelRepo` are constants on Android.**
  `ai.desertant:redact` publishes `Redact`, `Redaction`, `RedactionItem`,
  `Options`, `Labels` and `RedactException`, and nothing to read the catalog from.
  The Apple half reads `RedactModel`.
- **Android reports progress as phase boundaries, not fractions.**
  `ai.desertant:redact`'s `download()` takes no callback, so it emits 0 on
  entering `loadingModel` and 1 on leaving.
- **`defaultMinimumConfidence` is mirrored, not read.** It is a default argument
  in a Swift initializer and a Kotlin data class — not a constant either SDK
  exposes. `labels`, `defaultLabels` and `labelDisplayNames` *are* read off the
  binary.
- **A placeholder-shaped string in the input is not escaped.** If the text you
  pass already contains `[EMAIL_1]`, `restore` will fill an original into it.
  That is upstream's behaviour on all three platforms and this package does not
  paper over it.
- **Every async native call returns `Void`.** The result comes back through a
  synchronous member on the shared object. That is not a style choice — see
  below.

## Every async call returns nothing, on purpose

This package's native surface has an unusual shape: `redaction` is a `@JS async`
function that returns `Void` and stores its result on the shared object under the
caller's job id, and the result is read back through a **synchronous**
`takeRedaction`.

It is the fourth Expo Modules 2.0 limit this repo has had to design around. **A
`@JS async` function's return value can be encoded off the JavaScript thread**,
which segfaults the runtime — the crash lands on
`com.apple.root.user-initiated-qos.cooperative` rather than on
`com.facebook.react.runtime.JavaScript`, and `@JavaScriptActor` does not prevent
it, because the return value is encoded *after* the actor hop the annotation
governs. It has now been reproduced in four packages: Ear returning `[String]`,
Clear in `Record.encode`, Emo in `JavaScriptValuesBuffer.deinit` on an array of
records, with `HadesGC::youngGenCollection` killing the process later as the
downstream symptom. "Small values are safe" is not a reading anyone should still
be holding.

`docs/architecture.md` draws the general rule out of those: split "do the work"
from "hand the result over" whenever the result is large or its encoding is not a
single scalar. A redaction is three strings and three numbers per detection and a
paragraph of contact details carries a dozen detections, so the rule applies here
without any judgement about how many records is too many. A synchronous `@JS`
member runs on the JavaScript thread by construction.

The job id is what makes it safe rather than merely lucky: results are keyed by
it and removed on read, so two concurrent `redaction` calls on one model cannot
take each other's answer. For this model that removal is worth naming twice —
what is sitting in that dictionary is the caller's personal data in the clear, so
it is removed as it is read and `release()` drops the rest immediately rather than
leaving it to a collector.

`restore` is synchronous for the same reason on top of the obvious one. It is
string substitution, and a synchronous return cannot hit the hazard at all.

## SwiftUI also has a `Label`

`ios/RedactLabel.swift` is one typealias in a file with one import, and both
halves of that are deliberate. Redact's category enum is spelled `Label` and so is
SwiftUI's view; any file importing `ExpoModulesCore` gets SwiftUI transitively, so
the bare name does not compile:

```
error: 'Label' is ambiguous for type lookup in this context
note: found this candidate (Sources/Redact/Label.swift:5:13)
note: found this candidate (SwiftUI.Label:2:15)
```

`Redact.Label` is not the fix — the module is named `Redact` and so is the class
inside it, so a module-qualified spelling resolves to the class first and then
fails to find a member type on it. A file importing only `Redact` has no SwiftUI
in scope, so the name is unambiguous there; everything else in the pod refers to
`PIILabel`.

## Verified

Driven on an iOS 26 simulator (iPhone 17 Pro Max) with a dev build, alongside
Clear, Voz, Clips, Uhm, Ear, Emo, Tongue and Gist — the ninth pod in an app that
already carried eight.

The module binds and reports, before anything touches a model:

```
[redact] isSupported=true nativeCore=3.1.0 revision=v0.4.0 repo=desert-ant-labs/redact
         minConfidence=0.6 labels=22 default=21 displayNames=22
```

which exercises the `@ExpoModule` registration and every `@JS` property —
including the two that are not scalars, `labels` as a `[String]` getter and
`labelDisplayNames` as a `[String: String]` one, both synchronous and so encoded
on the JavaScript thread by construction — plus `createModel` returning a
`@SharedObject`, its synchronous `isDownloaded()`, and `release()`.
`Redact.displayName('IP_ADDRESS')` returns `"IP address"` and `'ORG'` returns
`"Organisation"`, which is the pair a slug could not have produced.

**Loading.** The ~12 MB download plus the Core ML session build took **49.9 s**
cold. Three later launches with the weights already on disk took **46.7 s**,
**39.3 s** and **46.7 s** — but every one of those was measured while Emo
(35.4–37.0 s), Ear (40.1–45.0 s) and Uhm (55.4–55.5 s) were building their own
sessions on the same mount, so read them as an upper bound under contention
rather than as this model's session-build cost.

**Redaction, and the round trip.** One sentence of nothing but contact details:

```
in   Email Anna Kovács at anna.kovacs@example.com or call +36 1 234 5678; her card is 4111 1111 1111 1111.
out  Email [GIVEN_NAME_1] [SURNAME_1] at [EMAIL_1] or call [PHONE_1]; her card is [CREDIT_CARD_1].

GIVEN_NAME   "Anna"                     -> [GIVEN_NAME_1]   1.000  @6..10
SURNAME      "Kovács"                   -> [SURNAME_1]      1.000  @11..17
EMAIL        "anna.kovacs@example.com"  -> [EMAIL_1]        1.000  @21..44
PHONE        "+36 1 234 5678"           -> [PHONE_1]        0.920  @53..67
CREDIT_CARD  "4111 1111 1111 1111"      -> [CREDIT_CARD_1]  1.000  @81..100
```

`restore(r, r.redactedText)` returns the input **character for character**, and
restoring into a reply that mentions the five placeholders gives back
`Anna / Kovács / anna.kovacs@example.com / +36 1 234 5678 / 4111 1111 1111 1111`.
Every sample in every run round-tripped exactly, including the narrowed and
raised-threshold variants. Items are in document order, non-overlapping, unique
in their placeholders, every placeholder present in the output and every original
absent from it, and `text.slice(start, end) === original` for all of them.

**Latency.** The first `redaction` after a load costs **620–641 ms** natively
over three runs (571, 624, 641 ms). Steady state through the app's own debounced
text field is **574–584 ms end to end from JavaScript**, bridge hop included, over
five measurements (574, 576, 582, 582, 584). The 745-character, 134-word sample
transcript — five windows of the 256-token model — takes **464–477 ms**. There is
no warm/cold cliff here the way there is for the audio models: the windowed
transformer pass dominates and it is roughly linear in length.

**Multilingual, four of the 27.** One person's details, no language passed in:

| | Found |
| --- | --- |
| `en` | GIVEN_NAME `Anna`, SURNAME `Kovács`, EMAIL, PHONE `+36 1 234 5678`, CREDIT_CARD |
| `es` | the same five, identically |
| `de` | SURNAME `Schreib`, GIVEN_NAME `Anna`, SURNAME `Kovács`, EMAIL, PHONE — **no card** |
| `hu` | SURNAME `Kovács`, GIVEN_NAME `Annának`, EMAIL, PHONE `+36` — **no card** |

The Hungarian `Annának` is the inflected dative and the right span for that
language. The two misses are real and are recorded rather than smoothed over: the
German sentence labels the imperative verb *Schreib* as a `SURNAME` and loses the
card the English and Spanish ones both catch, and the Hungarian one catches only
`+36` of the phone number. Four sentences are four sentences — but they are
enough to show that the 88.8%/99.6% upstream publishes is a distribution, not a
promise about any particular string.

**Options.** `labels: ['EMAIL']` returns exactly one item and it is the email.
Adding `ORG` to the default 21 changes nothing on this sentence (5 items, 0 of
them `ORG`) and `Redact.defaultLabels` is 21 while `Redact.labels` is 22.
`minimumConfidence: 1` takes the same sentence from 5 items to 3, lowest
surviving confidence **0.920**. Blank input returns 0 items with the text
unchanged and never loads the model. `minimumConfidence` of −0.1 and 1.1, an empty
`labels` array, and the misspelling `EMIAL` are all rejected with
`ERR_INVALID_ARGUMENT` before reaching native.

**Precision, on the one sample that should come back untouched.** "The deployment
finished at noon and the dashboard looks fine." → **0 items**, 576 ms, text
unchanged. The 134-word sample transcript, likewise: **0 items**. A masker that
damaged either would be doing harm rather than work.

**Three consecutive self-test runs ended `[selftest] all prepared models
passed`**, so adding this package breaks none of the eight before it — and
`~/Library/Logs/DiagnosticReports` gained **no new crash report** across those
three runs and a fourth interactive session. That is evidence for the
`Void`-returning shape, not proof of it: the defect it avoids is a race, and a
race that did not fire is not a race that cannot.

Off-device, **50 Jest tests** cover the argument guards, the no-native-module
path, the label refusals, the two-step do-the-work-then-take-the-result shape, the
job-id keying, `restore`'s substitution and order-independence, the released-handle
path, the error mapping, the read-from-the-binary label lists, and the config
plugin — whose composition test now runs all **120** orderings of Clear's, Emo's,
Ear's, Gist's and Redact's `abiFilters` writers and asserts one block comes out.

### Two upstream behaviours worth reporting

Both were found by tapping the sample chips, which is where they would be found in
production.

**A deterministic `IP_ADDRESS` can lose to the address post-processing, and the
result leaks.** These two sentences contain the same IP in the same position:

```
"The server at 192.168.1.14 is down; ping bob.smith@acme.co.uk or SSN 123-45-6789."
  -> "The server at [IP_ADDRESS_1] is down; ping [EMAIL_1] or SSN [SSN_1]."   (3 items, all 1.000)

"The box at 192.168.1.14 logged in from https://example.com."
  -> "The box at [BUILDING_NUMBER_1].168.1.14 logged in from [URL_1]."        (2 items)
```

In the second, only the first octet is masked — as a `BUILDING_NUMBER`, by the
address pipeline — and `.168.1.14` is left in the text. It reproduces with and
without a trailing IMEI. `Pipeline.resolve` is supposed to drop an ML span that
conflicts with a deterministic one on a different label, so from the outside this
looks like the address post-processing (`attachBuildingNumbers` / `redactUsStreet`)
running after that resolution rather than before it. Nothing here can work around
it more precisely than saying so.

**A `Deterministic.owned` label can arrive with a sub-1 score.** The same
sentence's IMEI came back at **0.900**, not 1.0 — the hybrid resolver can relabel
an ML span into an owned label and keep its score. That, together with confident
neural spans saturating to exactly 1.0, is why this package asserts nothing about
provenance from either field and why the self-test logs those numbers instead of
checking them.

**One more, smaller.** "Ship it to Dr. Maria Silva, 42 Rue de la Paix, Apt 3B,
75002 Paris." comes back as `[GIVEN_NAME_1] it to Dr. [GIVEN_NAME_2] [SURNAME_1],
42 Rue de la Paix, [SECONDARY_ADDRESS_1], 75002 [CITY_1].` — the sentence-initial
"Ship" is masked as a given name, and the street and postal code are not masked at
all. Five items, 582 ms, round trip exact.


**What was not verified.**

- **Android was not built or run.** There is no usable Android SDK on this
  machine — `$ANDROID_HOME` points at a directory with no `platforms` or
  `build-tools`, and there is no `sdkmanager` to fix that with — so this
  package's Android half **has not even been compiled**. It is written against
  `ai.desertant:redact`'s published API as read from the `desert-ant-core`
  checkout, and it should be treated as unproven until it builds. Take no comfort
  from the other packages' READMEs saying "compiles but has not been run": that
  claim is itself unverified and is being corrected separately.
- **No accuracy claim of this package's own.** Upstream's 88.8% recall / 99.6%
  precision, its 94.1% untouched-negatives figure and its comparison table are
  upstream's measurements on upstream's benchmark. A handful of sentences is a
  handful of sentences, and a redaction benchmark is precisely the kind of thing
  that cannot be run from an example app.
- **Latency is a simulator's.** A simulator has no Neural Engine, so these are CPU
  numbers on a windowed six-layer transformer — the shape where that gap is
  largest in this family. Treat them as an upper bound, not a device figure.
- **27 languages, four tested.** The sentences below are English, Spanish, German
  and Hungarian. Nothing here says anything about Maltese or Irish, which upstream
  names as the weakest of the 24 EU languages it covers.
