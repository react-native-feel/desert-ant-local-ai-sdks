import { requireOptionalNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { Clip, ProgressEvent, TranscriptSentence, TranscriptWord } from './types';

/**
 * The native surface. Apple only.
 *
 * Unlike Voz, that is a *this SDK* limit rather than an upstream one:
 * `Sources/Clips/Catalog.swift` does declare `.android`, `.linux` and `.windows`
 * file lists (a LiteRT pair at the same widths). What does not exist yet is a
 * published `ai.desertant:clips` artifact to bind to -- Desert Ant lists Kotlin
 * as "coming soon" -- so there is nothing for an Android half of this module to
 * call. When it lands, only `android/` appears; this file does not change.
 *
 * Hence `requireOptionalNativeModule`: off iOS it resolves to `null` at import
 * time instead of throwing, so an app can ship one bundle, check
 * `Clips.isSupported`, and hide the feature.
 */

/** Resolved on the TypeScript side so the native record has one representation
 *  of a limit rather than encoding "absent" and "auto" in the same value. */
export interface NativeFindOptions {
  /** Ignored when `useDurationCurve` is true. */
  limit: number;
  /** True lets the model pick a count from the transcript's duration. */
  useDurationCurve: boolean;
  padding: number;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor, for
 * the same two Expo Modules 2.0 reasons the other packages here hit: `@JS async`
 * does not compile on a `@SharedObject`, and a `@JS init` cannot throw.
 */
export interface NativeClipsModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
}

interface DesertAntClipsModule extends NativeModule {
  /**
   * False where this build cannot run Clips. On iOS this is a real runtime
   * check, not a constant: `clips.mlmodelc` is a **multifunction** Core ML
   * package, which is an iOS 18 feature, and nothing upstream enforces the floor
   * it declares -- so an iOS 17 device would otherwise reach an opaque Core ML
   * load failure instead of a legible refusal.
   */
  readonly isSupported: boolean;
  /** Why `isSupported` is false, or null when it is true. */
  readonly unsupportedReason: string | null;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  /** The pinned model revision the SDK resolves. */
  readonly modelRevision: string;
  /** The default clip limit upstream ships (10). */
  readonly defaultLimit: number;

  createModel(options: { directory?: string; computeUnits: string }): NativeClipsModel;

  /** Download and build the session. Upstream fuses the two -- see `Clips.warm`. */
  load(model: NativeClipsModel, jobId: string): Promise<void>;

  findClips(
    model: NativeClipsModel,
    sentences: TranscriptSentence[],
    options: NativeFindOptions,
    jobId: string
  ): Promise<Clip[]>;

  /**
   * Group timed words into sentences. Pure, synchronous, and needs no model, so
   * it is a module function rather than one on the shared object.
   */
  sentencesFromWords(words: TranscriptWord[], runOnLimit: number): TranscriptSentence[];
}

export default requireOptionalNativeModule<DesertAntClipsModule>('DesertAntClips');
