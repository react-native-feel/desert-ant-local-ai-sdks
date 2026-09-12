import { toDesertAntError, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeClips, { type NativeClipsModel } from './native';
import {
  type Clip,
  type ClipsLoadOptions,
  type FindClipsOptions,
  type ToSentencesOptions,
  type TranscriptSentence,
  type TranscriptWord,
} from './types';

const MODEL = 'clips';

let nextJobId = 0;

/**
 * On-device clip selection: the moments in a transcript worth cutting.
 *
 * Give it a transcript — one sentence per element, in spoken order — and it
 * returns ranked, non-overlapping runs of those sentences, with the spans of the
 * recording to play. A per-sentence selector proposes candidate spans, a span
 * scorer rates them, and weighted interval scheduling picks the best
 * non-overlapping set.
 *
 * Create one and reuse it. The weights are ~288 MB and the first load
 * specializes the graph for the Neural Engine (~41 s on an iPhone 17 Pro), so
 * this is something an app downloads deliberately and then holds.
 *
 * ```ts
 * const clips = await Clips.load();
 * const moments = await clips.find({ sentences });
 * for (const moment of moments.filter((m) => m.percentile > 0.8)) {
 *   console.log(moment.text, moment.ranges);
 * }
 * ```
 */
export class Clips {
  /**
   * Whether this build and this device can run Clips.
   *
   * **False on Android** — upstream declares LiteRT files for it but publishes no
   * artifact to bind to yet — and **false below iOS 18**, because
   * `clips.mlmodelc` is a multifunction Core ML package and multifunction is an
   * iOS 18 feature. See {@link unsupportedReason} for which it is.
   */
  static get isSupported(): boolean {
    return NativeClips?.isSupported ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. Worth surfacing rather than logging: "needs iOS 18" and "no Android
   *  build" call for different UI. */
  static get unsupportedReason(): string | null {
    if (!NativeClips) {
      return 'Clips runs on Apple platforms only: desert-ant-core publishes no Android build of this model yet.';
    }
    return NativeClips.unsupportedReason;
  }

  /** The desert-ant-core version the native binary links against, or null off iOS. */
  static get nativeCoreVersion(): string | null {
    return NativeClips?.nativeCoreVersion ?? null;
  }

  /** The pinned model revision this SDK resolves, or null off iOS. */
  static get modelRevision(): string | null {
    return NativeClips?.modelRevision ?? null;
  }

  /** How many clips a `find` returns when you do not say. 10. */
  static get defaultLimit(): number {
    return NativeClips?.defaultLimit ?? 10;
  }

  /**
   * Group a recognizer's timed words into sentences — the input `find` wants.
   *
   * This is the join between Voz and Clips, and it is upstream's own logic
   * rather than a reimplementation: sentences break at terminal punctuation,
   * unpunctuated speech breaks at `runOnLimit` characters so a transcript always
   * offers more than one thing to choose between, and words the recognizer could
   * not place contribute their text but not their times.
   *
   * ```ts
   * const { words } = await voz.transcribe({ uri });
   * const sentences = Clips.toSentences(words);
   * const moments = await clips.find({ sentences });
   * ```
   *
   * Pure and synchronous — it needs no model and no download.
   */
  static toSentences(
    words: TranscriptWord[],
    options: ToSentencesOptions = {}
  ): TranscriptSentence[] {
    const native = Clips.requireNative();
    try {
      return native.sentencesFromWords(words, options.runOnLimit ?? 320);
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Create the model and get it ready. Resolves when the next `find` will not
   * have to wait for a download or a session build.
   */
  static async load(options: ClipsLoadOptions = {}): Promise<Clips> {
    const clips = Clips.create(options);
    try {
      await clips.warm(options.onProgress);
      return clips;
    } catch (error) {
      clips.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The weights are resolved
   * lazily on the first `find`, which is then as slow as a download.
   */
  static create(options: ClipsLoadOptions = {}): Clips {
    const native = Clips.requireNative();
    try {
      return new Clips(
        native.createModel({
          directory: options.directory,
          computeUnits: options.computeUnits ?? 'cpuAndNeuralEngine',
        })
      );
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  private static requireNative(): NonNullable<typeof NativeClips> {
    if (!NativeClips) {
      throw toDesertAntError(
        Object.assign(new Error(Clips.unsupportedReason ?? 'Clips is not available here.'), {
          code: 'ERR_UNSUPPORTED_PLATFORM',
        }),
        MODEL
      );
    }
    return NativeClips;
  }

  private released = false;

  private constructor(private readonly native: NativeClipsModel) {}

  /** Whether the weights are on the device, so `find` needs no network. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download the weights and build the session.
   *
   * Identical to {@link download} — upstream exposes one call that does both,
   * so unlike Clear and Voz there is no download-only step to run separately.
   * Both names exist so the three models read the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Clips.requireNative().load(this.native, jobId));
  }

  /** The same call as {@link warm}. See its note. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Every worthwhile moment in the transcript, ranked best first and
   * non-overlapping.
   *
   * A transcript under three sentences comes back empty — there is nothing to
   * choose between.
   */
  async find(options: FindClipsOptions): Promise<Clip[]> {
    this.assertAlive();
    const sentences = options.sentences ?? [];
    if (!Array.isArray(sentences)) {
      throw toDesertAntError(
        Object.assign(new Error('`sentences` must be an array of { text, start, end }'), {
          code: 'ERR_INVALID_ARGUMENT',
        }),
        MODEL
      );
    }
    // `limit` is three states in TypeScript -- a number, `null` for "let the
    // model decide", or absent for the default -- and two fields on the wire, so
    // neither native record has to encode "absent" and "auto" in one value.
    const limit = options.limit === undefined ? Clips.defaultLimit : options.limit;
    if (limit !== null && (!Number.isFinite(limit) || limit < 1)) {
      throw toDesertAntError(
        Object.assign(new Error(`'${String(limit)}' is not a clip limit; expected a positive integer or null`), {
          code: 'ERR_INVALID_ARGUMENT',
        }),
        MODEL
      );
    }
    const padding = options.padding ?? 0.15;
    if (!Number.isFinite(padding) || padding < 0) {
      throw toDesertAntError(
        Object.assign(new Error(`'${String(padding)}' is not a padding; expected a non-negative number`), {
          code: 'ERR_INVALID_ARGUMENT',
        }),
        MODEL
      );
    }

    // Fewer than three sentences is upstream's own empty case. Answering it here
    // saves a ~288 MB download for a call that cannot return anything.
    if (sentences.length < 3) {
      return [];
    }

    return this.run(undefined, (jobId) =>
      Clips.requireNative().findClips(
        this.native,
        sentences,
        {
          limit: limit ?? Clips.defaultLimit,
          useDurationCurve: limit === null,
          padding,
        },
        jobId
      )
    );
  }

  /**
   * Release the model. Calling it twice is a no-op; using the instance
   * afterwards throws `ERR_RELEASED`.
   */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.native.release();
  }

  /**
   * Run one native call with a progress subscription scoped to it. Every native
   * entry point takes a job id, so concurrent calls on one model stay
   * distinguishable on the single `progress` event.
   */
  private async run<T>(
    onProgress: ((event: ProgressEvent) => void) | undefined,
    call: (jobId: string) => Promise<T>
  ): Promise<T> {
    nextJobId += 1;
    const jobId = `clips-${nextJobId}`;
    const subscription = onProgress
      ? this.native.addListener('progress', (event: ProgressEvent) => {
          if (event.jobId === jobId) {
            onProgress(event);
          }
        })
      : undefined;
    try {
      return await call(jobId);
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    } finally {
      subscription?.remove();
    }
  }

  private assertAlive(): void {
    if (this.released) {
      throw toDesertAntError(
        Object.assign(new Error('This Clips was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}
