# @desert-ant-labs/react-native-shapes

On-device sketch recognition for React Native and Expo. One hand-drawn stroke in,
one clean vector shape out — a line, a rectangle, a triangle, an ellipse or a
star — or nothing at all, when what was drawn was not a shape.

iOS and Android. Nothing leaves the device; the weights are **0.2 MB** on Apple
and 1.3 MB on Android, which makes this the smallest model in the Desert Ant
family by a factor of twenty-five.

It is the first model in this repo whose input is neither audio nor text. A
stroke is an ordered list of `{ x, y }` in whatever space you drew in — view
coordinates, PDF points, a normalized canvas — and everything that comes back is
in that same space, because the model is scale- and translation-invariant.
Nothing about the units reaches it.

Wraps [Desert Ant Labs' Shapes model](https://desertant.com/models/shapes/) —
`Sources/Shapes` in the `desert-ant-core` Swift package on Apple,
`ai.desertant:shapes` on Android.

## Install

```sh
npx expo install @desert-ant-labs/react-native-shapes
```

Add the config plugin to `app.json`:

```json
{ "expo": { "plugins": ["@desert-ant-labs/react-native-shapes"] } }
```

Then `npx expo prebuild` and build a dev client. Expo Go cannot load it — this is
a native module.

The plugin does two things your own config would not otherwise say: it raises the
iOS deployment target to **17.0** (the `desert-ant-core` package floor, above
Expo's 16.4 default) and narrows Android's `abiFilters` to `arm64-v8a` and
`x86_64`, which are the two LiteRT ships. Pass `restrictAbis: false` if your
project manages its own ABIs.

## Use

```ts
import { Shapes, outline, isClosed } from '@desert-ant-labs/react-native-shapes';

if (!Shapes.isSupported) return;

const shapes = await Shapes.load();          // 0.2 MB on iOS

const { shape, processingSec } = await shapes.recognize(strokePoints);
switch (shape?.kind) {
  case 'ellipse':
    shape.center;        // { x, y } in the coordinates you drew in
    shape.semiMajor;     // === semiMinor when it snapped to a circle
    break;
  case 'rectangle':
    shape.corners;       // four points, in order around the perimeter
    break;
  case undefined:
    // Rejected. That is a result, not a failure — see below.
    break;
}

// Drawing it needs no model and no bridge hop.
const polyline = outline(shape!);
const closed = isClosed(shape!);            // false only for a line

shapes.release();
```

### Rejecting is half the product

`shape` is `null` whenever the model declined, and a recognizer that never
declines is worse than useless on a whiteboard: a scribble silently becoming a
triangle corrupts the drawing, while a scribble staying a scribble costs nothing.

Two independent gates have to clear. A small classifier proposes a class from a
fixed 256-point window of resampled `[distance, cos, sin]` features, and it has to
clear that class's calibrated confidence gate. Then a geometric fitter produces
the clean parameters **and** a normalized residual — RMS point-to-shape distance
over the bounding-box diagonal — which has to clear that class's residual gate.
So a confident "rectangle" that does not actually fit a rectangle is still thrown
away. A stroke too short or too small to be a stroke is rejected before either.

### The snapping is why the output looks deliberate

After the fit comes regularization, and this is the part that turns an accurate
fit into a *tidy* one:

| | |
| --- | --- |
| Line | snaps to the horizontal or vertical axis within **5°** |
| Ellipse | becomes an exact **circle** when the axes are within **25%** |
| Ellipse | rotation snaps to **15°** increments |
| Rectangle | becomes a **square** when the sides are within **25%** |
| Rectangle | rotation snaps to **15°** increments |
| Triangle | becomes **equilateral** or **isosceles** within **25%** |
| Triangle | base edge snaps to an axis within **5°** |

None of it is configurable on any of the three upstream SDKs — `SnapConfig` is
`internal` in `Sources/Shapes/Snapping.swift` — so it is documented here rather
than exposed. Nothing is invented: those are the values in that file.

### One stroke at a time

Upstream says so and means it. There is no session, no incremental state, and no
notion of a second stroke joining the first — a multi-stroke diagram has to be
grouped by the app before it gets here.

### Drawing the result

`outline(shape, samples?)` gives a polyline to connect, and `isClosed(shape)`
says whether to close it. Both are pure, synchronous, and answer on a device that
has never downloaded a weight.

**They are ported from upstream rather than bound to it, and that is the one
close call in this package.** The Swift SDK has `Shape.outline(samples:)` plus
`cgOutline` and a ready `CGPath`; `ai.desertant:shapes` has nothing equivalent —
its whole public surface is `Shapes`, `Shape`, `Point`, `Options` and
`ShapesException`. Bridging the Swift one would have made the *rendering* call
iOS-only, and a shape SDK whose shapes cannot be drawn on Android is not a shape
SDK. Writing it once in Kotlin and once in Swift is the same duplication in two
languages instead of one, with a bridge hop per frame on top.

What makes it safe to port is that there is almost nothing to port. A line, a
rectangle and a triangle *are* their outlines — the points come straight back out
of the union, untouched. The only arithmetic is the ellipse and the star, both
closed-form parametrizations fully determined by the field documentation upstream
publishes. The unit tests pin both against values computed independently of the
implementation, and the example app's self-test re-checks them on device against
geometry the model produced: a snapped circle's outline came back **1.4e-14**
from its own radius.

## API

| | |
| --- | --- |
| `Shapes.isSupported` | True on iOS and on Android with a LiteRT ABI. |
| `Shapes.unsupportedReason` | Why, in a sentence, or null. On Android it names the device's ABIs. |
| `Shapes.nativeCoreVersion` | The `desert-ant-core` version the binary links, or null. |
| `Shapes.modelRevision` | The pinned model revision, or null. |
| `Shapes.modelRepo` | The Hub repo the weights come from, or null. |
| `Shapes.kinds` | The five classes. The one list here *not* read off the binary — see below. |
| `Shapes.defaultMinimumConfidence` | `0`: the model's own gates and nothing on top. |
| `Shapes.load(options?)` | Create, download and prepare. |
| `Shapes.create(options?)` | Create without touching the network. |
| `shapes.isDownloaded()` | Whether recognition can run offline. Synchronous. |
| `shapes.warm(onProgress?)` | Download and build the session. |
| `shapes.download(onProgress?)` | The same call — see below. |
| `shapes.recognize(points, options?)` | A stroke in, a `Recognition` out. |
| `shapes.release()` | Hand the model back. |
| `outline(shape, samples?)` | The polyline to draw. No model, synchronous. |
| `isClosed(shape)` | Whether to close that polyline. `false` only for a line. |

`Shape` is a discriminated union on `kind`, so `switch (shape.kind)` narrows and
an unhandled class is a type error.

Failures are `DesertAntError` with a stable `code`, the same vocabulary the other
Desert Ant models raise: `ERR_MODEL_UNAVAILABLE`, `ERR_MODEL_LOAD_FAILED`,
`ERR_INFERENCE_FAILED`, `ERR_INVALID_ARGUMENT`, `ERR_RELEASED`,
`ERR_UNSUPPORTED_PLATFORM`. There is no `ERR_AUDIO_*` here — the input is a list
of numbers, so nothing can fail to decode.

## Things the types cannot tell you

- **The published numbers are upstream's.** Upstream advertises "under 10 ms per
  stroke", 0.2 MB on Apple and 1.3 MB on Android/web, and says very rough or
  ambiguous strokes are intentionally rejected. What *this* package measured on a
  simulator is in **Verified** below, kept separate on purpose.
- **`Shapes.kinds` is the one list not read off the binary, and the exception is
  upstream's.** Every other model here reads its vocabulary from the native SDK —
  `Redact.labels` off `Label.allCases`, `Gist.variants`, `Uhm.fillerTypes` —
  because a duplicated list goes stale. Shapes publishes none to read:
  `ShapeKind` is `internal` in `Sources/Shapes/Shape.swift`, the public `Shape`
  is a Swift enum with associated values and so cannot be `CaseIterable`, and
  Kotlin's `Shape` is a sealed class whose subclasses are not enumerable without
  reflection. What keeps it honest is native rather than here: the `switch` that
  flattens a fitted shape onto the wire is exhaustive over that public enum with
  no `default`, so a sixth class upstream **fails the pod's build**. The Android
  half cannot get that from the compiler — it resolves a sealed class out of a
  Maven artifact at runtime — so it throws `ERR_INFERENCE_FAILED` naming the class
  it did not know, which is the same refusal one layer later.
- **An unknown class is refused, not reported as "no shape".** `null` already
  means the model rejected the stroke, and the two mean opposite things.
  `ai.desertant:shapes`'s own FFI decoder collapses them (`else -> null`); this
  package does not.
- **Recognition reports no progress.** Upstream's `recognize(points:options:)`
  takes no handler on either platform, so the only phase a `Shapes` emits is
  `loadingModel`, and no phase was added to `ModelPhase` in `packages/core`.
  `onProgress` on a `recognize` still fires — for the load the first call does
  implicitly. A pass advertised at under ten milliseconds is not something a
  progress bar could usefully show.
- **`warm` and `download` are the same call.** Upstream exposes one entry point
  that downloads *and* builds the session, so unlike Clear and Voz there is no
  download-only step. Both names exist so the ten models read alike.
- **A stroke of fewer than two points is `null`, and never loads the model.**
  That is upstream's own answer rather than this package's: `Shapes.kt` opens with
  `if (points.size < 2) return null`, and the Swift path reaches the same nil
  through its degenerate-stroke check. Doing it before the load is what makes an
  empty canvas free on a device that has never downloaded the weights.
- **Give it the raw gesture samples.** The model resamples to uniform arc length
  itself and reads a fixed 256-point window, so more points than that cost the
  bridge hop and nothing else — and thinning the stroke yourself can only lose
  information.
- **The two platforms download different artifacts and different amounts.**
  `shapes.mlmodelc` is 0.2 MB; `shapes.tflite` is 1.3 MB. Same model, same
  revision (`v0.3.0`), two exports, both reading the same
  `shapes_meta.json` sidecar for the class order, the gates and the frozen
  preprocessing constants.
- **`modelRevision` and `modelRepo` are constants on Android.**
  `ai.desertant:shapes` publishes `Shapes`, `Shape`, `Point`, `Options` and
  `ShapesException`, and its `companion object` is empty — there is nothing to
  read the catalog from. The Apple half reads `ShapesModel`.
- **Android reports progress as phase boundaries, not fractions.**
  `ai.desertant:shapes`'s `download()` takes no callback, so it emits 0 on
  entering `loadingModel` and 1 on leaving. For a 1.3 MB download the difference
  is close to academic.
- **`defaultMinimumConfidence` is mirrored, not read.** It is a default argument
  in a Swift initializer and a Kotlin data class — not a constant either SDK
  exposes. It is still forwarded through the native module so the two platforms
  cannot show different numbers.
- **Every async native call returns `Void`.** The result comes back through a
  synchronous member on the shared object. That is not a style choice — see below.

## Two refusals upstream does not make

Both are cases where an upstream SDK silently transforms bad input into a
plausible answer, which is the failure mode worth spending an error on.

**A coordinate that is not a finite number.** `StrokePreprocessor` does not reject
one: its duplicate test is `abs(dx) > epsilon`, which is `false` for `NaN`, so a
poisoned point is *dropped* rather than caught and whatever survives is classified
anyway. The answer is a real `Shape` whose geometry is `NaN` — it renders as
nothing and reads as a model that stopped working. A gesture stream that briefly
reported no location is exactly how that happens. This package raises
`ERR_INVALID_ARGUMENT` naming the offending point index, in TypeScript and on both
native halves.

**A `minimumConfidence` outside `0...1`.** Upstream's `Options.init` runs
`isFinite ? min(1, max(0, value)) : 0`, so `95` — meaning "95%" — silently becomes
`1.0` and rejects every stroke the model draws, while `NaN` silently becomes `0`
and rejects nothing. Both look like a working recognizer that has stopped
recognizing. The Kotlin SDK does not clamp at all; it writes the `f64` onto the
FFI and lets the Swift initializer on the other side do it, so the two agree only
by accident. Refused here instead.

An odd number of coordinates on the wire is refused for the same reason, though
the TypeScript surface takes `{ x, y }` objects and so cannot produce one.

## Every async call returns nothing, on purpose

`recognize` is a `Promise<void>`. The recognition comes back from
`takeRecognition(jobId)`, which is **synchronous**.

That is a workaround for a real crash, reproduced in four packages in this repo
before this one was written: a `@JS async` function's return value can be encoded
**off the JavaScript thread**, and the process segfaults on
`com.apple.root.user-initiated-qos.cooperative` rather than on
`com.facebook.react.runtime.JavaScript`. `@JavaScriptActor` does not prevent it —
the value is encoded after the actor hop the annotation governs. Ear hit it
returning `[String]`, Clear through `Record.encode`, Emo through
`JavaScriptValuesBuffer.deinit`; the downstream symptom is
`HadesGC::youngGenCollection` killing the process later and blaming nothing.

A `ShapesRecognition` carries a `number[]`, which is the same *shape* of value
that took Ear down, so the split here is not a precaution taken from a distance.
A synchronous `@JS` member runs on the JavaScript thread by construction, so the
record is encoded where it has to be. `src/Shapes.ts` hides both halves; do not
"simplify" them back into one call.

## The wire is flat; the API is a union

`Shape` is a Swift enum with associated values and a Kotlin sealed class. Neither
`@Record` nor a JavaScript object literal has a sum type, so the wire carries a
`kind` tag, a flat `[x, y, x, y, ...]` points array, and scalar fields for the
rest — which is exactly what upstream's own cross-language binding writes
(`Sources/Shapes/Binding.swift`: `u32 present`, `u32 kind`, then that kind's
fields). `src/Shapes.ts` narrows it back into the discriminated union, and the
flatness never reaches a caller.

The stroke goes *in* flat for a different reason: a real stroke is hundreds of
points, this is the one call in the family a gesture stream can issue several
times a second, and the cheapest thing that crosses wins.

## SwiftUI also has a `Shape`

`ios/ShapesGeometry.swift` is two typealiases in a file with one import, and both
halves of that are deliberate. Upstream's fitted-geometry enum is spelled `Shape`
and so is SwiftUI's protocol; any file importing `ExpoModulesCore` gets SwiftUI
transitively, so the bare name does not compile.

`Shapes.Shape` is not the fix — the module is named `Shapes` and so is the
recognizer class inside it, so a module-qualified spelling resolves to the class
first and then fails to find a member type on it. A file importing only `Shapes`
has no SwiftUI in scope, so the names are unambiguous there; everything else in
the pod refers to `FittedShape` and `CanvasPoint`. This is the same technique
`packages/redact/ios/RedactLabel.swift` uses against `SwiftUI.Label`, applied
before the diagnostic rather than after it.

## Verified

Driven on an iOS 26 simulator (**iPhone 17 Pro Max**) with a dev build, alongside
Clear, Voz, Clips, Uhm, Ear, Emo, Tongue, Gist and Redact — the tenth pod in an
app that already carried nine. Every number below was measured on that run; the
log lines are in the example app's self-test output.

The pod built on the first attempt. The `_NumericsShims` include path was copied
from `packages/gist` and `packages/redact` rather than rediscovered, and the
`Shape` / `Point` typealias file was written before the first compile rather than
after the first failure — both are now rules in this repo, not incidents.

**The five classes, from synthetic hand-drawn strokes generated in code:**

| stroke | points | result | geometry | native |
| --- | --- | --- | --- | --- |
| circle | 105 | `ellipse` | **circle** r 72.3 at (120.0, 102.0) | 9.7 ms |
| rectangle | 116 | `rectangle` | **149.7 × 149.7 (square)** at 90° | 3.9 ms |
| triangle | 106 | `triangle` | sides **171.1 / 171.1 / 171.1** | 1.9 ms |
| line | 44 | `line` | (26.3, 153.1) → (210.2, 57.7) | 1.3 ms |
| star | 124 | `star` | 5 points, r 70.1 / 28.0 at 72° | 2.1 ms |
| scribble | 91 | **rejected** | — | 1.0 ms |

Three of those rows are the snapping doing its job on input that was not
symmetric. The rectangle was drawn 151 × 137 and came back an exact square; the
triangle was drawn with a 176-unit base and 168.7-unit legs and came back exactly
equilateral; the circle was drawn with ±6 units of jitter and came back with
`semiMajor === semiMinor` to the last bit.

**Latency**, over those six strokes, measured natively around the whole call:
**min 1.0 ms, median 2.0 ms, max 9.7 ms**. The 9.7 ms is the first inference after
the session was built; every one after it was between 1.0 and 3.9. Wall-clock from
JavaScript including the bridge hop was 1–13 ms. Upstream's "under 10 ms per
stroke" held, and on this hardware the steady-state figure was well under it.

**Load:** `[shapes] ready in 39232ms downloaded=true`. That number is honest and
also misleading, so: it is a cold first launch in which Emo, Ear, Uhm, Redact and
Shapes were all downloading and building Core ML sessions concurrently, on a
simulator. It is not a measurement of a 0.2 MB download — Emo (5 MB) came ready
at 35.9 s and Redact (12 MB) at 39.8 s in the same window. No isolated cold-load
figure was measured.

**Properties, all read off the binary:** `revision=v0.3.0`,
`repo=desert-ant-labs/shapes`, `nativeCore=3.1.0`, `minConfidence=0`.

**Invariants asserted on device**, none of which encodes an expected answer:

- Every fitted coordinate finite; a `line` outline 2 points, a `rectangle` 4, a
  `triangle` 3; `semiMajor >= semiMinor`; a star's outline exactly
  `2 × pointCount` points alternating between its two radii to within 1e-6.
- A snapped circle's ported outline sits **1.4e-14** from its own radius — which
  is what pins the ported ellipse parametrization against arithmetic rather than
  against itself.
- Every fit landed inside the stroke's own bounding box expanded by half.
- `isClosed` agrees with the kind.
- **Determinism**: the same stroke recognized twice gave byte-identical geometry.
- **Invariance**, which is a claim upstream makes and this checks: the same
  stroke translated by (+37, −11) and scaled ×1.7 came back the same class both
  times.
- An empty stroke and a one-point stroke both came back `null`.
- `minimumConfidence: 1` rejected everything, as arithmetic says it must.
- All five refusals raised `ERR_INVALID_ARGUMENT`: a `NaN` coordinate, an
  `Infinity` coordinate, and `minimumConfidence` of 95, −0.1 and `NaN`.

**The canvas.** The example app's Shapes section is a real drag surface — a
`View` with touch-responder handlers collecting `locationX`/`locationY` — with a
row of synthetic-stroke buttons beside it. Both paths are the same call with the
same arguments. A finger drag on the simulator was exercised and recognized
(`drawn · 2 points` → `line`, geometry `(66.0, 169.7) → (152.3, 151.0)`), but
the simulator's synthesized pan delivers a grant, one move and a release rather
than a continuous path, so **only a 2-point drag was verified through the gesture
surface**; the multi-point path is what the buttons exercise, through the same
`recognize` call. A real finger on a real device was not tested.

The result renders as grey ink dots for the stroke with the fitted shape drawn
over it in blue, from `outline` — which means the port is exercised visually on
every tap, not only in the self-test.

`[selftest] all prepared models passed` with no failures, and no new crash report
in `~/Library/Logs/DiagnosticReports`. The app did not go down during this
session; the known `ClearModule` and `EmoModule` async-return crashes were not
tripped.

### Not verified

- **Android has never been compiled.** There is no Android SDK on the machine
  this package was written on — `ANDROID_HOME` points at a directory with no
  `platforms` and no `build-tools`, and there is no `sdkmanager` to fetch them. The
  Kotlin half is written against the published `ai.desertant:shapes` API and
  reviewed against it, and nothing more than that should be read into it. It has
  not been built, linked, or run.
- **No accuracy measurement of any kind.** The strokes above are six synthetic
  samples, which is a smoke test and not a benchmark. Upstream publishes no
  accuracy figure for this model and neither does this package.
- **A real finger on real hardware.** Simulator only.
- **The 15° rotation snap** was not directly observed: every sample that snapped
  landed on 0°, 72° or 90°, all of which are already multiples of 15.
