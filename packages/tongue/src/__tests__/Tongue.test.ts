/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, which arguments are rejected before a native
 * call is made at all, that the two spellings of `detect` reach the same
 * synchronous native call, and that the numbers a UI shows are read off the
 * binary rather than duplicated here.
 *
 * Detection itself is not testable here -- it needs the bundled weights -- so the
 * native module is a spy and the example app proves the rest.
 *
 * Two rules this file deliberately does NOT test are `reliability` and
 * `isTooCloseToCall`. Both are decided natively on both platforms, and a test
 * here that recomputed either from a margin would be asserting a second
 * implementation into existence -- exactly the drift the native decision exists
 * to prevent.
 */

function detection(overrides: Record<string, unknown> = {}) {
  return {
    language: 'de',
    confidence: 0.87,
    reliability: 'likely',
    isTooCloseToCall: false,
    candidates: [
      { language: 'de', probability: 0.87 },
      { language: 'nl', probability: 0.06 },
    ],
    normalized: 'kann ich das haben',
    route: { verdict: 'ambiguous', candidates: [], script: 'Latin' },
    processingSec: 0.000_041,
    modelRevision: 'v1.0.0',
    ...overrides,
  };
}

function fakeNative(overrides: Record<string, unknown> = {}) {
  const model = {
    isLoaded: jest.fn(() => true),
    release: jest.fn(),
  };
  return {
    model,
    module: {
      isSupported: true,
      unsupportedReason: '',
      nativeCoreVersion: '3.1.0',
      modelRevision: 'v1.0.0',
      modelRepo: 'desert-ant-labs/tongue',
      defaultTopK: 3,
      tieMargin: 0.12,
      maxCharacters: 512,
      scripts: ['Latin', 'Cyrillic', 'Han'],
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      detect: jest.fn(() => detection()),
      ...overrides,
    },
  };
}

function load(native: unknown) {
  let exports!: typeof import('../Tongue');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    exports = require('../Tongue');
  });
  return exports.Tongue;
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (a web build, or one never prebuilt)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const Tongue = load(null);
    expect(Tongue.isSupported).toBe(false);
    expect(Tongue.unsupportedReason).toMatch(/not available in this build/);
    expect(Tongue.nativeCoreVersion).toBeNull();
    expect(Tongue.modelRevision).toBeNull();
    expect(Tongue.modelRepo).toBeNull();
  });

  it('still answers the questions a UI asks while rendering', () => {
    const Tongue = load(null);
    // The fallbacks exist so a character counter and an explanation of a tie can
    // be laid out on a platform that will never run the model.
    expect(Tongue.defaultTopK).toBe(3);
    expect(Tongue.tieMargin).toBe(0.12);
    expect(Tongue.maxCharacters).toBe(512);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point', async () => {
    const Tongue = load(null);
    expect(() => Tongue.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'tongue' })
    );
    await expect(Tongue.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
    expect(() => Tongue.supportedScripts()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM' })
    );
  });
});

describe('where the module is present but the model is not linked', () => {
  // The state the Apple half is in today: desert-ant-core v3.1.0 declares a
  // `Tongue` SwiftPM product and never exports it, so the module registers,
  // answers every property, and refuses to make a model. The reason has to reach
  // JavaScript intact -- a caller who sees "not available in this build" would go
  // looking for a prebuild problem that is not there.
  it('prefers the native reason over this package’s generic one', () => {
    const Tongue = load(
      fakeNative({
        isSupported: false,
        unsupportedReason:
          'desert-ant-core v3.1.0 declares a `Tongue` SwiftPM product and never adds it to ' +
          "the package's `products:` array",
      }).module
    );
    expect(Tongue.isSupported).toBe(false);
    expect(Tongue.unsupportedReason).toMatch(/never adds it to the package/);
    // The constants still read, because they are the module's rather than the
    // model's -- a UI that explains the refusal can still lay itself out.
    expect(Tongue.maxCharacters).toBe(512);
  });
});

describe('reading the binary rather than duplicating it', () => {
  it('reports the candidate default and the caps the linked module uses', () => {
    const Tongue = load(fakeNative({ defaultTopK: 5, maxCharacters: 1024, tieMargin: 0.2 }).module);
    expect(Tongue.defaultTopK).toBe(5);
    expect(Tongue.maxCharacters).toBe(1024);
    expect(Tongue.tieMargin).toBe(0.2);
  });

  it('falls back when the module reports a value that cannot be right', () => {
    // A zero here would mean a detect that ranks nothing, or a normalizer that
    // keeps no characters.
    const Tongue = load(fakeNative({ defaultTopK: 0, maxCharacters: 0, tieMargin: 0 }).module);
    expect(Tongue.defaultTopK).toBe(3);
    expect(Tongue.maxCharacters).toBe(512);
    expect(Tongue.tieMargin).toBe(0.12);
  });

  it('hands back a copy of the script list, so a caller cannot edit it', () => {
    const Tongue = load(fakeNative().module);
    Tongue.supportedScripts().push('Klingon');
    expect(Tongue.supportedScripts()).toEqual(['Latin', 'Cyrillic', 'Han']);
  });

  it('turns an empty script list into a coded refusal rather than an empty answer', () => {
    // What the Android half reports: `Router` and `ScriptTables` are internal in
    // `ai.desertant:tongue`, so there is no list to give. Returning `[]` would
    // read as "this model knows no scripts", which is false.
    const Tongue = load(fakeNative({ scripts: [] }).module);
    expect(() => Tongue.supportedScripts()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'tongue' })
    );
  });
});

describe('detect', () => {
  it('sends the text through untouched and defaults topK to what the module reports', async () => {
    const native = fakeNative({ defaultTopK: 4 });
    const Tongue = load(native.module);
    const tongue = await Tongue.load();
    await tongue.detect('kann ich das haben');
    expect(native.module.detect).toHaveBeenCalledWith(native.model, 'kann ich das haben', {
      topK: 4,
    });
  });

  it('returns the detection the native side decided, untouched', async () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = await Tongue.load();
    // Deliberately inconsistent with a naive reading: a wide margin, still
    // `tentative`, which is what three characters look like however sure the
    // softmax is. Nothing here second-guesses it.
    native.module.detect.mockReturnValueOnce(
      detection({
        language: 'cy',
        confidence: 0.71,
        reliability: 'tentative',
        normalized: 'hi i am',
        candidates: [
          { language: 'cy', probability: 0.71 },
          { language: 'en', probability: 0.09 },
        ],
      })
    );
    const read = await tongue.detect('hi i am');
    expect(read.language).toBe('cy');
    expect(read.reliability).toBe('tentative');
    expect(read.normalized).toBe('hi i am');
  });

  it('loads the model first when it is cold, and not again when it is warm', async () => {
    const native = fakeNative();
    native.model.isLoaded.mockReturnValueOnce(false);
    const Tongue = load(native.module);
    const tongue = Tongue.create();
    await tongue.detect('hola');
    await tongue.detect('hola');
    expect(native.module.load).toHaveBeenCalledTimes(1);
  });

  it('accepts empty text, because upstream answers it rather than failing', async () => {
    // A field that clears while someone is typing should get `reliability:
    // 'empty'`, not an exception.
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = await Tongue.load();
    await tongue.detect('');
    expect(native.module.detect).toHaveBeenCalledWith(native.model, '', { topK: 3 });
  });

  it('rejects text that is not a string before touching native', async () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = await Tongue.load();
    for (const bad of [null, undefined, 42, {}]) {
      await expect(tongue.detect(bad as unknown as string)).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
        model: 'tongue',
      });
    }
    expect(native.module.detect).not.toHaveBeenCalled();
  });

  it('rejects a candidate count that is not a whole number of at least one', async () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = await Tongue.load();
    for (const topK of [0, -1, 1.5, NaN]) {
      await expect(tongue.detect('hola', { topK })).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
      });
    }
    expect(native.module.detect).not.toHaveBeenCalled();
  });
});

describe('detectSync', () => {
  // The reason it exists: upstream measures a detection in tens of microseconds
  // and documents it as a main-thread call, so the promise is the expensive part.
  // It is also the shape that cannot hit Expo Modules 2.0 limit 4 -- a
  // synchronous return is encoded on the JavaScript thread by construction.
  it('is the same native call as detect, without the microtask', () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = Tongue.create();
    const read = tongue.detectSync('kann ich das haben', { topK: 2 });
    expect(read.language).toBe('de');
    expect(native.module.detect).toHaveBeenCalledWith(native.model, 'kann ich das haben', {
      topK: 2,
    });
  });

  it('never loads the model itself, so 2 MB is never read on the JS thread', () => {
    const native = fakeNative();
    native.model.isLoaded.mockReturnValue(false);
    native.module.detect.mockImplementation(() => {
      throw Object.assign(new Error('not loaded'), { code: 'ERR_MODEL_UNAVAILABLE' });
    });
    const Tongue = load(native.module);
    const tongue = Tongue.create();
    expect(() => tongue.detectSync('hola')).toThrow(
      expect.objectContaining({ code: 'ERR_MODEL_UNAVAILABLE', model: 'tongue' })
    );
    expect(native.module.load).not.toHaveBeenCalled();
  });

  it('applies the same argument guards as the asynchronous spelling', () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = Tongue.create();
    expect(() => tongue.detectSync('hola', { topK: 0 })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(() => tongue.detectSync(7 as unknown as string)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(native.module.detect).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('has no directory option and no isDownloaded, because nothing downloads', async () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    await Tongue.load();
    // The shape of `createModel` is the assertion: every other model in this repo
    // passes `{ directory }`, and there is nowhere for one to point here.
    expect(native.module.createModel).toHaveBeenCalledWith();
    expect('isDownloaded' in Tongue.prototype).toBe(false);
  });

  it('warm is idempotent from the caller’s side and takes no progress handler', async () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = Tongue.create();
    await tongue.warm();
    await tongue.warm();
    expect(native.module.load).toHaveBeenCalledTimes(2);
    expect(native.module.load).toHaveBeenCalledWith(native.model);
  });

  it('releases the native model once, however many times it is asked', async () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = await Tongue.load();
    tongue.release();
    tongue.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('throws ERR_RELEASED from every entry point afterwards', async () => {
    const native = fakeNative();
    const Tongue = load(native.module);
    const tongue = await Tongue.load();
    tongue.release();
    expect(() => tongue.isLoaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    expect(() => tongue.detectSync('hola')).toThrow(
      expect.objectContaining({ code: 'ERR_RELEASED' })
    );
    await expect(tongue.detect('hola')).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(tongue.warm()).rejects.toMatchObject({ code: 'ERR_RELEASED' });
  });

  it('releases the model when warming it fails, rather than leaking a handle', async () => {
    const native = fakeNative({
      load: jest.fn(async () => {
        throw Object.assign(new Error('resources missing from the bundle'), {
          code: 'ERR_MODEL_UNAVAILABLE',
        });
      }),
    });
    const Tongue = load(native.module);
    await expect(Tongue.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('wraps an uncoded native failure as ERR_INFERENCE_FAILED with the cause kept', () => {
    const boom = new Error('something in the head');
    const native = fakeNative({
      detect: jest.fn(() => {
        throw boom;
      }),
    });
    const Tongue = load(native.module);
    const tongue = Tongue.create();
    expect(() => tongue.detectSync('hola')).toThrow(
      expect.objectContaining({ code: 'ERR_INFERENCE_FAILED', model: 'tongue', cause: boom })
    );
  });
});
