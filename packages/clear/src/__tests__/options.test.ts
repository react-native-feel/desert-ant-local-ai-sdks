import { DesertAntError } from '@desert-ant-labs/react-native-core';

import { toNativeOptions } from '../options';

describe('toNativeOptions', () => {
  it('defaults to the Apple Podcasts spec with mastering on', () => {
    expect(toNativeOptions({})).toEqual({
      strength: 1,
      masteringEnabled: true,
      targetLUFS: -19,
      peakCeilingDBFS: -1.5,
      maxGainDB: 9,
      outputSampleRate: 48_000,
      channelMode: 'mono',
      balanceChannelsLUFS: undefined,
    });
  });

  it('resolves a preset name to its LUFS target', () => {
    expect(toNativeOptions({ targetLUFS: 'spotify' })).toMatchObject({
      masteringEnabled: true,
      targetLUFS: -14,
    });
  });

  it('takes a raw number as the target', () => {
    expect(toNativeOptions({ targetLUFS: -23.5 })).toMatchObject({ targetLUFS: -23.5 });
  });

  // The reason `targetLUFS` is two fields on the wire: null and "not given" mean
  // different things, and one nullable field cannot carry both.
  it('turns an explicit null into a bypass, not a missing target', () => {
    const options = toNativeOptions({ targetLUFS: null });
    expect(options.masteringEnabled).toBe(false);
    expect(Number.isFinite(options.targetLUFS)).toBe(true);
  });

  it('leaves mastering on when targetLUFS is simply absent', () => {
    expect(toNativeOptions({ strength: 0.5 }).masteringEnabled).toBe(true);
  });

  it('rejects a preset name that does not exist', () => {
    expect(() => toNativeOptions({ targetLUFS: 'tidal' as never })).toThrow(DesertAntError);
    expect(() => toNativeOptions({ targetLUFS: 'tidal' as never })).toThrow(/not a loudness preset/);
  });

  it('passes the channel mode and balance through untouched', () => {
    expect(toNativeOptions({ channelMode: 'preserve', balanceChannelsLUFS: -20 })).toMatchObject({
      channelMode: 'preserve',
      balanceChannelsLUFS: -20,
    });
  });
});
