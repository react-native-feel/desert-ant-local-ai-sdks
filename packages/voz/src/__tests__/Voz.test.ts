/**
 * The parts of the surface that are ours rather than Core ML's: what happens off
 * iOS, what happens after `release`, which arguments are rejected before a native
 * call is made at all, and that a progress listener only sees its own job.
 *
 * The transcription itself is not testable here -- it needs a Neural Engine -- so
 * the native module is a spy and the example app is what proves the other half.
 */

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

function fakeNative() {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    // The async half resolves to nothing; the transcript is collected
    // synchronously. See `native.ts`.
    takeTranscript: jest.fn(() => transcript()),
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
      modelRevision: 'v0.1.0',
      supportedLanguages: ['de', 'en', 'es'],
      createModel: jest.fn(() => model),
      download: jest.fn(async () => undefined),
      load: jest.fn(async () => undefined),
      transcribeFile: jest.fn(async () => undefined),
      transcribeSamples: jest.fn(async () => undefined),
    },
  };
}

function transcript() {
  return {
    text: 'hello there',
    words: [
      { text: 'hello', start: 0, end: 0.4 },
      { text: 'there', start: 0.48, end: 0.8 },
    ],
    durationSec: 1,
    processingSec: 0.1,
    realtimeFactor: 10,
    modelRevision: 'v0.1.0',
    modelRuntime: 'coreml',
  };
}

/** Load `Voz` against a given native module, as `requireOptionalNativeModule` would. */
function load(native: unknown) {
  let exports!: typeof import('../Voz');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    exports = require('../Voz');
  });
  return exports.Voz;
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (Android, or a build that did not link it)', () => {
  it('reports that it is unsupported instead of throwing on import', () => {
    const Voz = load(null);
    expect(Voz.isSupported).toBe(false);
    expect(Voz.nativeCoreVersion).toBeNull();
    expect(Voz.modelRevision).toBeNull();
    expect(Voz.supportedLanguages).toEqual([]);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM when actually used', () => {
    const Voz = load(null);
    expect(() => Voz.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'voz' })
    );
  });

  it('rejects rather than throws synchronously from `load`', async () => {
    const Voz = load(null);
    await expect(Voz.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
  });
});

describe('static metadata', () => {
  it('passes the native values through', () => {
    const native = fakeNative();
    const Voz = load(native.module);
    expect(Voz.isSupported).toBe(true);
    expect(Voz.nativeCoreVersion).toBe('3.1.0');
    expect(Voz.modelRevision).toBe('v0.1.0');
    expect(Voz.supportedLanguages).toContain('en');
  });
});

describe('load', () => {
  it('warms the model and hands back an instance', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    const voz = await Voz.load();
    expect(native.module.load).toHaveBeenCalledTimes(1);
    expect(voz.isDownloaded()).toBe(true);
  });

  it('releases the half-built model when warming fails', async () => {
    const native = fakeNative();
    native.module.load.mockRejectedValueOnce(
      Object.assign(new Error('no space'), { code: 'ERR_MODEL_UNAVAILABLE' })
    );
    const Voz = load(native.module);
    await expect(Voz.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });
});

describe('transcribe', () => {
  it('converts a file:// URI to the path the native side takes', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    const voz = Voz.create();
    await voz.transcribe({ uri: 'file:///var/mobile/My%20Recording.m4a' });
    expect(native.module.transcribeFile).toHaveBeenCalledWith(
      native.model,
      '/var/mobile/My Recording.m4a',
      expect.any(String)
    );
  });

  it('returns the transcript untouched', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    const result = await Voz.create().transcribe({ uri: '/tmp/a.wav' });
    expect(result.text).toBe('hello there');
    expect(result.words).toHaveLength(2);
    expect(result.words[0]).toEqual({ text: 'hello', start: 0, end: 0.4 });
  });

  it('wraps a native failure as a DesertAntError with its code', async () => {
    const native = fakeNative();
    native.module.transcribeFile.mockRejectedValueOnce(
      Object.assign(new Error('no file at /tmp/gone.wav'), { code: 'ERR_AUDIO_DECODE_FAILED' })
    );
    const Voz = load(native.module);
    await expect(Voz.create().transcribe({ uri: '/tmp/gone.wav' })).rejects.toMatchObject({
      name: 'DesertAntError',
      code: 'ERR_AUDIO_DECODE_FAILED',
      model: 'voz',
    });
  });

  it('gives an uncoded native failure a code rather than losing it', async () => {
    const native = fakeNative();
    native.module.transcribeFile.mockRejectedValueOnce(new Error('something went wrong'));
    const Voz = load(native.module);
    await expect(Voz.create().transcribe({ uri: '/tmp/a.wav' })).rejects.toMatchObject({
      code: 'ERR_INFERENCE_FAILED',
      message: 'something went wrong',
    });
  });
});

describe('transcribeSamples', () => {
  it('defaults to the rate the model runs at', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    await Voz.create().transcribeSamples(new Float32Array(16));
    expect(native.module.transcribeSamples).toHaveBeenCalledWith(
      native.model,
      expect.any(Float32Array),
      16_000,
      expect.any(String)
    );
  });

  it('accepts a plain number array and converts it once, here', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    await Voz.create().transcribeSamples([0.1, 0.2, 0.3], 8_000);
    const [, samples] = native.module.transcribeSamples.mock.calls[0]!;
    expect(samples).toBeInstanceOf(Float32Array);
    expect((samples as Float32Array).length).toBe(3);
  });

  it('rejects empty audio without troubling the native side', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    await expect(Voz.create().transcribeSamples(new Float32Array(0))).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.transcribeSamples).not.toHaveBeenCalled();
  });

  it('rejects a nonsense sample rate', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    await expect(Voz.create().transcribeSamples(new Float32Array(4), 0)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.transcribeSamples).not.toHaveBeenCalled();
  });
});

describe('progress', () => {
  it('delivers only the events belonging to its own call', async () => {
    const native = fakeNative();
    const seen: number[] = [];
    native.module.transcribeFile.mockImplementationOnce(async (_m: unknown, _p: unknown, jobId: string) => {
      // One tick for this job and one for an imaginary concurrent one.
      native.listeners.forEach((l) => l({ jobId, phase: 'transcribing', fraction: 0.5 }));
      native.listeners.forEach((l) => l({ jobId: 'voz-other', phase: 'transcribing', fraction: 0.9 }));
      return transcript();
    });
    const Voz = load(native.module);
    await Voz.create().transcribe({
      uri: '/tmp/a.wav',
      onProgress: (event) => seen.push(event.fraction),
    });
    expect(seen).toEqual([0.5]);
  });

  it('unsubscribes when the call finishes', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    await Voz.create().transcribe({ uri: '/tmp/a.wav', onProgress: () => {} });
    expect(native.listeners).toHaveLength(0);
  });

  it('subscribes to nothing when no listener was given', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    await Voz.create().transcribe({ uri: '/tmp/a.wav' });
    expect(native.model.addListener).not.toHaveBeenCalled();
  });
});

describe('release', () => {
  it('releases the native object once, however often it is called', () => {
    const native = fakeNative();
    const Voz = load(native.module);
    const voz = Voz.create();
    voz.release();
    voz.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('reports ERR_RELEASED rather than crashing in native code', async () => {
    const native = fakeNative();
    const Voz = load(native.module);
    const voz = Voz.create();
    voz.release();
    expect(() => voz.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(voz.transcribe({ uri: '/tmp/a.wav' })).rejects.toMatchObject({
      code: 'ERR_RELEASED',
    });
    expect(native.module.transcribeFile).not.toHaveBeenCalled();
  });
});
