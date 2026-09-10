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

export interface NativeClearModel extends SharedObject<{ progress: (event: ProgressEvent) => void }> {
  isDownloaded(): boolean;
  download(jobId: string): Promise<void>;
  load(jobId: string): Promise<void>;
  enhanceFile(
    inputPath: string,
    outputPath: string,
    options: NativeEnhanceOptions,
    jobId: string
  ): Promise<ClearMetrics>;
  enhanceBuffer(
    input: NativeClearAudio,
    options: NativeEnhanceOptions,
    jobId: string
  ): Promise<NativeClearAudio>;
}

interface DesertAntClearModule extends NativeModule {
  /** False when the platform cannot run Clear at all -- today, an Android build
   *  whose ABI has no LiteRT binary. */
  readonly isSupported: boolean;
  /** The desert-ant-core version this binary links against. */
  readonly nativeCoreVersion: string;
  readonly ClearModel: new (options: { variant: string; directory?: string }) => NativeClearModel;
  readonly ClearAudio: new (
    channelCount: number,
    frameCount: number,
    sampleRate: number
  ) => NativeClearAudio;
}

export default requireNativeModule<DesertAntClearModule>('DesertAntClear');
