/**
 * The parts of the surface that are ours rather than Core ML's: what happens off
 * iOS or below iOS 18, which arguments are rejected before a native call is made
 * at all, how `limit`'s three TypeScript states become two wire fields, and the
 * short-transcript case answered without a download.
 *
 * Selection itself is not testable here -- it needs the weights and a Neural
 * Engine -- so the native module is a spy and the example app proves the rest.
 */

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    // The async half resolves to nothing; the result is collected
    // synchronously. See `native.ts`.
    takeClips: jest.fn(() => [clip()]),
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
      unsupportedReason: null,
      nativeCoreVersion: '3.1.0',
      modelRevision: 'v0.1.0',
      defaultLimit: 10,
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      findClips: jest.fn(async () => undefined),
      sentencesFromWords: jest.fn(() => [
        { text: 'One two.', start: 0, end: 1 },
        { text: 'Three four.', start: 1, end: 2 },
      ]),
      ...overrides,
    },
  };
}

function clip() {
  return {
    rank: 0,
    text: 'A good moment.',
    sentenceIds: [3, 4],
    score: 2.4,
    percentile: 0.95,
    estimatedDurationSec: 6,
    ranges: [{ start: 12.1, end: 18.4 }],
    durationSec: 6.3,
  };
}

function sentences(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    text: `Sentence ${i}.`,
    start: i,
    end: i + 1,
  }));
}

function load(native: unknown) {
  let exports!: typeof import('../Clips');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    exports = require('../Clips');
  });
  return exports.Clips;
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (Android, or a build that did not link it)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const Clips = load(null);
    expect(Clips.isSupported).toBe(false);
    expect(Clips.unsupportedReason).toMatch(/Apple platforms only/);
    expect(Clips.nativeCoreVersion).toBeNull();
    expect(Clips.modelRevision).toBeNull();
  });

  it('still reports a usable default limit', () => {
    expect(load(null).defaultLimit).toBe(10);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM when actually used', () => {
    const Clips = load(null);
    expect(() => Clips.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'clips' })
    );
  });
});

describe('on an OS the multifunction artifact cannot load', () => {
  it('passes the native reason through rather than inventing one', () => {
    const native = fakeNative({
      isSupported: false,
      unsupportedReason: 'Clips needs iOS 18 / macOS 15 / tvOS 18 / visionOS 2 / watchOS 11; this system is older',
    });
    const Clips = load(native.module);
    expect(Clips.isSupported).toBe(false);
    expect(Clips.unsupportedReason).toMatch(/needs iOS 18/);
  });
});

describe('static metadata', () => {
  it('passes the native values through', () => {
    const Clips = load(fakeNative().module);
    expect(Clips.isSupported).toBe(true);
    expect(Clips.unsupportedReason).toBeNull();
    expect(Clips.nativeCoreVersion).toBe('3.1.0');
    expect(Clips.modelRevision).toBe('v0.1.0');
    expect(Clips.defaultLimit).toBe(10);
  });
});

describe('toSentences', () => {
  it('forwards the words and the default run-on limit', () => {
    const native = fakeNative();
    const Clips = load(native.module);
    const words = [{ text: 'One', start: 0, end: 0.4 }];
    expect(Clips.toSentences(words)).toHaveLength(2);
    expect(native.module.sentencesFromWords).toHaveBeenCalledWith(words, 320);
  });

  it('honours an explicit run-on limit', () => {
    const native = fakeNative();
    load(native.module).toSentences([], { runOnLimit: 80 });
    expect(native.module.sentencesFromWords).toHaveBeenCalledWith([], 80);
  });
});

describe('load', () => {
  it('warms the model and hands back an instance', async () => {
    const native = fakeNative();
    const clips = await load(native.module).load();
    expect(native.module.load).toHaveBeenCalledTimes(1);
    expect(clips.isDownloaded()).toBe(true);
  });

  it('passes the compute-unit choice through, defaulting to the ANE path', () => {
    const native = fakeNative();
    const Clips = load(native.module);
    Clips.create();
    expect(native.module.createModel).toHaveBeenCalledWith({
      directory: undefined,
      computeUnits: 'cpuAndNeuralEngine',
    });
    Clips.create({ computeUnits: 'cpuOnly', directory: '/tmp/m' });
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

describe('find', () => {
  it('defaults to the model limit and does not ask for the duration curve', async () => {
    const native = fakeNative();
    await load(native.module).create().find({ sentences: sentences(5) });
    const [, , options] = native.module.findClips.mock.calls[0]!;
    expect(options).toEqual({ limit: 10, useDurationCurve: false, padding: 0.15 });
  });

  it('turns a null limit into the duration curve rather than a zero', async () => {
    const native = fakeNative();
    await load(native.module).create().find({ sentences: sentences(5), limit: null });
    const [, , options] = native.module.findClips.mock.calls[0]!;
    expect(options.useDurationCurve).toBe(true);
  });

  it('passes an explicit limit and padding', async () => {
    const native = fakeNative();
    await load(native.module).create().find({ sentences: sentences(5), limit: 3, padding: 0.5 });
    const [, , options] = native.module.findClips.mock.calls[0]!;
    expect(options).toEqual({ limit: 3, useDurationCurve: false, padding: 0.5 });
  });

  it('returns the clips untouched', async () => {
    const native = fakeNative();
    const found = await load(native.module).create().find({ sentences: sentences(5) });
    expect(found).toHaveLength(1);
    expect(found[0]!.ranges).toEqual([{ start: 12.1, end: 18.4 }]);
    expect(found[0]!.percentile).toBe(0.95);
  });

  it('answers a too-short transcript without touching the model', async () => {
    // Upstream returns [] below three sentences; doing it here saves a ~288 MB
    // download for a call that cannot return anything.
    const native = fakeNative();
    const found = await load(native.module).create().find({ sentences: sentences(2) });
    expect(found).toEqual([]);
    expect(native.module.findClips).not.toHaveBeenCalled();
  });

  it('rejects a nonsense limit', async () => {
    const native = fakeNative();
    await expect(
      load(native.module).create().find({ sentences: sentences(5), limit: 0 })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
    expect(native.module.findClips).not.toHaveBeenCalled();
  });

  it('rejects negative padding', async () => {
    const native = fakeNative();
    await expect(
      load(native.module).create().find({ sentences: sentences(5), padding: -1 })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
    expect(native.module.findClips).not.toHaveBeenCalled();
  });

  it('wraps a native failure as a DesertAntError with its code', async () => {
    const native = fakeNative();
    native.module.findClips.mockRejectedValueOnce(
      Object.assign(new Error('selection failed'), { code: 'ERR_INFERENCE_FAILED' })
    );
    await expect(
      load(native.module).create().find({ sentences: sentences(5) })
    ).rejects.toMatchObject({ name: 'DesertAntError', code: 'ERR_INFERENCE_FAILED', model: 'clips' });
  });
});

describe('progress', () => {
  it('delivers only the events belonging to its own call', async () => {
    const native = fakeNative();
    const seen: number[] = [];
    native.module.load.mockImplementationOnce(async (_m: unknown, jobId: string) => {
      native.listeners.forEach((l) => l({ jobId, phase: 'loadingModel', fraction: 0.5 }));
      native.listeners.forEach((l) => l({ jobId: 'clips-other', phase: 'loadingModel', fraction: 0.9 }));
    });
    await load(native.module).create().warm((event) => seen.push(event.fraction));
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
    const clips = load(native.module).create();
    clips.release();
    clips.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('reports ERR_RELEASED rather than crashing in native code', async () => {
    const native = fakeNative();
    const clips = load(native.module).create();
    clips.release();
    expect(() => clips.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(clips.find({ sentences: sentences(5) })).rejects.toMatchObject({
      code: 'ERR_RELEASED',
    });
    expect(native.module.findClips).not.toHaveBeenCalled();
  });
});
