/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, which arguments are rejected before a native
 * call is made at all, what empty input costs, and how the skin tones and the
 * default limit are read off the binary rather than duplicated here.
 *
 * Suggestion itself is not testable here -- it needs the weights and an inference
 * session -- so the native module is a spy and the example app proves the rest.
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
      unsupportedReason: '',
      nativeCoreVersion: '3.1.0',
      modelRevision: 'v0.7.0',
      modelRepo: 'desert-ant-labs/emo',
      skinTones: ['default', 'light', 'mediumLight', 'medium', 'mediumDark', 'dark'],
      defaultLimit: 3,
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      suggest: jest.fn(async () => suggestions()),
      ...overrides,
    },
  };
}

function suggestions() {
  return [
    { emoji: '💰', confidence: 0.62 },
    { emoji: '💳', confidence: 0.14 },
    { emoji: '🧾', confidence: 0.09 },
  ];
}

function load(native: unknown) {
  let exports!: typeof import('../Emo');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    exports = require('../Emo');
  });
  return exports.Emo;
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (a web build, or one never prebuilt)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const Emo = load(null);
    expect(Emo.isSupported).toBe(false);
    expect(Emo.unsupportedReason).toMatch(/not available in this build/);
    expect(Emo.nativeCoreVersion).toBeNull();
    expect(Emo.modelRevision).toBeNull();
    expect(Emo.modelRepo).toBeNull();
  });

  it('still answers the questions a UI asks while rendering', () => {
    const Emo = load(null);
    // The fallbacks exist so a tone picker and a suggestion row can be laid out
    // on a platform that will never run the model.
    expect(Emo.skinTones).toEqual([
      'default',
      'light',
      'mediumLight',
      'medium',
      'mediumDark',
      'dark',
    ]);
    expect(Emo.defaultLimit).toBe(3);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point', async () => {
    const Emo = load(null);
    expect(() => Emo.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'emo' })
    );
    await expect(Emo.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
  });
});

describe('on a device whose ABI has no LiteRT build', () => {
  it('prefers the native reason, which names the ABIs the device reported', () => {
    const Emo = load(
      fakeNative({
        isSupported: false,
        unsupportedReason: 'Emo ships arm64-v8a and x86_64 only; this device reports armeabi-v7a',
      }).module
    );
    expect(Emo.isSupported).toBe(false);
    expect(Emo.unsupportedReason).toMatch(/armeabi-v7a/);
  });
});

describe('reading the binary rather than duplicating it', () => {
  it('reports the tones and default limit the linked module accepts', () => {
    const native = fakeNative({ skinTones: ['default', 'medium'], defaultLimit: 5 });
    const Emo = load(native.module);
    expect(Emo.skinTones).toEqual(['default', 'medium']);
    expect(Emo.defaultLimit).toBe(5);
  });

  it('falls back when the module reports an empty or nonsensical set', () => {
    const Emo = load(fakeNative({ skinTones: [], defaultLimit: 0 }).module);
    expect(Emo.skinTones).toHaveLength(6);
    expect(Emo.defaultLimit).toBe(3);
  });
});

describe('load and create', () => {
  it('create does not touch the network; load warms first', async () => {
    const native = fakeNative();
    const Emo = load(native.module);

    Emo.create();
    expect(native.module.createModel).toHaveBeenCalledWith({ directory: undefined });
    expect(native.module.load).not.toHaveBeenCalled();

    await Emo.load({ directory: '/models/emo' });
    expect(native.module.createModel).toHaveBeenLastCalledWith({ directory: '/models/emo' });
    expect(native.module.load).toHaveBeenCalledTimes(1);
  });

  it('releases the model when warming fails, rather than leaking it', async () => {
    const native = fakeNative({
      load: jest.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ERR_MODEL_UNAVAILABLE' });
      }),
    });
    const Emo = load(native.module);
    await expect(Emo.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('forwards load progress only for its own job', async () => {
    const native = fakeNative({
      load: jest.fn(async (_model: unknown, jobId: string) => {
        native.listeners.forEach((listener) => {
          listener({ jobId: 'emo-somebody-else', phase: 'loadingModel', fraction: 0.5 });
          listener({ jobId, phase: 'loadingModel', fraction: 1 });
        });
      }),
    });
    const Emo = load(native.module);
    const seen: number[] = [];
    await Emo.load({ onProgress: (event) => seen.push(event.fraction) });
    expect(seen).toEqual([1]);
    // Unsubscribed once the call it was scoped to finished.
    expect(native.listeners).toHaveLength(0);
  });
});

describe('suggest', () => {
  it('passes the text through and defaults the options', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    await expect(emo.suggest('Pay my bills')).resolves.toEqual(suggestions());
    expect(native.module.suggest).toHaveBeenCalledWith(
      native.model,
      'Pay my bills',
      { limit: 3, skinTone: 'default' },
      expect.stringMatching(/^emo-\d+$/)
    );
  });

  it('forwards a limit and a skin tone', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    await emo.suggest('go for a run', { limit: 1, skinTone: 'medium' });
    expect(native.module.suggest).toHaveBeenCalledWith(
      native.model,
      'go for a run',
      { limit: 1, skinTone: 'medium' },
      expect.any(String)
    );
  });

  it('answers empty and whitespace-only input without a native call', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    await expect(emo.suggest('')).resolves.toEqual([]);
    await expect(emo.suggest('   \n\t ')).resolves.toEqual([]);
    expect(native.module.suggest).not.toHaveBeenCalled();
  });

  it('rejects a limit that is not a whole number of at least 1', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    for (const limit of [0, -1, 2.5, Number.NaN]) {
      await expect(emo.suggest('hi', { limit })).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
        model: 'emo',
      });
    }
    expect(native.module.suggest).not.toHaveBeenCalled();
  });

  it('rejects a skin tone the linked module does not accept', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    await expect(
      emo.suggest('hi', { skinTone: 'neon' as unknown as 'medium' })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
    expect(native.module.suggest).not.toHaveBeenCalled();
  });

  it('rejects a non-string, rather than letting the bridge coerce it', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    await expect(emo.suggest(42 as unknown as string)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
  });

  it('wraps a native failure as a coded DesertAntError', async () => {
    const native = fakeNative({
      suggest: jest.fn(async () => {
        throw Object.assign(new Error('session gone'), { code: 'ERR_INFERENCE_FAILED' });
      }),
    });
    const Emo = load(native.module);
    const emo = await Emo.load();

    await expect(emo.suggest('hello')).rejects.toMatchObject({
      code: 'ERR_INFERENCE_FAILED',
      model: 'emo',
    });
  });
});

describe('best', () => {
  it('asks for one and unwraps it', async () => {
    const native = fakeNative({ suggest: jest.fn(async () => [suggestions()[0]]) });
    const Emo = load(native.module);
    const emo = await Emo.load();

    await expect(emo.best('Pay my bills')).resolves.toEqual({ emoji: '💰', confidence: 0.62 });
    expect(native.module.suggest).toHaveBeenCalledWith(
      native.model,
      'Pay my bills',
      { limit: 1, skinTone: 'default' },
      expect.any(String)
    );
  });

  it('is null for empty input rather than throwing, so a caller needs no guard', async () => {
    const Emo = load(fakeNative().module);
    const emo = await Emo.load();
    await expect(emo.best('  ')).resolves.toBeNull();
  });

  it('keeps the skin tone while overriding the limit', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    await emo.best('go for a run', { skinTone: 'dark' });
    expect(native.module.suggest).toHaveBeenCalledWith(
      native.model,
      'go for a run',
      { limit: 1, skinTone: 'dark' },
      expect.any(String)
    );
  });
});

describe('release', () => {
  it('is idempotent, and everything after it is ERR_RELEASED', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = await Emo.load();

    emo.release();
    emo.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);

    expect(() => emo.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(emo.suggest('hi')).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(emo.best('hi')).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(emo.warm()).rejects.toMatchObject({ code: 'ERR_RELEASED' });
  });
});

describe('warm and download', () => {
  it('are the same call, because upstream fuses download and session build', async () => {
    const native = fakeNative();
    const Emo = load(native.module);
    const emo = Emo.create();

    await emo.warm();
    await emo.download();
    expect(native.module.load).toHaveBeenCalledTimes(2);
  });
});
