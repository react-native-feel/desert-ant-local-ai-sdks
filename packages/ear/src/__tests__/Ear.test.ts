/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, which arguments are rejected before a native
 * call is made at all, that `identify` reaches the file entry point with a plain
 * path, and that the numbers a UI shows are read off the binary rather than
 * duplicated here.
 *
 * Identification itself is not testable here -- it needs the weights and an
 * inference session -- so the native module is a spy and the example app proves
 * the rest.
 *
 * The one rule this file deliberately does NOT test is `isReliable`. It is
 * decided natively on both platforms, and a test here that recomputed it from a
 * margin would be asserting a second implementation into existence -- exactly the
 * drift the native decision exists to prevent.
 */

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

function detection(overrides: Record<string, unknown> = {}) {
  return {
    language: 'pt',
    confidence: 0.91,
    isReliable: true,
    candidates: [
      { language: 'pt', probability: 0.91 },
      { language: 'es', probability: 0.04 },
    ],
    windows: 3,
    processingSec: 0.24,
    modelRevision: 'v0.1.0',
    ...overrides,
  };
}

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    languages: jest.fn(() => ['en', 'pt', 'es']),
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
      unsupportedReason: '',
      nativeCoreVersion: '3.1.0',
      modelRevision: 'v0.1.0',
      modelRepo: 'desert-ant-labs/ear',
      defaultWindows: 3,
      reliableMargin: 0.25,
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      identifyFile: jest.fn(async () => detection()),
      identifySamples: jest.fn(async () => detection()),
      loadLanguages: jest.fn(async () => undefined),
      ...overrides,
    },
  };
}

function load(native: unknown) {
  let exports!: typeof import('../Ear');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    exports = require('../Ear');
  });
  return exports.Ear;
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (a web build, or one never prebuilt)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const Ear = load(null);
    expect(Ear.isSupported).toBe(false);
    expect(Ear.unsupportedReason).toMatch(/not available in this build/);
    expect(Ear.nativeCoreVersion).toBeNull();
    expect(Ear.modelRevision).toBeNull();
    expect(Ear.modelRepo).toBeNull();
  });

  it('still answers the questions a UI asks while rendering', () => {
    const Ear = load(null);
    // The fallbacks exist so a "listening to N windows" label and an explanation
    // of an unreliable answer can be laid out on a platform that will never run
    // the model.
    expect(Ear.defaultWindows).toBe(3);
    expect(Ear.reliableMargin).toBe(0.25);
    expect(Ear.confusableLanguages).toEqual(['no', 'sv', 'da']);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point', async () => {
    const Ear = load(null);
    expect(() => Ear.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'ear' })
    );
    await expect(Ear.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
  });
});

describe('on a device whose ABI has no LiteRT build', () => {
  it('prefers the native reason, which names the ABIs the device reported', () => {
    const Ear = load(
      fakeNative({
        isSupported: false,
        unsupportedReason: 'Ear ships arm64-v8a and x86_64 only; this device reports armeabi-v7a',
      }).module
    );
    expect(Ear.isSupported).toBe(false);
    expect(Ear.unsupportedReason).toMatch(/armeabi-v7a/);
  });
});

describe('reading the binary rather than duplicating it', () => {
  it('reports the window default and reliability margin the linked module uses', () => {
    const Ear = load(fakeNative({ defaultWindows: 5, reliableMargin: 0.4 }).module);
    expect(Ear.defaultWindows).toBe(5);
    expect(Ear.reliableMargin).toBe(0.4);
  });

  it('falls back when the module reports a value that cannot be right', () => {
    // A zero or a negative here would mean an identify that listens to nothing.
    const Ear = load(fakeNative({ defaultWindows: 0, reliableMargin: 0 }).module);
    expect(Ear.defaultWindows).toBe(3);
    expect(Ear.reliableMargin).toBe(0.25);
  });

  it('hands back a copy of the confusable list, so a caller cannot edit it', () => {
    const Ear = load(fakeNative().module);
    Ear.confusableLanguages.push('fi');
    expect(Ear.confusableLanguages).toEqual(['no', 'sv', 'da']);
  });
});

describe('identify', () => {
  it('converts a file:// URI to a path, since every native SDK takes a path', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    await ear.identify({ uri: 'file:///tmp/a%20recording.m4a' });
    expect(native.module.identifyFile).toHaveBeenCalledWith(
      native.model,
      '/tmp/a recording.m4a',
      { windows: 3 },
      expect.any(String)
    );
  });

  it('passes a plain path through untouched', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    await ear.identify({ uri: '/tmp/recording.wav' });
    expect(native.module.identifyFile).toHaveBeenCalledWith(
      native.model,
      '/tmp/recording.wav',
      { windows: 3 },
      expect.any(String)
    );
  });

  it('defaults the window count to what the module reports', async () => {
    const native = fakeNative({ defaultWindows: 6 });
    const Ear = load(native.module);
    const ear = await Ear.load();
    await ear.identify({ uri: '/tmp/a.wav' });
    expect(native.module.identifyFile).toHaveBeenCalledWith(
      native.model,
      '/tmp/a.wav',
      { windows: 6 },
      expect.any(String)
    );
  });

  it('returns the detection the native side decided, untouched', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    // Deliberately inconsistent with the margin: a high confidence and a wide
    // gap, still marked unreliable, which is what a Nordic answer looks like.
    // Nothing here second-guesses it.
    native.module.identifyFile.mockResolvedValueOnce(
      detection({
        language: 'sv',
        confidence: 0.88,
        isReliable: false,
        candidates: [
          { language: 'sv', probability: 0.88 },
          { language: 'no', probability: 0.05 },
        ],
      })
    );
    const heard = await ear.identify({ uri: '/tmp/a.wav' });
    expect(heard.language).toBe('sv');
    expect(heard.confidence).toBe(0.88);
    expect(heard.isReliable).toBe(false);
  });

  it('rejects a missing or empty uri before touching native', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    await expect(ear.identify({ uri: '' })).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
      model: 'ear',
    });
    await expect(
      ear.identify({} as unknown as { uri: string })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
    expect(native.module.identifyFile).not.toHaveBeenCalled();
  });

  it('rejects a window count that is not a whole number of at least one', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    for (const windows of [0, -1, 1.5, NaN]) {
      await expect(ear.identify({ uri: '/tmp/a.wav', windows })).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
      });
    }
    expect(native.module.identifyFile).not.toHaveBeenCalled();
  });

  it('forwards only the progress belonging to its own call', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    const seen: number[] = [];
    native.module.identifyFile.mockImplementationOnce(async () => {
      // Two ticks: one for this job, one for a concurrent one on the same model.
      native.listeners.forEach((l) => l({ jobId: 'ear-99', phase: 'loadingModel', fraction: 0.1 }));
      native.listeners.forEach((l) => l({ jobId: 'ear-2', phase: 'loadingModel', fraction: 0.5 }));
      return detection();
    });
    await ear.identify({ uri: '/tmp/a.wav', onProgress: (e) => seen.push(e.fraction) });
    expect(seen).toEqual([0.5]);
  });
});

describe('identifySamples', () => {
  it('accepts a plain array and sends a Float32Array', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    await ear.identifySamples([0.1, 0.2, 0.3], 44_100);
    const [, samples, rate] = native.module.identifySamples.mock.calls[0]!;
    expect(samples).toBeInstanceOf(Float32Array);
    expect(Array.from(samples as Float32Array)).toHaveLength(3);
    expect(rate).toBe(44_100);
  });

  it('defaults the rate to the model’s own 16 kHz', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    await ear.identifySamples(new Float32Array(8));
    expect(native.module.identifySamples.mock.calls[0]![2]).toBe(16_000);
  });

  it('rejects empty audio and a nonsense rate before touching native', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    await expect(ear.identifySamples(new Float32Array(0))).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    await expect(ear.identifySamples([0.1], 0)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.identifySamples).not.toHaveBeenCalled();
  });
});

describe('supportedLanguages', () => {
  // The split is a workaround for a real crash, so it is worth pinning: the
  // async half must return nothing and the array must come back off the
  // synchronous member. A refactor that "simplifies" this back into one async
  // call reintroduces a segfault -- see ios/EarModel.swift.
  it('loads asynchronously, then reads the array synchronously', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    await expect(ear.supportedLanguages()).resolves.toEqual(['en', 'pt', 'es']);
    expect(native.module.loadLanguages).toHaveBeenCalledWith(native.model, expect.any(String));
    expect(native.model.languages).toHaveBeenCalled();
  });

  it('surfaces the Android refusal as a coded error rather than an empty list', async () => {
    const native = fakeNative({
      loadLanguages: jest.fn(async () => {
        throw Object.assign(new Error('iOS-only'), { code: 'ERR_UNSUPPORTED_PLATFORM' });
      }),
    });
    const Ear = load(native.module);
    const ear = await Ear.load();
    await expect(ear.supportedLanguages()).rejects.toMatchObject({
      code: 'ERR_UNSUPPORTED_PLATFORM',
      model: 'ear',
    });
    // The synchronous read is never reached when the load refused.
    expect(native.model.languages).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('releases the native model once, however many times it is asked', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    ear.release();
    ear.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('throws ERR_RELEASED from every entry point afterwards', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = await Ear.load();
    ear.release();
    expect(() => ear.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(ear.identify({ uri: '/tmp/a.wav' })).rejects.toMatchObject({
      code: 'ERR_RELEASED',
    });
    await expect(ear.identifySamples([0.1])).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(ear.supportedLanguages()).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(ear.warm()).rejects.toMatchObject({ code: 'ERR_RELEASED' });
  });

  it('releases the model when warming it fails, rather than leaking a handle', async () => {
    const native = fakeNative({
      load: jest.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ERR_MODEL_UNAVAILABLE' });
      }),
    });
    const Ear = load(native.module);
    await expect(Ear.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('warm and download are the same call, because upstream fuses them', async () => {
    const native = fakeNative();
    const Ear = load(native.module);
    const ear = Ear.create();
    await ear.warm();
    await ear.download();
    expect(native.module.load).toHaveBeenCalledTimes(2);
  });

  it('wraps an uncoded native failure as ERR_INFERENCE_FAILED with the cause kept', async () => {
    const boom = new Error('something in Core ML');
    const native = fakeNative({
      identifyFile: jest.fn(async () => {
        throw boom;
      }),
    });
    const Ear = load(native.module);
    const ear = await Ear.load();
    await expect(ear.identify({ uri: '/tmp/a.wav' })).rejects.toMatchObject({
      code: 'ERR_INFERENCE_FAILED',
      model: 'ear',
      cause: boom,
    });
  });
});
