/**
 * Where a model is in the work of producing a result.
 *
 * These mirror `Clear.Phase` in the Swift SDK, which is the only platform that
 * reports a real fraction today -- see {@link ProgressEvent.fraction}.
 */
export type ModelPhase =
  /** Resolving the model: downloading or adopting files, then building the
   *  platform session. On the first-ever launch Apple also pays the Core ML
   *  compile here, which is seconds, not milliseconds. Skipped once loaded. */
  | 'loadingModel'
  /** The DSP front end ahead of the model. Fast relative to `enhancing`. */
  | 'analyzing'
  /** The model itself, chunk by chunk, plus everything that follows it. The
   *  long phase. */
  | 'enhancing';

export interface ProgressEvent {
  /** Which call this belongs to. Every `enhance*` call takes a job id, so
   *  concurrent calls stay distinguishable on one shared listener. */
  jobId: string;
  phase: ModelPhase;
  /**
   * How far into `phase`, in `0..1`.
   *
   * iOS reports a true fraction. **Android reports only `0` on entering a phase
   * and `1` on leaving it**, because the Kotlin SDK (`ai.desertant:clear`)
   * exposes no progress callback to forward -- see `LoadedModel.download()` and
   * `Clear.enhance()`, neither of which takes a handler. Drive a determinate
   * bar off this on iOS and an indeterminate one on Android, or treat the phase
   * alone as the signal on both.
   */
  fraction: number;
}

/** How a model instance finds its weights. */
export interface ModelLoadOptions {
  /**
   * The model's home directory. Files already there are adopted, so an app that
   * ships the weights itself just points at the folder it unpacked them into;
   * otherwise they are downloaded into it. Omit to use the app cache.
   */
  directory?: string;
}

/** Something holding native resources that the caller should hand back. */
export interface Releasable {
  /**
   * Release the native resources now rather than waiting for GC. Calling it
   * twice is a no-op; using the object afterwards raises `ERR_RELEASED`.
   */
  release(): void;
}
