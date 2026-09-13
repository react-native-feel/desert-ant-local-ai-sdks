/**
 * Where a model is in the work of producing a result.
 *
 * The union spans every model SDK in this repo, so a given model emits only the
 * subset that means something for it: Clear reports `loadingModel`, `analyzing`
 * and `enhancing`; Voz reports `loadingModel` and `transcribing`; Uhm reports
 * `loadingModel` and `detecting`. Switching on a phase a model never emits is
 * dead code, not a bug -- but narrow the type at the call site rather than
 * assuming, because the set grows with the catalog.
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
  | 'enhancing'
  /** Speech recognition: mel front end, encoder and decode loop, reported as one
   *  fraction over the whole recording. Voz's only working phase. */
  | 'transcribing'
  /** The filler detector sliding its 30 s window over the waveform, reported as
   *  one fraction over the whole recording. Uhm's only working phase -- the type
   *  labeller that follows it is milliseconds and reports nothing. */
  | 'detecting';

export interface ProgressEvent {
  /** Which call this belongs to. Every `enhance*` call takes a job id, so
   *  concurrent calls stay distinguishable on one shared listener. */
  jobId: string;
  phase: ModelPhase;
  /**
   * How far into `phase`, in `0..1`.
   *
   * iOS reports a true fraction. **Clear on Android reports only `0` on entering
   * a phase and `1` on leaving it**, because the Kotlin SDK
   * (`ai.desertant:clear`) exposes no progress callback to forward -- see
   * `LoadedModel.download()` and `Clear.enhance()`, neither of which takes a
   * handler. Drive a determinate bar off this on iOS and an indeterminate one on
   * Android, or treat the phase alone as the signal on both. Voz is Apple-only,
   * so its fractions are always real.
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
