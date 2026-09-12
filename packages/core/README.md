# @desert-ant-labs/react-native-core

The pieces every Desert Ant Labs React Native model SDK shares: the error type
and its codes, the model-lifecycle and progress contracts, the URI helpers, the
license pointer — and, on Apple, the single native bridge to the `desert-ant-core`
Swift package.

You do not install this directly; a model package depends on it and re-exports
what a caller needs.

```ts
import { DesertAntError } from '@desert-ant-labs/react-native-clear';

try {
  await clear.enhance({ uri });
} catch (error) {
  if (error instanceof DesertAntError && error.code === 'ERR_MODEL_UNAVAILABLE') {
    // Offline and the weights were never fetched.
  }
}
```

## What's here

- **`DesertAntError`** — `code`, `model`, `message`, and the original as `cause`.
  Codes are identical on Apple and Android and across models, so a caller
  branches on `code` without knowing which platform or which model raised it.
- **`ProgressEvent` / `ModelPhase`** — the shared progress shape, including the
  documented limits on what Android's `fraction` can mean.
- **`ModelLoadOptions`** — where a model looks for its weights.
- **`toPath` / `toUri`** — React Native hands out `file://` URIs and every native
  SDK here takes a filesystem path. One implementation, so two model packages
  cannot disagree about percent-encoding for the same file.
- **`LICENSE`** — the source-available terms every model inherits.

## The `DesertAntCore` pod

There is no Expo module here and nothing in `ios/` is reachable from JavaScript.
The pod exists because **the Swift package has to be bridged in exactly once.**

Every model is a thin Expo module over a product of the same package
(`desert-ant-core`), and that package's shared targets — `DesertAnt`,
`ModelStore`, `Usage`, `Inference`, `AudioIO`, `FFIBuffer`, `ModelCatalog` and
seven more — come along with each product. Xcode links a package product's static
library *into* the linking pod's own archive, so when each model pod declared its
own `spm_dependency`, `libDesertAntClear.a` and `libDesertAntVoz.a` each held a
full copy of those thirteen objects and an app using both models failed to link:

```
ld: 1071 duplicate symbols
duplicate symbol 'type metadata for ModelStore.StoredModel' in:
    libDesertAntClear.a[15](ModelStore.o)
    libDesertAntVoz.a[14](ModelStore.o)
```

So `DesertAntCore` declares the one `spm_dependency`, naming every model product
the family ships, and the model pods depend on it. Their Swift still says
`import Clear` / `import Voz`; only the linking moved. The app gets one copy of
the shared core rather than one per model — which is also the smaller binary:

| | before | after |
| --- | --- | --- |
| `libDesertAntCore.a` | — | 3.7 MB (the package, once) |
| `libDesertAntClear.a` | 3.6 MB | 808 KB (bridge only) |
| `libDesertAntVoz.a` | 3.4 MB | 588 KB (bridge only) |

The cost is that `DESERT_ANT_PRODUCTS` in `ios/DesertAntCore.podspec` lists every
model, so an app installing one still links the other's Swift. No weights are
involved — every model here downloads its artifacts at runtime and the package
bundles none — so it is code size, not hundreds of megabytes. **Adding a model to
this SDK means adding its product there.**
