import { toDesertAntError, type ProgressEvent } from '@desert-ant-labs/react-native-core';

import NativeTitle, { type NativeTitleModel } from './native';
import { type Card, type DescribeOptions, type TitleLoadOptions } from './types';

const MODEL = 'title';

/** Upstream's own default decode cap, for the platforms where the module is not
 *  there to ask. Kept in step with the `maxTokens: Int = 96` default argument on
 *  `Titles.init`. */
const FALLBACK_MAX_TOKENS = 96;

let nextJobId = 0;

/**
 * On-device titles and descriptions: a short factual title and a one- to
 * two-sentence description for any passage of text.
 *
 * **Read this before you plan around it.** Title is the only model in this family
 * whose central call does not work in a React Native build, and the reason is a
 * SwiftPM package trait rather than a device, a download or a bug. Generation
 * lives behind desert-ant-core's `MLX` trait; a trait is enabled by a consuming
 * `Package.swift` or by `swift build --traits`, and a CocoaPods app is neither.
 * So:
 *
 * | | |
 * | --- | --- |
 * | {@link isSupported} | **false** — {@link describe} throws `ERR_UNSUPPORTED_PLATFORM` |
 * | {@link canDownloadWeights} | true on Apple — {@link load}, {@link prepare} and every reader below work |
 *
 * What still works is the catalog half, and it is not a consolation prize: the
 * ~280 MB model folder downloads, verifies and inspects, and
 * {@link Title.resolvedDirectory} is exactly the path upstream's own
 * `Titles(directory:)` takes. An app whose native code does have the trait can
 * use this package to get the files there.
 *
 * ```ts
 * if (!Title.canDownloadWeights) return;
 * const title = await Title.load({ onProgress: setProgress });   // ~280 MB
 * title.resolvedDirectory();   // the folder a native `Titles(directory:)` wants
 *
 * if (Title.isSupported) {
 *   const card = await title.describe(note.body);
 *   card.title;         // "Filming a two-person podcast on iPhone"
 *   card.description;   // one or two sentences
 * }
 * ```
 *
 * The model itself is a 350M-parameter Granite fine-tune quantized to 6 bits. It
 * was trained on transcript clips and the published page says it holds up on
 * general prose -- news paragraphs, product descriptions, emails -- with a
 * measured slip rate upstream describes as "one in four" on that wider material.
 * It is in internal testing and its model card carries no quality figures, so
 * read the output before it reaches a user; {@link cardShape} checks the format
 * half of that automatically.
 *
 * Nothing is sent anywhere, and unlike every other model here nothing is
 * downloaded by upstream's own SDK either -- `Titles(directory:)` takes a folder
 * you populated. The download in this package is `TitleModel.resolve`, which
 * Title inherits from the shared catalog.
 */
export class Title {
  /**
   * Whether this build can write a card.
   *
   * **False today on every device**, and it is worth being precise about why,
   * because it is not the usual reason. It is not Android (though it is also
   * false there, and permanently -- MLX is Apple silicon only and upstream ships
   * no Kotlin or JS SDK). It is not an old OS. It is not a missing download. It
   * is that the binary was compiled without desert-ant-core's `MLX` package
   * trait, so `Sources/Title/Title.swift` compiled without its `#if MLX` half and
   * upstream's `Titles` actor has no public initializer at all -- which upstream
   * chose deliberately, so that "a consumer that forgot the trait fails at
   * compile time instead of mis-building".
   *
   * Gate {@link describe} on this. Do **not** gate {@link load} on it; use
   * {@link canDownloadWeights}.
   */
  static get isSupported(): boolean {
    return NativeTitle?.isSupported ?? false;
  }

  /**
   * Whether the model folder can be downloaded, verified and inspected here.
   *
   * True on Apple, false off it. This is the gate for {@link load},
   * {@link create} and everything on the instance except {@link describe}.
   */
  static get canDownloadWeights(): boolean {
    return NativeTitle?.canDownloadWeights ?? false;
  }

  /**
   * Whether this binary was built with the `MLX` package trait.
   *
   * The single fact {@link isSupported} turns on, exposed separately so an app
   * can tell "this build cannot generate" from "this platform cannot generate".
   * It is computed natively from `canImport(MLXLMCommon)` rather than written
   * down, so it becomes true on its own if the trait is ever enabled.
   */
  static get mlxTraitEnabled(): boolean {
    return NativeTitle?.mlxTraitEnabled ?? false;
  }

  /** A sentence explaining why {@link isSupported} is false, or null when it is
   *  true. Native where the module exists, because only the binary knows how it
   *  was built. */
  static get unsupportedReason(): string | null {
    if (Title.isSupported) {
      return null;
    }
    const native = NativeTitle?.unsupportedReason;
    if (native) {
      return native;
    }
    return (
      'Title runs on Apple silicon only, through MLX: desert-ant-core ships no Android build, ' +
      'and its manifest records the Kotlin and JavaScript SDKs as none.'
    );
  }

  /** The desert-ant-core version the native binary links against, or null off iOS. */
  static get nativeCoreVersion(): string | null {
    return NativeTitle?.nativeCoreVersion ?? null;
  }

  /** The catalog id -- `title` -- or null off iOS. */
  static get modelId(): string | null {
    return NativeTitle?.modelId ?? null;
  }

  /** The Hugging Face repo the model folder comes from, or null off iOS. */
  static get modelRepo(): string | null {
    return NativeTitle?.modelRepo ?? null;
  }

  /** The revision this SDK resolves -- `v0.1.0` -- or null off iOS. */
  static get modelRevision(): string | null {
    return NativeTitle?.modelRevision ?? null;
  }

  /**
   * Whether {@link modelRevision} names a tag rather than a branch. **True**,
   * which is the good answer and the opposite of Align's.
   *
   * Reported anyway, and computed rather than hardcoded, for the reason
   * upstream's own catalog note gives: the entry used to carry a justification
   * for pinning `main` that had already expired, and `ModelCatalogTests` does not
   * cover Title, "so nothing here would have caught the staleness". A value that
   * is read is a value that cannot go stale quietly.
   */
  static get revisionIsPinned(): boolean {
    return NativeTitle?.revisionIsPinned ?? false;
  }

  /** Upstream's own one-line description of the model, off the catalog rather
   *  than out of this package's README. Null off iOS. */
  static get modelSummary(): string | null {
    return NativeTitle?.modelSummary ?? null;
  }

  /**
   * The seven files the model folder consists of, in upstream's declaration
   * order: the weights, the shard index, the config, the generation config, the
   * tokenizer, its config, and the chat template.
   *
   * Read off `TitleModel.files[.apple]` rather than listed here, so it is the
   * same list the downloader fetches and the same list
   * {@link Title.missingFiles} checks. Empty off iOS.
   *
   * It is also the shape difference worth knowing about this model: every other
   * model in this catalog resolves to one compiled artifact plus sidecars, and
   * this one resolves to an MLX *folder* that has to be handed over whole.
   */
  static get modelFiles(): string[] {
    return NativeTitle?.modelFiles ?? [];
  }

  /** The runnable file among them: `model.safetensors`. Null off iOS. */
  static get weightsFileName(): string | null {
    return NativeTitle?.weightsFileName ?? null;
  }

  /**
   * The oldest iOS Title's runtime runs on: 17.
   *
   * MLX's floor, and the reason every model in this repo has one: it is a
   * dependency floor rather than an artifact one, so desert-ant-core's whole
   * package had to rise to it and iOS 16 went with it. `0` off iOS.
   */
  static get osFloorIOS(): number {
    return NativeTitle?.osFloorIOS ?? 0;
  }

  /** The decode cap sent when a call does not say: 96 tokens, upstream's own
   *  default argument. */
  static get defaultMaxTokens(): number {
    return NativeTitle?.defaultMaxTokens ?? FALLBACK_MAX_TOKENS;
  }

  /**
   * Download the model folder and get it ready.
   *
   * **~280 MB**, so this is a call to put behind a tap and a progress bar rather
   * than on mount -- the third-largest in this family after Voz's ~490 MB and
   * Clips' ~288 MB. Seven files: 6-bit quantized weights, a shard index, two
   * configs, and the byte-level BPE tokenizer with its config and chat template.
   *
   * Gate it on {@link canDownloadWeights}, not on {@link isSupported}. It works
   * whether or not this build can generate, and what it leaves behind --
   * {@link Title.resolvedDirectory} -- is useful either way.
   */
  static async load(options: TitleLoadOptions = {}): Promise<Title> {
    const title = Title.create(options);
    try {
      await title.warm(options.onProgress);
      return title;
    } catch (error) {
      title.release();
      throw error;
    }
  }

  /**
   * Create the model without touching the network. The folder is resolved on the
   * first {@link warm} or {@link prepare}.
   *
   * Use it to ask {@link isDownloaded} before deciding whether to offer the
   * download -- `create()` costs nothing and starts nothing.
   */
  static create(options: TitleLoadOptions = {}): Title {
    const native = Title.requireNative();
    const maxTokens = options.maxTokens ?? Title.defaultMaxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw invalid(
        `'${String(options.maxTokens)}' is not a token cap; expected a positive whole number of tokens`
      );
    }
    if (options.directory !== undefined && options.directory.trim().length === 0) {
      throw invalid('`directory` was blank; omit it to use the managed cache, or pass a real path');
    }
    try {
      return new Title(native.createModel({ directory: options.directory, maxTokens }));
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * The native module, or a refusal naming the reason.
   *
   * Gated on `canDownloadWeights` rather than on `isSupported`, which is the one
   * place this package deliberately diverges from its eleven siblings. Refusing
   * to construct a model because the build cannot generate would hide a working
   * download behind a missing generator, and the download is the thing this
   * package can actually do.
   */
  private static requireNative(): NonNullable<typeof NativeTitle> {
    if (!NativeTitle || !NativeTitle.canDownloadWeights) {
      throw toDesertAntError(
        Object.assign(
          new Error(
            NativeTitle?.unsupportedReason ??
              'Title is not available here. Gate the feature on `Title.canDownloadWeights`.'
          ),
          { code: 'ERR_UNSUPPORTED_PLATFORM' }
        ),
        MODEL
      );
    }
    return NativeTitle;
  }

  private released = false;

  private constructor(private readonly native: NativeTitleModel) {}

  /** Whether the seven-file model folder is on the device, complete and
   *  verified. An interrupted download is not. */
  isDownloaded(): boolean {
    this.assertAlive();
    try {
      return this.native.isDownloaded();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * The model folder this instance would use, or `''` when there is not one.
   *
   * Three answers in order: what {@link prepare} resolved, else the `directory`
   * you passed, else the managed cache entry for the pinned revision if a
   * previous run already downloaded it. The third exists because
   * {@link isDownloaded} consults that cache too, and two members of one object
   * disagreeing about whether a 280 MB folder exists is a bug — one the example
   * app's self-test found.
   *
   * More useful here than in the other packages, and not only for bug reports:
   * upstream's API is `Titles(directory:)` over a folder you populated, so this
   * string is exactly what a native caller that does have the `MLX` trait needs
   * from this one.
   */
  resolvedDirectory(): string {
    this.assertAlive();
    try {
      return this.native.resolvedDirectory();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Which of {@link Title.modelFiles} are not in {@link resolvedDirectory}. All
   * seven when there is no folder, none after a complete download.
   *
   * Checked against upstream's declared list rather than one written here, so a
   * rename upstream shows up as a missing file rather than as a shorter check.
   */
  missingFiles(): string[] {
    this.assertAlive();
    try {
      return this.native.missingFiles();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /** How many bytes of the folder are on disk. `0` when there is no folder. */
  installedBytes(): number {
    this.assertAlive();
    try {
      return this.native.installedBytes();
    } catch (error) {
      throw toDesertAntError(error, MODEL);
    }
  }

  /**
   * Download and verify the model folder, so the first {@link describe} does not
   * have to.
   *
   * Identical to {@link download} and to what {@link Title.load} does. All three
   * names exist so every model in this repo reads the same way.
   */
  async warm(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    this.assertAlive();
    await this.run(onProgress, (jobId) => Title.requireNative().prepare(this.native, jobId));
  }

  /** The same call as {@link warm}. */
  async download(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /** The same call as {@link warm}, under the name the native side uses. */
  async prepare(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.warm(onProgress);
  }

  /**
   * Write a title and a description for a passage of text.
   *
   * **Throws `ERR_UNSUPPORTED_PLATFORM` in this build.** Gate it on
   * {@link Title.isSupported}. It does not return an empty card and it does not
   * assemble one from the passage by other means: a method that silently produced
   * nothing would be the one outcome worse than an absent one, because an app
   * would ship it.
   *
   * When the trait is enabled, this is one call with no options: the prompt is
   * fixed (upstream's, byte for byte -- the model was trained on one instruction
   * and a reworded one measurably degrades it) and the only tunable, the decode
   * cap, belongs to the model instance rather than to the call.
   *
   * The text is refused if it is empty or whitespace. Upstream does not refuse
   * it: `describe` substitutes the passage into a fixed prompt, so an empty one
   * asks a 350M instruct model to name nothing and it obliges with something
   * invented.
   */
  async describe(text: string, options: DescribeOptions = {}): Promise<Card> {
    this.assertAlive();
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw invalid(
        'describe needs a passage of text; an empty or whitespace-only one makes the model ' +
          'invent a title for nothing'
      );
    }
    return this.run(options.onProgress, async (jobId) => {
      await Title.requireNative().describe(this.native, text, jobId);
      // Synchronous on purpose: the record is encoded on the JavaScript thread.
      // See `native.ts`.
      return this.native.takeCard(jobId);
    });
  }

  /**
   * Release the model. Calling it twice is a no-op; using the instance afterwards
   * throws `ERR_RELEASED`.
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
    const jobId = `title-${nextJobId}`;
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
        Object.assign(new Error('This Title was released and can no longer be used.'), {
          code: 'ERR_RELEASED',
        }),
        MODEL
      );
    }
  }
}

function invalid(message: string) {
  return toDesertAntError(
    Object.assign(new Error(message), { code: 'ERR_INVALID_ARGUMENT' }),
    MODEL
  );
}
