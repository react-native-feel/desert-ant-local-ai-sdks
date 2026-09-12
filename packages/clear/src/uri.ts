/**
 * `toPath` / `toUri` live in `@desert-ant-labs/react-native-core` -- every model
 * package converts between React Native's `file://` URIs and the filesystem
 * paths the native SDKs take, and two copies would be two chances to disagree
 * about percent-encoding for the same file. Re-exported here so the rest of this
 * package (and its tests) keep importing them from one place.
 */
export { toPath, toUri } from '@desert-ant-labs/react-native-core';

/**
 * Where an enhanced file lands when the caller did not say: alongside the input,
 * with a `-clear` suffix and the same extension.
 *
 * Alongside, rather than in a temp directory, because the input is already
 * somewhere the app can write -- a recording in the cache or document directory
 * -- and this package deliberately does not depend on expo-file-system just to
 * ask where that is.
 *
 * Clear-specific, so it stays here: Voz reads a file and writes nothing.
 */
export function defaultOutputPath(inputPath: string, suffix = '-clear'): string {
  const slash = inputPath.lastIndexOf('/');
  const dir = slash >= 0 ? inputPath.slice(0, slash + 1) : '';
  const name = slash >= 0 ? inputPath.slice(slash + 1) : inputPath;
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${dir}${name.slice(0, dot)}${suffix}${name.slice(dot)}`
    : `${dir}${name}${suffix}.wav`;
}
