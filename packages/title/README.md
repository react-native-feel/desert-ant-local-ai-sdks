# @desert-ant-labs/react-native-title

On-device titles and descriptions for React Native and Expo. Give it a passage of
text — a clip transcript, a note, an email, a page — and it gives back a factual
title of three to eight words and a one- to two-sentence description saying what
that passage *is*. Nothing is sent anywhere.

**Read this before you plan around it.** This is the one package in this repo
whose central call does not work, and the reason is neither a device, a download
nor a bug:

| | |
| --- | --- |
| `Title.canDownloadWeights` | **true** on Apple — the ~280 MB model folder downloads, verifies and reports its path |
| `Title.isSupported` | **false** — `describe()` throws `ERR_UNSUPPORTED_PLATFORM`, on every device |

Title is MLX-backed, and MLX is behind a SwiftPM **package trait** in
`desert-ant-core` that a CocoaPods app has no way to enable. Generation is
therefore compiled out of the binary this package links. The whole account,
including what was tried, is in
*[The MLX trait, and why half of this package is dark](#the-mlx-trait-and-why-half-of-this-package-is-dark)*.

What is left is real and is exercised end to end: the catalog half. It downloads,
verifies and inspects the model folder, and `resolvedDirectory()` is exactly the
path upstream's own `Titles(directory:)` takes — so an app whose native code *does*
have the trait can use this package to get the files there.

Wraps [Desert Ant Labs' Title model](https://desertant.com/models/title/) —
`Sources/Title` in the `desert-ant-core` Swift package. **Apple only.** Upstream's
manifest records the Kotlin and JavaScript SDKs as `none`, and `Package.swift`
marks the model `appleOnly: true` with a comment saying why — *"`Title` is MLX,
which has no other platform, and a product promising an artifact that cannot load
is worse than its absence."*

The model is a **350M-parameter Granite fine-tune quantized to 6 bits**, and the
folder is **293,658,528 bytes in seven files** — measured against the Hub at the
pinned `v0.1.0`, not estimated. That makes it the third-largest download in this
family, after Voz's ~490 MB and Clips' ~288 MB.

## Install

```sh
npx expo install @desert-ant-labs/react-native-title
```

Add the config plugin to `app.json`:

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-title"] } }
```

Then `npx expo prebuild` and build a dev client. Expo Go cannot load it — this is
a native module.

The plugin does one thing your own config would not otherwise say: it raises the
iOS deployment target to **17.0**. For Title that number is three floors at once —
the `desert-ant-core` package floor, MLX's own floor, and this pod's — and they
coincide for a reason rather than by luck; see
*[iOS 17 is Title's fault](#ios-17-is-titles-fault)*. It touches no
`build.gradle`, because there is no Android half to touch.

## Use

```ts
import { Title, cardShape } from '@desert-ant-labs/react-native-title';

// Gate the download on this, not on `isSupported`.
if (!Title.canDownloadWeights) return;

const title = await Title.load({ onProgress: setProgress });   // ~280 MB
title.resolvedDirectory();     // the folder a native `Titles(directory:)` wants
title.installedBytes();        // 293,658,528
title.missingFiles();          // []

// Gate generation on this. It is false in every React Native build today.
if (Title.isSupported) {
  const card = await title.describe(clip.text);
  card.title;         // "Filming a two-person podcast on iPhone"
  card.description;   // one or two sentences
  cardShape(card).matchesPublishedShape;   // did the model keep its own format?
}

title.release();
```

### The two booleans, and why there are two

Every other package in this family answers one question: is this model supported
here. This one has a working half and a missing half, so it answers two.

`canDownloadWeights` is about the **platform**. True on Apple, false everywhere
else, permanently — MLX is Apple silicon only.

`isSupported` is about the **build**. False because `desert-ant-core`'s `MLX`
package trait was off when this binary was compiled, so `Sources/Title/Title.swift`
compiled without its `#if MLX` half and upstream's `Titles` actor has no public
initializer at all.

`mlxTraitEnabled` is that single fact, exposed on its own, computed natively from
`canImport(MLXLMCommon)` rather than written down — so if the trait ever becomes
reachable, this package reports it without anyone editing a constant.

Gate your download on the first and your `describe` on the second. `Title.create()`
deliberately gates on `canDownloadWeights`, which is the one place this package
diverges from its eleven siblings: refusing to construct a model because the build
cannot generate would hide a working download behind a missing generator.

### `describe` refuses; it does not return an empty card

```ts
await title.describe(passage);
// DesertAntError: ERR_UNSUPPORTED_PLATFORM
//   This build cannot generate: desert-ant-core's `MLX` package trait is off, so
//   `Sources/Title/Title.swift` compiled without its `#if MLX` half and `Titles`
//   has no public initializer. …
```

This is a design decision and it is the most important one in the package. A
method that quietly returned `{ title: '', description: '', isEmpty: true }` would
compile, would pass a smoke test, and would ship — and a card model returning an
empty card is a *documented ordinary outcome* upstream, not an error, so nothing
downstream would flag it. So the refusal is loud, it carries a code an app can
branch on, and it names the trait.

Nothing is reimplemented either. There is no prompt in this package, no parser, no
fallback that takes the first sentence of the passage.

### `cardShape` checks the format, with no model

```ts
const shape = cardShape(card);
// { titleWordCount: 6, titleWordsInRange: true,
//   titleEndsWithPunctuation: false,
//   descriptionSentenceCount: 1, descriptionSentencesInRange: true,
//   hasEmoji: false, hasHashtag: false, matchesPublishedShape: true }
```

Pure arithmetic over a card you already have: no model, no bridge hop, no
download. The same kind of call as `timestampShift` in Align, `channelTopics` in
Gist and `restore` in Redact — something the SDK can answer on a device that has
never resolved a weight.

It exists for the reason Align's `timestampShift` exists, which is that this
model's published claim is checkable and taking it on trust would be a choice. The
model page states the shape in one sentence — *"A title of three to eight words
with no final punctuation, and a description of one or two sentences, from one
call"* — and states the caveat in the next: Title *"is in internal testing and its
card carries no quality figures … the model sometimes opens a description with a
stock phrase its own instruction forbids. Read the output before it reaches a
user."* An app about to put a generated title in front of somebody can run this
first and fall back to its own naming when the answer is off-shape.

**The thresholds are the product page's, not upstream's source**, and that is
stated in the code as well as here. They could not be read off the binary: they
live inside `Titles.prompt`, which is `static let` with no access modifier and
therefore internal to the `Title` module.

It is not a quality score. A card can pass every check and describe the wrong
passage.

### The join this model is for, and why it is not demonstrated

The published pipeline is Voz transcribes → Clips picks the moments → Title names
them, and upstream makes the join explicit: `Titles` carries `card(for clip: Clip)`
and `cards(for clips: [Clip])`, and `Sources/Title` depends on `Transcript` for
exactly that reason. The product page sells it — *"Clips finds the moments in a
recording; Title names them."*

This repo has Voz and Clips, both working, and the example app produces a real
ranked clip list. The join still cannot be shown, because the naming step is the
half that is dark. What the example app does instead is put the *text of a real
clip* in front of `describe` and show the refusal on realistic input.

## API

```ts
class Title {
  // Platform and build
  static readonly isSupported: boolean;           // false — see above
  static readonly canDownloadWeights: boolean;    // true on Apple
  static readonly mlxTraitEnabled: boolean;       // false
  static readonly unsupportedReason: string | null;

  // Read off desert-ant-core's catalog, not restated here
  static readonly nativeCoreVersion: string | null;   // '3.1.0'
  static readonly modelId: string | null;             // 'title'
  static readonly modelRepo: string | null;           // 'desert-ant-labs/title'
  static readonly modelRevision: string | null;       // 'v0.1.0'
  static readonly revisionIsPinned: boolean;          // true — a tag
  static readonly modelSummary: string | null;
  static readonly modelFiles: string[];               // the seven
  static readonly weightsFileName: string | null;     // 'model.safetensors'
  static readonly osFloorIOS: number;                 // 17
  static readonly defaultMaxTokens: number;           // 96

  static load(options?: TitleLoadOptions): Promise<Title>;
  static create(options?: TitleLoadOptions): Title;   // no network

  isDownloaded(): boolean;
  resolvedDirectory(): string;
  missingFiles(): string[];
  installedBytes(): number;

  warm(onProgress?): Promise<void>;       // download + verify
  download(onProgress?): Promise<void>;   // the same call
  prepare(onProgress?): Promise<void>;    // the same call

  describe(text: string, options?: DescribeOptions): Promise<Card>;

  release(): void;
}

function cardShape(card): CardShape;
```

`TitleLoadOptions` is `{ directory?, maxTokens?, onProgress? }`. `Card` is
`{ title, description, isEmpty, processingSec, modelRevision, modelRuntime }`.

## Things the types cannot tell you

### The MLX trait, and why half of this package is dark

Title is the only model in `desert-ant-core` that does not run through
`InferenceSession`. It runs on MLX, and the reason is measured rather than
architectural: writing a title is short autoregressive decode, which the Neural
Engine is bandwidth-bound for. `Sources/Title/Catalog.swift` carries the numbers
from the commit that removed the Core ML path — Core ML's best showing was its CPU
one at **213 ms to first token against MLX's 55 ms, 86 tok/s against 447, and 1921
MB resident against 635**, and `CPU_AND_NE` could not build an execution plan at
all.

MLX comes with `MLXHuggingFace`, whose `#huggingFaceLoadModelContainer` is a
**macro** — so it pulls swift-syntax and host macro plugins into the graph. Upstream
put it behind a SwiftPM package trait (SE-0450) rather than make every Linux,
Android and wasm consumer build that:

```swift
.trait(name: "MLX", description: "MLX-backed generation (the Title model). "
    + "Apple platforms only; pulls mlx-swift-lm and swift-transformers into the graph.")
```

Every mlx product edge carries `condition: .when(traits: ["MLX"])`, so SwiftPM
prunes the whole dependency when nothing enables it. Without it the `Title` target
still compiles — `Card`, the prompt and the parser are outside the `#if MLX` — but
`Titles` has no public initializer, which upstream chose deliberately so that *"a
consumer that forgot the trait fails at compile time instead of mis-building."*

**A trait is enabled in exactly two places**: a consuming `Package.swift`
(`.package(url: ..., traits: ["MLX"])`, which is what the model page tells a Swift
developer to write) and `swift build --traits MLX`. A CocoaPods app is neither.
Four routes were checked before this package was written:

1. **React Native's SPM bridge.** `scripts/cocoapods/spm.rb` in react-native 0.86.3
   declares `def dependency(pod_spec, url:, requirement:, products:)`. Four
   parameters, no traits, and `add_spm_to_target` sets exactly `repositoryURL`,
   `requirement` and `product_name`. There is nothing to pass.
2. **A `post_install` hook.** The Xcode project format has no field for it.
   `grep -ril trait` over the whole of **xcodeproj 1.27.0** — the gem CocoaPods
   uses to write `Pods.xcodeproj` — returns nothing at all, so neither
   `XCRemoteSwiftPackageReference` nor `XCSwiftPackageProductDependency` can carry
   one.
3. **Xcode.** `grep -ril enabledTraits` over **Xcode 26.4.1 (17E202)** matches
   exactly two files, both of them
   `SwiftPM.framework/…/PackageDescription.swiftmodule/*.swiftinterface` — the
   *manifest* API. No IDE framework mentions it, and `xcodebuild -help` lists no
   trait flag among its fifteen package options.
4. **The command line.** `swift build --traits MLX` exists and works — it is right
   there under `TRAIT OPTIONS` — but it applies to the **root** package of a
   SwiftPM build. The root here is an Xcode app target, built by `xcodebuild`.

The one construction that could work was considered and rejected on its merits: a
small local SwiftPM package vendored in this repo that declares
`.package(url: desert-ant-core, traits: ["MLX"])` and is bridged by path — spm.rb
does handle `XCLocalSwiftPackageReference`, and SwiftPM unions the traits its
dependents request. It is rejected because **a trait is a property of the package,
not of one product**: enabling `MLX` for `desert-ant-core` enables it for every
consumer of the single `DesertAntCore` pod, which is all twelve models. An app
installing only Shapes — 0.2 MB, no transformer anywhere near it — would clone
mlx-swift, mlx-swift-lm, swift-transformers and swift-syntax and build host macro
plugins to link it. That is precisely the cost upstream's manifest says the trait
exists to avoid, and paying it for all twelve to switch on one is the wrong trade
for a model that, even switched on, **would still not run on a simulator**: MLX is
Metal on Apple silicon, and an iOS Simulator is not that.

**The fix, when it exists, is small.** Enable the trait by whatever means exists
then, and `#if canImport(MLXLMCommon)` turns the generating branch of
`ios/TitleModelObject.swift` on by itself. Nothing else changes — not the
TypeScript, not the records, not the podspec, not this README's API section.

### The portable half is not as portable as its comment says

Upstream's header on `Sources/Title/Title.swift` says the module still compiles
without the trait because *"`Card`, the prompt, and `parse` are portable and tested
everywhere"*. That is true about the `#if`, and misleading about reachability.

`static let prompt` and `static func parse(_:)` are both written with **no access
modifier**, which makes them internal to the `Title` module. `public actor Titles`
therefore has no public member at all without the trait. Of the portable half, only
`Card` crosses the module boundary — and a `Card` with no way to make one is a
struct.

So this package binds no parser. Porting `parse` into TypeScript was considered and
dropped: it is a twenty-line format reader for raw model text, and with generation
absent there is no raw model text on this side of the bridge for it to read. It
would have been decoration. `cardShape` is deliberately a *different* thing — it
reads a finished `Card`, not a raw reply.

The prompt is not restated here either, and that is a harder rule than it looks.
Upstream's own docs record what happens when a copy drifts: the previous version of
that property *"was a different string from the one training used"*, so the shipped
model *"was served an unseen prompt on every call"* and a rule the prompt spent four
lines on had never appeared in a training example. The product page says the same
thing to developers — *"use the SDK's own prompt: the model was trained on one
instruction, and a reworded one gets worse output."*

### iOS 17 is Title's fault

Every model in this repo needs iOS 17, and Title is the reason.

MLX has no build below iOS 17 / macOS 14, and — unlike Clips' iOS 18 — that is a
**dependency** floor rather than an artifact one. `@available` is per-declaration
and cannot satisfy a manifest-level constraint: SwiftPM simply refuses to resolve
`MLXLLM` (macOS 14) into a macOS 13 package. So `desert-ant-core`'s whole
`platforms:` line had to rise, and Package.swift is blunt about the cost:

> That costs iOS 16 / macOS 13 for Apple consumers that never enable MLX —
> accepted deliberately.

`Sources/Title/Catalog.swift` declares `osFloor = OSFloor.mlx`, so this pod's
17.0, the package floor's 17.0 and the model's own 17.0 are all the same number
for once. `Title.osFloorIOS` reads it off the catalog rather than restating it.

### Nothing is downloaded — by upstream

The model page is explicit: *"Nothing is downloaded. Ship the model files in a
folder with the app and pass that folder to `Titles`; the other models fetch their
weights on first use, this one doesn't."* That is a statement about upstream's
`Titles(directory:)`, which takes a folder you populated and never fetches.

It is **not** true of the catalog. `TitleModel` conforms to `ModelDeclaration`, so
it inherits `resolve`, `isAvailable` and `distribution` from the shared extension,
and its `distribution` names `desert-ant-labs/title` at `v0.1.0` with a seven-file
Apple manifest. Those seven files exist at that tag. This package uses that path,
which is why `load()` works at all — and it is the difference between this package
being installable today and being a stub.

### The revision is a tag, and that is checked rather than assumed

`v0.1.0`, so `Title.revisionIsPinned` is **true** — the opposite of Align's, which
resolves the branch `main`.

It is still computed rather than hardcoded, and upstream's own catalog note says
why. The entry used to carry a justification for an exception that had already
expired, and `ModelCatalogTests` does not cover Title, *"so nothing here would have
caught the staleness."* A value that is read cannot go stale quietly.

### Two arguments are refused that upstream accepts

Both refusals exist because the alternative is a confident-looking wrong answer
rather than an error, which is the class of behaviour this repo refuses on
principle.

- **An empty or whitespace-only passage.** `describe` is
  `prompt.replacingOccurrences(of: "{clip}", with: text)`, so an empty one produces
  a prompt that ends `PASSAGE:` and nothing else — and a 350M instruct model
  answers that with a plausible invented title. Refused on both sides of the
  bridge.
- **A `maxTokens` that is not a positive count.** Upstream's
  `init(directory:maxTokens: Int = 96)` hands it straight to
  `GenerateParameters(maxTokens:)`, which stops the iterator at that count with no
  check, so `0` ends the decode before the first token and yields an empty `Card`
  — indistinguishable from a model that declined.

Deliberately **not** refused: a very long passage. Upstream declares no context
limit anywhere this SDK can read — the window is the base model's, in `config.json`
inside the downloaded folder, not in any Swift constant — and a cap invented here
would silently drop the end of a passage.

### Progress reports one phase and invents none

`loadingModel`, with a true byte fraction from `DownloadProgress` over the seven
files. That is the whole set.

There is deliberately no `generating` phase. Upstream's decode loop is
`for await generation in stream` over `MLXLMCommon.generate`, which yields text
chunks and no denominator — there is no total to be a fraction of, and a phase that
could only ever report `0` and `1` would be a progress bar pretending to be one.
`ModelPhase` in `@desert-ant-labs/react-native-core` gains nothing for this model.

### Every async call returns nothing, on purpose

Both `prepare` and `describe` are `Promise<void>`; the card comes back through the
shared object's synchronous `takeCard(jobId)`.

A `@JS async` function's return value can be encoded **off** the JavaScript thread,
which segfaults the runtime — `@JavaScriptActor` does not prevent it, because the
encode happens after the actor hop the annotation governs. It has been reproduced
on a bare `[String]` (Ear), in `Record.encode` (Clear), and in
`JavaScriptValuesBuffer.deinit` on an array of records (Emo), with
`HadesGC::youngGenCollection` as the delayed symptom that blames nothing.

A card is two short strings and would very likely survive being returned directly.
It comes back this way anyway: betting that the limit is about size when five
reproductions say it is about thread is how a package becomes the sixth.

## Verified

Driven on an iOS 26.4 simulator (**iPhone 17 Pro Max**) with a dev build, alongside
Clear, Voz, Clips, Uhm, Ear, Emo, Tongue, Gist, Redact, Shapes and Align — the
**twelfth pod** in an app that already carried eleven. Every number below was
measured on that run.

**What was verified:**

- **The pod builds and links** into an app carrying eleven other Desert Ant pods,
  with no duplicate symbols: `Build Succeeded — 0 error(s)`.
  `DesertAntCore.podspec` gained `'Title'` and nothing else. No `_NumericsShims`
  include path was needed — Title's target dependencies are `Transcript` plus
  `mlxProducts`, and `mlxProducts` is pruned without the trait.
- **The module registers and every `@JS` property reads**, each off
  desert-ant-core's catalog rather than a constant in TypeScript:

  ```
  [title] isSupported=false canDownload=true mlxTrait=false nativeCore=3.1.0
          id=title revision=v0.1.0 pinned=true repo=desert-ant-labs/title files=7
          weights=model.safetensors osFloor=17 maxTokens=96
  [title] files=model.safetensors model.safetensors.index.json config.json
          generation_config.json tokenizer.json tokenizer_config.json chat_template.jinja
  ```

- **The two booleans genuinely differ**, which is the shape of this package:
  `canDownload=true`, `isSupported=false`, `mlxTrait=false`. The self-test asserts
  the pair rather than either alone.
- **All seven declared file names match the Hub** at the pinned `v0.1.0`, checked
  independently with `curl -I` before the pod was written.
- **The download works, and the bytes are exact.** From an explicit tap:

  ```
  [title] folder ready in 153653ms — 293658528 bytes, 7/7 files, downloaded=true
          dir=…/Library/Caches/desert-ant-models/desert-ant-labs/title/v0.1.0
  ```

  **293,658,528 bytes in 153.7 s** (~1.9 MB/s on this network), and that figure is
  the exact sum of the seven files' `content-length`s on the Hub at `v0.1.0`:
  286,449,872 + 45,758 + 2,103 + 147 + 7,153,802 + 428 + 6,418. Nothing was
  truncated and nothing extra was fetched. The last path component is the **tag**,
  not a branch.
- **Every argument refusal fires before a native call**: an empty passage, a
  whitespace-only passage, `maxTokens: 0`, `maxTokens: -8`, `maxTokens: 1.5` and a
  blank `directory`, all `ERR_INVALID_ARGUMENT`.
- **`describe` refuses rather than returning an empty card.** With the folder
  complete on disk and a real clip transcript as the passage, it raised
  `ERR_UNSUPPORTED_PLATFORM` — `GenerationUnavailableException` — with the sentence
  naming the `MLX` trait. Asserted as a code, because a code is what an app
  branches on.
- **A real bug was found on the device and fixed**, by the self-test assertion
  written for exactly this: `isDownloaded()` and `missingFiles()` must agree. On a
  freshly created (un-prepared) model the first run reported
  `isDownloaded=true missing=7/7 bytes=0 dir=""` — `isDownloaded` reads the managed
  cache, while the filesystem side had no folder to look in. `folderPath()` now
  falls back to the store's own `installedModels()`, and the same probe reports
  `downloaded=true missing=0/7 bytes=293658528` with a real path. No compiler or
  unit test would have caught it; nothing but a downloaded 280 MB folder and an
  un-prepared handle produces it.
- **`cardShape` runs with no model**, as designed: 6 words, 1 sentence,
  `matchesPublishedShape=true` on a specimen card, and it rejects a two-word title.
  39 Jest tests cover it and the rest of the TypeScript surface.
- **No crash attributable to Title.** One `EXC_BAD_ACCESS` was seen across the
  whole session, in the first self-test run, and it symbolicates to
  `ShapesModule._decorateModule` closure #2 → `JavaScriptValuesBuffer.deinit` →
  `jsi::Value::~Value()` on `com.apple.root.user-initiated-qos.cooperative` — the
  known limit-4 async-return race, in a *new* site (Shapes, alongside the
  already-recorded Clear and Emo ones), tripped by a leg that runs after Title's.
  Title's two async entry points return `Void` by construction and never appeared
  on a crashing stack. The final run produced no crash at all.

**What the self-test summary does not say.** The `[selftest]` pass/fail line did
not print in the final run: the Title leg finished clean and the legs after it were
still grinding twenty-five minutes later on a machine where Redact's `load()`
reported 1,379 s and Uhm's 1,401 s. So the claim here is the narrow one — **every
Title assertion passed and no `title:` failure was pushed in any run** — rather
than the broader "all prepared models passed" the earlier packages could make.

### Not verified

**No card has ever been written** — not here, and not anywhere reachable from this
repo. That is the headline, it is not a small caveat, and it is not fixable from
this side.

Generation needs desert-ant-core's `MLX` package trait, and a trait is enabled by a
consuming `Package.swift` or by `swift build --traits` and by nothing else. Checked
rather than assumed:

| probe | answer |
| --- | --- |
| `spm_dependency` in react-native 0.86.3 | `def dependency(pod_spec, url:, requirement:, products:)` — no traits parameter |
| `grep -ril trait` over xcodeproj 1.27.0 | **no matches** — no package-reference class can carry one |
| `grep -ril enabledTraits` over Xcode 26.4.1 (17E202) | two files, both `PackageDescription.swiftmodule/*.swiftinterface` — the manifest API only |
| `xcodebuild -help` | fifteen package options, **no trait flag** |
| `swift build --help` | `--traits`, `--enable-all-traits`, `--disable-default-traits` — but for the *root* package of a SwiftPM build |

A vendored local wrapper package declaring `traits: ["MLX"]` would work
mechanically and was rejected on its merits: a trait is a property of the package,
so it would enable MLX for all twelve models sharing the one `DesertAntCore` pod.

**And it would still not have run here.** MLX is Metal on Apple silicon; an iOS
Simulator is not that. So even with the trait enabled, this session could not have
produced a card. Whether a physical device would have is untested — no device was
available, and this README does not claim one would have worked.

So, specifically **not** measured: any card, any title, any description, any
`processingSec`, any tokens per second, any quality figure, `cardShape` against a
real model output, and the Clips → Title join the product page advertises.
Upstream's 213 ms / 55 ms and 86 tok/s / 447 tok/s Core ML-versus-MLX numbers are
upstream's and are attributed as such everywhere they appear.

Also not verified: the 153.7 s download is a **ceiling under contention**, not a
clean measurement of this network. It ran on a memory-pressured machine while
eleven other models were loading — Redact reported a 1,379 s `load()` in the same
window — so read it as "it completed and every byte arrived", which is what the
byte count proves, rather than as a throughput figure.

## License

This wrapper is MIT. The model is not: it ships under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0)
— free below 100,000 monthly active devices per platform per model, attribution
required in your app, and no using the model or its outputs to train a competing
on-device model.
