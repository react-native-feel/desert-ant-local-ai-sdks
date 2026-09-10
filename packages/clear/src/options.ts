import { DesertAntError } from '@desert-ant-labs/react-native-core';

import type { NativeEnhanceOptions } from './native';
import { LOUDNESS_PRESETS, type EnhanceOptions, type LoudnessPreset } from './types';

/**
 * Resolve the caller's options into the flat record both native halves parse.
 *
 * The one thing worth noting: `targetLUFS` is three states in TypeScript
 * (a number, a preset name, or `null` for "leave the level alone") and two
 * fields on the wire. Splitting it here means neither native record has to
 * encode "absent" and "explicitly bypassed" in the same value.
 */
export function toNativeOptions(options: EnhanceOptions): NativeEnhanceOptions {
  const target = options.targetLUFS === undefined ? 'applePodcasts' : options.targetLUFS;
  const resolved =
    target === null
      ? null
      : typeof target === 'number'
        ? target
        : LOUDNESS_PRESETS[target as LoudnessPreset];

  if (target !== null && resolved === undefined) {
    throw new DesertAntError(
      'ERR_INVALID_ARGUMENT',
      'clear',
      `'${String(target)}' is not a loudness preset. Expected a number, null, or one of: ` +
        Object.keys(LOUDNESS_PRESETS).join(', ')
    );
  }

  return {
    strength: options.strength ?? 1,
    masteringEnabled: resolved !== null,
    targetLUFS: resolved ?? LOUDNESS_PRESETS.applePodcasts,
    peakCeilingDBFS: options.peakCeilingDBFS ?? -1.5,
    maxGainDB: options.maxGainDB ?? 9,
    outputSampleRate: options.outputSampleRate ?? 48_000,
    channelMode: options.channelMode ?? 'mono',
    balanceChannelsLUFS: options.balanceChannelsLUFS,
  };
}
