import { requireNativeModule } from 'expo';
// The instance types, not the constructors. `expo`'s own `SharedObject` export is
// `typeof ExpoGlobal.SharedObject` -- the static side -- so an interface that
// extends it inherits no `addListener`.
import type { NativeModule, SharedObject } from 'expo-modules-core/types';

import type { ClearMetrics, ProgressEvent } from './types';

/**
 * The native surface, declared once for both platforms.
 *
 * Apple implements it with the Expo Modules 2.0 macros and Android with the
 * classic Kotlin DSL (2.0 has no Kotlin implementation yet). This file is where
 * that stops mattering: if the two halves ever drift, they drift from *this*,
 * and the class above it never notices.
 *
 * Nothing here is exported from the package. Everything the caller touches goes
 * through `Clear`.
 */

/** The wire form of {@link import('./types').EnhanceOptions}: presets resolved,
 *  no callbacks, no optionals the native records have to guess at. */
export interface NativeEnhanceOptions {
  strength: number;
  masteringEnabled: boolean;
  targetLUFS: number;
  peakCeilingDBFS: number;
  maxGainDB: number;
  outputSampleRate: number;
  channelMode: string;
  balanceChannelsLUFS?: number;
}

/**
 * What a file call returns. `outputPath` is where the audio *actually* landed,
 * which is not always where it was asked to go: on iOS a non-WAV input is decoded
 * in memory and re-encoded as WAV, so the extension can change.
 */
export type NativeFileMetrics = ClearMetrics & { outputPath?: string | null };

export interface NativeClearAudio extends SharedObject {
  readonly channelCount: number;
  readonly frameCount: number;
  readonly sampleRate: number;
  readonly metrics: ClearMetrics;
  /** Copy `data` into `channel`. `data.length` must equal `frameCount`. */
  write(channel: number, data: Float32Array): void;
  /** Copy `channel` into `into`. `into.length` must equal `frameCount`. */
  read(channel: number, into: Float32Array): void;
}

/**
 * State and synchronous access to it -- nothing async, and no constructor.
 *
 * Both absences are the Expo Modules 2.0 macros talking: `@JS async` compiles on
 * an `@ExpoModule` class but not on a `@SharedObject` (the prototype binding is a
 * synchronous function type), and a `@JS init` is called without `try` so it
 * cannot validate. The asynchronous work and the construction are therefore
 * module functions taking the object, below. Android mirrors the same split.
 */
export interface NativeClearModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
}

interface DesertAntClearModule extends NativeModule {
  /** False when the platform cannot run Clear at all -- today, an Android build
   *  whose ABI has no LiteRT binary. */
  readonly isSupported: boolean;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;

  createModel(options: { variant: string; directory?: string }): NativeClearModel;
  createAudio(channelCount: number, frameCount: number, sampleRate: number): NativeClearAudio;

  download(model: NativeClearModel, jobId: string): Promise<void>;
  load(model: NativeClearModel, jobId: string): Promise<void>;
  /**
   * Resolves to nothing. The metrics are collected with `takeMetrics`.
   *
   * The `Promise<void>` is the point. An async native function's return value is
   * encoded after its last suspension, and on iOS that happens on the
   * cooperative thread pool rather than the JavaScript thread -- which corrupts
   * the Hermes heap and segfaults the process, usually somewhere else entirely.
   * `Clear.enhance` makes both calls, so the public API is unaffected.
   */
  enhanceFile(
    model: NativeClearModel,
    inputPath: string,
    outputPath: string,
    options: NativeEnhanceOptions,
    jobId: string
  ): Promise<void>;
  /**
   * Resolves to nothing, for the same reason `enhanceFile` does. The audio is
   * collected with `takeEnhancedAudio` and the metrics with `takeMetrics`,
   * because returning a `SharedObject` from an async native function segfaults
   * on iOS (expo-modules-core 57) while the same return from a synchronous one
   * is fine. `Clear.enhanceSamples` makes all three calls, so the public API is
   * unaffected.
   */
  enhanceBuffer(
    model: NativeClearModel,
    input: NativeClearAudio,
    options: NativeEnhanceOptions,
    jobId: string
  ): Promise<void>;
  /** Collect the buffer `enhanceBuffer` produced for `jobId`. Once per job. */
  takeEnhancedAudio(model: NativeClearModel, jobId: string): NativeClearAudio;
  /** Collect the metrics `enhanceFile` or `enhanceBuffer` produced for `jobId`.
   *  Synchronous, and so encoded on the JavaScript thread. Once per job. */
  takeMetrics(model: NativeClearModel, jobId: string): NativeFileMetrics;
}

export default requireNativeModule<DesertAntClearModule>('DesertAntClear');
