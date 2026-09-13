/**
 * The parts of the surface that are ours rather than Core ML's: what happens off
 * iOS, which arguments are rejected before a native call is made at all, how
 * `minConfidence`'s two TypeScript states become two wire fields, and how the
 * bias presets are read rather than duplicated.
 *
 * Detection itself is not testable here -- it needs the weights and real audio --
 * so the native module is a spy and the example app proves the rest.
 */

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    release: jest.fn(),
    addListener: jest.fn((_event: string, listener: Listener) => {
      listeners.push(listener);
      return {
        remove: () => {
          listeners.splice(listeners.indexOf(listener), 1);
        },
      };
    }),
  };
  return {
    listeners,
    model,
    module: {
      isSupported: true,
      nativeCoreVersion: '3.1.0',
      modelRevision: '612592c10ad7b2a51f3237725448a1aad212480b',
      biasThresholds: { precision: 0.75, balanced: 0.65, recall: 0.5 },
      fillerTypes: ['uh', 'um', 'hmm', 'and', 'other'],
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      analyzeFile: jest.fn(async () => result()),
      analyzeSamples: jest.fn(async () => result()),
      reconcileWords: jest.fn(() => [{ text: 'so', start: 0, end: 0.3 }]),
      ...overrides,
    },
  };
}

function result() {
  return {
    fillers: [{ start: 1.2, end: 1.46, durationSec: 0.26, confidence: 0.91, type: 'um' }],
    durationSec: 12,
    processingSec: 0.08,
    realtimeFactor: 150,
    timings: { decodeSec: 0.02, inferenceSec: 0.05, prepSec: 0.005, groupSec: 0.001, labelingSec: 0.004 },
    modelRevision: '612592c10ad7b2a51f3237725448a1aad212480b',
    modelRuntime: 'coreml',
  };
}

function load(native: unknown) {
  let exports!: typeof import('../Uhm');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    exports = require('../Uhm');
  });
  return exports.Uhm;
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (Android, or a build that did not link it)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const Uhm = load(null);
    expect(Uhm.isSupported).toBe(false);
    expect(Uhm.unsupportedReason).toMatch(/Apple platforms only/);
    expect(Uhm.nativeCoreVersion).toBeNull();
    expect(Uhm.modelRevision).toBeNull();
  });

  it('still answers the thresholds and types, which are constants rather than device facts', () => {
    const Uhm = load(null);
    expect(Uhm.biasThresholds).toEqual({ precision: 0.75, balanced: 0.65, recall: 0.5 });
    expect(Uhm.fillerTypes).toContain('um');
  });

  it('throws ERR_UNSUPPORTED_PLATFORM when actually used', () => {
    const Uhm = load(null);
    expect(() => Uhm.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'uhm' })
    );
    expect(() => Uhm.reconcileWords([], [])).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM' })
    );
  });
});

describe('static metadata', () => {
  it('passes the native values through', () => {
    const Uhm = load(fakeNative().module);
    expect(Uhm.isSupported).toBe(true);
    expect(Uhm.unsupportedReason).toBeNull();
    expect(Uhm.nativeCoreVersion).toBe('3.1.0');
    expect(Uhm.modelRevision).toMatch(/^612592c/);
    expect(Uhm.fillerTypes).toEqual(['uh', 'um', 'hmm', 'and', 'other']);
  });

  it('reads the bias thresholds off the Swift enum rather than a second copy', () => {
    // A republished calibration changes these upstream; nothing here should
    // need editing for the new numbers to reach a caller.
    const native = fakeNative({ biasThresholds: { precision: 0.8, balanced: 0.6, recall: 0.4 } });
    expect(load(native.module).biasThresholds).toEqual({
      precision: 0.8,
      balanced: 0.6,
      recall: 0.4,
    });
  });
});

describe('load', () => {
  it('warms the model and hands back an instance', async () => {
    const native = fakeNative();
    const uhm = await load(native.module).load();
    expect(native.module.load).toHaveBeenCalledTimes(1);
    expect(uhm.isDownloaded()).toBe(true);
  });

  it('passes the compute-unit choice through, defaulting to upstream’s own', () => {
    const native = fakeNative();
    const Uhm = load(native.module);
    Uhm.create();
    expect(native.module.createModel).toHaveBeenCalledWith({
      directory: undefined,
      computeUnits: 'all',
    });
    Uhm.create({ computeUnits: 'cpuOnly', directory: '/tmp/m' });
    expect(native.module.createModel).toHaveBeenLastCalledWith({
      directory: '/tmp/m',
      computeUnits: 'cpuOnly',
    });
  });

  it('releases the half-built model when warming fails', async () => {
    const native = fakeNative();
    native.module.load.mockRejectedValueOnce(
      Object.assign(new Error('no space'), { code: 'ERR_MODEL_UNAVAILABLE' })
    );
    await expect(load(native.module).load()).rejects.toMatchObject({
      code: 'ERR_MODEL_UNAVAILABLE',
    });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('treats download as the same call, because upstream fuses them', async () => {
    const native = fakeNative();
    await load(native.module).create().download();
    expect(native.module.load).toHaveBeenCalledTimes(1);
  });
});

describe('analyze', () => {
  it('strips the file:// scheme and sends the balanced preset by default', async () => {
    const native = fakeNative();
    await load(native.module).create().analyze({ uri: 'file:///tmp/a%20talk.m4a' });
    const [, path, options] = native.module.analyzeFile.mock.calls[0]!;
    expect(path).toBe('/tmp/a talk.m4a');
    expect(options).toEqual({
      bias: 'balanced',
      includeTypes: true,
      minConfidence: 0.65,
      useBiasThreshold: true,
      minDurationSec: 0.12,
    });
  });

  it('sends an explicit threshold as an override rather than as the preset', async () => {
    const native = fakeNative();
    await load(native.module)
      .create()
      .analyze({ uri: '/tmp/a.wav', bias: 'recall', minConfidence: 0.4, minDurationSec: 0.2 });
    const [, , options] = native.module.analyzeFile.mock.calls[0]!;
    expect(options).toEqual({
      bias: 'recall',
      includeTypes: true,
      minConfidence: 0.4,
      useBiasThreshold: false,
      minDurationSec: 0.2,
    });
  });

  it('keeps a zero threshold distinguishable from saying nothing', async () => {
    // The reason `useBiasThreshold` exists: 0 is a threshold a caller can mean.
    const native = fakeNative();
    await load(native.module).create().analyze({ uri: '/tmp/a.wav', minConfidence: 0 });
    const [, , options] = native.module.analyzeFile.mock.calls[0]!;
    expect(options.minConfidence).toBe(0);
    expect(options.useBiasThreshold).toBe(false);
  });

  it('can turn the type labeller off', async () => {
    const native = fakeNative();
    await load(native.module).create().analyze({ uri: '/tmp/a.wav', includeTypes: false });
    const [, , options] = native.module.analyzeFile.mock.calls[0]!;
    expect(options.includeTypes).toBe(false);
  });

  it('returns the result untouched', async () => {
    const native = fakeNative();
    const found = await load(native.module).create().analyze({ uri: '/tmp/a.wav' });
    expect(found.fillers).toHaveLength(1);
    expect(found.fillers[0]!.type).toBe('um');
    expect(found.realtimeFactor).toBe(150);
    expect(found.timings.inferenceSec).toBe(0.05);
  });

  it('rejects a missing uri, an unknown bias, and out-of-range numbers', async () => {
    const native = fakeNative();
    const uhm = load(native.module).create();
    await expect(uhm.analyze({ uri: '' })).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
    await expect(
      uhm.analyze({ uri: '/a.wav', bias: 'aggressive' as never })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
    await expect(uhm.analyze({ uri: '/a.wav', minConfidence: 1.5 })).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    await expect(uhm.analyze({ uri: '/a.wav', minDurationSec: -1 })).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.analyzeFile).not.toHaveBeenCalled();
  });

  it('wraps a native failure as a DesertAntError with its code', async () => {
    const native = fakeNative();
    native.module.analyzeFile.mockRejectedValueOnce(
      Object.assign(new Error('bad audio'), { code: 'ERR_AUDIO_DECODE_FAILED' })
    );
    await expect(
      load(native.module).create().analyze({ uri: '/tmp/a.wav' })
    ).rejects.toMatchObject({
      name: 'DesertAntError',
      code: 'ERR_AUDIO_DECODE_FAILED',
      model: 'uhm',
    });
  });
});

describe('analyzeSamples', () => {
  it('defaults to the model rate and converts a plain array', async () => {
    const native = fakeNative();
    await load(native.module).create().analyzeSamples([0.1, 0.2, 0.3]);
    const [, samples, rate] = native.module.analyzeSamples.mock.calls[0]!;
    expect(samples).toBeInstanceOf(Float32Array);
    expect(rate).toBe(16_000);
  });

  it('passes another rate through for the native resampler', async () => {
    const native = fakeNative();
    await load(native.module).create().analyzeSamples(new Float32Array(16), 48_000);
    const [, , rate] = native.module.analyzeSamples.mock.calls[0]!;
    expect(rate).toBe(48_000);
  });

  it('rejects empty audio and a nonsense rate before touching native code', async () => {
    const native = fakeNative();
    const uhm = load(native.module).create();
    await expect(uhm.analyzeSamples(new Float32Array(0))).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    await expect(uhm.analyzeSamples(new Float32Array(4), 0)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.analyzeSamples).not.toHaveBeenCalled();
  });
});

describe('reconcileWords', () => {
  it('forwards the words, the spans and the default options', () => {
    const native = fakeNative();
    const words = [{ text: 'so', start: 0, end: 0.5 }];
    const fillers = [{ start: 0.3, end: 0.6 }];
    expect(load(native.module).reconcileWords(words, fillers)).toHaveLength(1);
    expect(native.module.reconcileWords).toHaveBeenCalledWith(words, fillers, {
      minOverlapFraction: 0.5,
      splitContainedWords: false,
    });
  });

  it('honours explicit options', () => {
    const native = fakeNative();
    load(native.module).reconcileWords([], [], {
      minOverlapFraction: 0.2,
      splitContainedWords: true,
    });
    expect(native.module.reconcileWords).toHaveBeenCalledWith([], [], {
      minOverlapFraction: 0.2,
      splitContainedWords: true,
    });
  });

  it('rejects an overlap fraction outside 0..1', () => {
    const native = fakeNative();
    expect(() => load(native.module).reconcileWords([], [], { minOverlapFraction: 2 })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(native.module.reconcileWords).not.toHaveBeenCalled();
  });
});

describe('progress', () => {
  it('delivers only the events belonging to its own call', async () => {
    const native = fakeNative();
    const seen: number[] = [];
    native.module.analyzeFile.mockImplementationOnce(
      async (_m: unknown, _p: string, _o: unknown, jobId: string) => {
        native.listeners.forEach((l) => l({ jobId, phase: 'detecting', fraction: 0.5 }));
        native.listeners.forEach((l) =>
          l({ jobId: 'uhm-other', phase: 'detecting', fraction: 0.9 })
        );
        return result();
      }
    );
    await load(native.module)
      .create()
      .analyze({ uri: '/tmp/a.wav', onProgress: (event) => seen.push(event.fraction) });
    expect(seen).toEqual([0.5]);
  });

  it('unsubscribes when the call finishes', async () => {
    const native = fakeNative();
    await load(native.module).create().warm(() => {});
    expect(native.listeners).toHaveLength(0);
  });
});

describe('release', () => {
  it('releases the native object once, however often it is called', () => {
    const native = fakeNative();
    const uhm = load(native.module).create();
    uhm.release();
    uhm.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('reports ERR_RELEASED rather than crashing in native code', async () => {
    const native = fakeNative();
    const uhm = load(native.module).create();
    uhm.release();
    expect(() => uhm.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(uhm.analyze({ uri: '/tmp/a.wav' })).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    expect(native.module.analyzeFile).not.toHaveBeenCalled();
  });
});
