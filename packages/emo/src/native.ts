import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { EmoSuggestion, ProgressEvent } from './types';

/**
 * The native surface. Apple **and** Android.
 *
 * Emo is the second model in this repo with both halves, after Clear:
 * `Sources/Emo/Catalog.swift` lists `.apple`, `.android`, `.linux`, `.windows`
 * and `.web`, and `ai.desertant:emo` is published on Maven Central. Voz, Clips
 * and Uhm are Apple-only for reasons that are upstream's; this one is not.
 *
 * `requireOptionalNativeModule` all the same, for the case neither platform is
 * the issue: a web build, an app that installed the package but never ran
 * `prebuild`, a test process. It resolves to `null` rather than throwing at
 * import time, so `Emo.isSupported` is a question a caller can ask anywhere.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Emo`.
 */

/** Resolved on the TypeScript side so the native record carries one
 *  representation of each field rather than an absent-or-present optional. */
export interface NativeSuggestOptions {
  limit: number;
  /** `default`, `light`, `mediumLight`, `medium`, `mediumDark` or `dark`. */
  skinTone: string;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeEmoModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
}

interface DesertAntEmoModule extends NativeModule {
  /** False where this build cannot run Emo. True on iOS; true on Android where
   *  the ABI has a LiteRT build, false where it does not. */
  readonly isSupported: boolean;
  /** A sentence saying why `isSupported` is false, or an empty string when it is
   *  true. Built natively because only the native side knows *which* of the
   *  reasons applies -- on Android that is the device's own ABI list. */
  readonly unsupportedReason: string;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The pinned model revision the SDK resolves. */
  readonly modelRevision: string;
  /** The Hub repository the weights come from. */
  readonly modelRepo: string;
  /** Every skin tone the native enum accepts, so the TypeScript union and the
   *  Swift/Kotlin enums cannot drift apart unnoticed. */
  readonly skinTones: string[];
  /** The default `limit`, read off the Swift signature rather than duplicated. */
  readonly defaultLimit: number;

  createModel(options: { directory?: string }): NativeEmoModel;

  /** Download the weights and build the session. Upstream fuses the two -- see
   *  `Emo.warm`. */
  load(model: NativeEmoModel, jobId: string): Promise<void>;

  /**
   * Rank the vocabulary for `text` and return the top `limit`.
   *
   * No buffer-marshaling problem in either direction: a string goes in and a
   * short array of `{ emoji, confidence }` comes back, which is why this package
   * needs no equivalent of Clear's `ClearAudio` shared object.
   */
  suggest(
    model: NativeEmoModel,
    text: string,
    options: NativeSuggestOptions,
    jobId: string
  ): Promise<EmoSuggestion[]>;
}

export default requireOptionalNativeModule<DesertAntEmoModule>('DesertAntEmo');
