# @desert-ant-labs/react-native-core

The pieces every Desert Ant Labs React Native model SDK shares: the error type
and its codes, the model-lifecycle and progress contracts, and the license
pointer. No native code — each model package carries its own.

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
  Codes are identical on Apple and Android, so a caller branches on `code`
  without knowing which platform raised it.
- **`ProgressEvent` / `ModelPhase`** — the shared progress shape, including the
  documented limits on what Android's `fraction` can mean.
- **`ModelLoadOptions`** — where a model looks for its weights.
- **`LICENSE`** — the source-available terms every model inherits.
