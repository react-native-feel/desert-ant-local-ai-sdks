import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { Card, ProgressEvent } from './types';

/**
 * The native surface. Apple only, and today half-lit.
 *
 * Two separate limits stacked, both upstream's rather than this package's choice,
 * and they are not the same kind of limit:
 *
 *   * **Platform.** `Sources/Title/Catalog.swift` declares files for `.apple` and
 *     nothing else, and `Package.swift` marks the model `appleOnly: true` --
 *     "`Title` is MLX, which has no other platform, and a product promising an
 *     artifact that cannot load is worse than its absence." Upstream's manifest
 *     records its Kotlin and JS SDKs as `none`. Hence
 *     `requireOptionalNativeModule`: off iOS this resolves to `null` at import
 *     time instead of throwing.
 *   * **Build.** Within Apple, generation is behind desert-ant-core's `MLX`
 *     package TRAIT, which a CocoaPods app has no way to enable -- React Native's
 *     `spm_dependency` takes no traits argument, Pods.xcodeproj has no field for
 *     one, and `xcodebuild` has no flag for one. So the module *does* exist and
 *     binds, `canDownloadWeights` is true and `prepare` works, and `isSupported`
 *     is false with a sentence saying why. The full account is at the top of
 *     `ios/TitleModule.swift`.
 *
 * That split is the reason there are two booleans here instead of one. Every
 * other package in this repo can say "supported or not"; this one has a working
 * half and a missing half and says so.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Title`.
 */

export interface NativeTitleLoadOptions {
  directory?: string;
  /** Validated on both sides before it gets here. */
  maxTokens: number;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeTitleModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  /** Whether the seven-file model folder is on the device, complete and
   *  verified. An interrupted download is not. */
  isDownloaded(): boolean;
  /** The folder this model would use: what `prepare` resolved, else the
   *  `directory` passed in, else the managed cache entry for the pinned revision
   *  if it is already there, else `''`. This is exactly the path a native caller
   *  with the trait would hand `Titles(directory:)`. */
  resolvedDirectory(): string;
  /** Which of the seven declared files are not in that folder. All seven when
   *  there is no folder, which is the truthful answer rather than an empty
   *  array. */
  missingFiles(): string[];
  /** How many bytes of them are on disk. `0` when there is no folder. */
  installedBytes(): number;
  /**
   * Hand over the card computed for `jobId`, and forget it.
   *
   * **Synchronous, and that is load-bearing rather than a convenience.** A `@JS
   * async` function's return value can be encoded off the JavaScript thread,
   * which segfaults the runtime -- it took Ear down through `Array<String>`,
   * Clear through `Record.encode`, and Emo through
   * `JavaScriptValuesBuffer.deinit`. A card is two short strings and would very
   * likely survive being returned directly; it comes back this way anyway,
   * because betting that the limit is about size when five reproductions say it
   * is about thread is how a package becomes the sixth.
   *
   * Throws `ERR_INFERENCE_FAILED` if there is nothing stored for `jobId`.
   */
  takeCard(jobId: string): Card;
}

interface DesertAntTitleModule extends NativeModule {
  /**
   * Whether this build can write a card. **False**, because the `MLX` package
   * trait is off and `Titles` therefore has no public initializer.
   */
  readonly isSupported: boolean;
  /** Whether the model folder can be downloaded, verified and inspected. True on
   *  Apple. The half of this package that works. */
  readonly canDownloadWeights: boolean;
  /** Whether this binary was built with the `MLX` trait. Reported rather than
   *  assumed, so the day it changes nothing here has to notice it by hand. */
  readonly mlxTraitEnabled: boolean;
  /** Why `isSupported` is false, or `''` when it is true. */
  readonly unsupportedReason: string;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The catalog id: `title`. */
  readonly modelId: string;
  /** The Hugging Face repo the model folder comes from. */
  readonly modelRepo: string;
  /** The revision this SDK resolves: `v0.1.0`. */
  readonly modelRevision: string;
  /** Whether that names a tag rather than a branch. True, unlike Align's. */
  readonly revisionIsPinned: boolean;
  /** Upstream's one-line description, off the catalog. */
  readonly modelSummary: string;
  /** The seven files upstream declares for Apple, in declaration order. */
  readonly modelFiles: string[];
  /** The runnable one among them: `model.safetensors`. */
  readonly weightsFileName: string;
  /** The oldest iOS the runtime runs on: 17, which is MLX's floor. */
  readonly osFloorIOS: number;
  /** The decode cap sent when the caller does not say: 96. */
  readonly defaultMaxTokens: number;

  createModel(options: NativeTitleLoadOptions): NativeTitleModel;

  /** Download and verify the ~280 MB model folder, and -- where the build can --
   *  load the generator from it. */
  prepare(model: NativeTitleModel, jobId: string): Promise<void>;

  /**
   * Write a card for `text` and store it under `jobId`, returning nothing.
   *
   * The `Promise<void>` is the point: see {@link NativeTitleModel.takeCard}.
   * Throws `ERR_UNSUPPORTED_PLATFORM` on every call in this build.
   */
  describe(model: NativeTitleModel, text: string, jobId: string): Promise<void>;
}

export default requireOptionalNativeModule<DesertAntTitleModule>('DesertAntTitle');
