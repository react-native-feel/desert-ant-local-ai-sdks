/**
 * React Native hands out `file://` URIs; both native SDKs take filesystem paths.
 * Converting in one place -- here -- keeps the platform code free of URI
 * parsing, and keeps the two halves from disagreeing about percent-encoding.
 */

/** `file:///a/b%20c.m4a` -> `/a/b c.m4a`. A plain path passes through. */
export function toPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  const withoutScheme = uri.slice('file://'.length);
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    // A stray `%` that is not an escape. Better to try the raw path than to fail
    // before we have even looked for the file.
    return withoutScheme;
  }
}

/** `/a/b c.wav` -> `file:///a/b%20c.wav`. An existing URI passes through. */
export function toUri(path: string): string {
  if (path.includes('://')) {
    return path;
  }
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Where an enhanced file lands when the caller did not say: alongside the input,
 * with a `-clear` suffix and the same extension.
 *
 * Alongside, rather than in a temp directory, because the input is already
 * somewhere the app can write -- a recording in the cache or document directory
 * -- and this package deliberately does not depend on expo-file-system just to
 * ask where that is.
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
