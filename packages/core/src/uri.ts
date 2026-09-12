/**
 * React Native hands out `file://` URIs; every Desert Ant native SDK takes a
 * filesystem path. Converting in one place -- here -- keeps the platform code
 * free of URI parsing, and keeps two model packages from disagreeing about
 * percent-encoding for the same file.
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
