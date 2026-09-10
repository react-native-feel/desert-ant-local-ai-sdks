/**
 * Error codes every Desert Ant model SDK reports. The native side raises coded
 * exceptions with these names, so a caller can branch on `code` without parsing
 * a message that is free to change.
 */
export type DesertAntErrorCode =
  /** The weights are not on the device and the download failed or was skipped. */
  | 'ERR_MODEL_UNAVAILABLE'
  /** The weights are present but the platform runtime refused to build a session. */
  | 'ERR_MODEL_LOAD_FAILED'
  /** Inference ran but failed or produced an unexpected output. */
  | 'ERR_INFERENCE_FAILED'
  /** The input file could not be read, decoded, or is not audio. */
  | 'ERR_AUDIO_DECODE_FAILED'
  /** The output file could not be encoded or written. */
  | 'ERR_AUDIO_ENCODE_FAILED'
  /** An argument was out of range or the wrong shape. */
  | 'ERR_INVALID_ARGUMENT'
  /** The model handle was used after `release()`. */
  | 'ERR_RELEASED'
  /** The platform cannot run this model at all (OS too old, unsupported ABI). */
  | 'ERR_UNSUPPORTED_PLATFORM';

/**
 * A failure raised by a Desert Ant model. `code` is stable across platforms and
 * versions; `message` is for humans and logs.
 */
export class DesertAntError extends Error {
  readonly code: DesertAntErrorCode;
  /** The model that raised it, for example `clear`. */
  readonly model: string;

  constructor(code: DesertAntErrorCode, model: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DesertAntError';
    this.code = code;
    this.model = model;
  }
}

const KNOWN_CODES = new Set<string>([
  'ERR_MODEL_UNAVAILABLE',
  'ERR_MODEL_LOAD_FAILED',
  'ERR_INFERENCE_FAILED',
  'ERR_AUDIO_DECODE_FAILED',
  'ERR_AUDIO_ENCODE_FAILED',
  'ERR_INVALID_ARGUMENT',
  'ERR_RELEASED',
  'ERR_UNSUPPORTED_PLATFORM',
]);

/**
 * Normalize whatever the native layer threw into a {@link DesertAntError}.
 *
 * Expo's coded exceptions arrive as an `Error` whose `code` is the native
 * exception's code, so the common case is a straight re-wrap. Anything else -- a
 * Swift error that escaped without a code, a JS-side `TypeError` from a bad
 * argument -- becomes `ERR_INFERENCE_FAILED` with the original attached as
 * `cause`, so nothing is swallowed.
 */
export function toDesertAntError(error: unknown, model: string): DesertAntError {
  if (error instanceof DesertAntError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return new DesertAntError(
    typeof code === 'string' && KNOWN_CODES.has(code) ? (code as DesertAntErrorCode) : 'ERR_INFERENCE_FAILED',
    model,
    message,
    { cause: error }
  );
}
