/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, which arguments are rejected before a native
 * call is made at all, that the two-step "do the work, then hand the result over"
 * shape is preserved, and that `timestampShift` measures what it claims to.
 *
 * Refinement itself is not testable here -- it needs the weights, a Core ML
 * session and Apple's recognizer -- so the native module is a spy and the example
 * app proves the rest.
 *
 * One rule this file deliberately does NOT test: it does not assert how far Align
 * moves any particular boundary. Those numbers are the model's, they are measured
 * on a device, and an answer key here would be a fixture of this package's memory
 * rather than of the model's behaviour.
 *
 * `timestampShift` is the exception, and it is the exception on purpose: it is
 * the one piece of arithmetic this package performs rather than forwards, so it
 * is the one piece that needs pinning. The expected values below are computed
 * from the inputs by hand, not read off this implementation.
 */

import { timestampShift } from '../shift';
import type { AlignedWord } from '../types';

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

/** A transcript record the way native builds one. */
function wire(overrides: Record<string, unknown> = {}) {
  return {
    text: 'hello world',
    words: [
      {
        text: 'hello',
        start: 0.11,
        end: 0.48,
        originalStart: 0.1,
        originalEnd: 0.5,
        refined: true,
      },
      {
        text: 'world',
        start: 0.6,
        end: 0.9,
        originalStart: 0.6,
        originalEnd: 0.9,
        refined: false,
      },
    ],
    locale: 'en_US',
    languageRefined: true,
    refinedWordCount: 1,
    durationSec: 1.2,
    processingSec: 0.4,
    refineSec: 0.03,
    setupSec: 0.08,
    realtimeFactor: 3,
    modelRevision: 'main',
    modelRuntime: 'coreml',
    ...overrides,
  };
}

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    supportedLanguages: jest.fn(() => ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'zh']),
    resolvedDirectory: jest.fn(() => '/models/align'),
    takeTranscript: jest.fn(() => wire()),
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
      modelRevision: 'main',
      modelRepo: 'desert-ant-labs/align',
      revisionIsPinned: false,
      appleSpeechAvailable: true,
      defaultMaxBufferedSeconds: 30,
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      prepareLocale: jest.fn(async () => undefined),
      transcribe: jest.fn(async () => undefined),
      ...overrides,
    },
  };
}

function load(native: unknown) {
  let mod!: typeof import('../Align');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    mod = require('../Align');
  });
  return { Align: mod.Align };
}

async function loaded(native = fakeNative()) {
  const { Align } = load(native.module);
  return { Align, align: await Align.load(), native };
}

describe('Align without a native module', () => {
  const { Align } = load(null);

  it('reports unsupported rather than throwing at import', () => {
    expect(Align.isSupported).toBe(false);
    expect(Align.isAppleSpeechAvailable).toBe(false);
    expect(Align.nativeCoreVersion).toBeNull();
    expect(Align.modelRevision).toBeNull();
    expect(Align.modelRepo).toBeNull();
  });

  it('explains why, naming upstream rather than this package', () => {
    expect(Align.unsupportedReason).toMatch(/Apple/);
  });

  it('falls back to upstream default for the context window', () => {
    expect(Align.defaultMaxBufferedSeconds).toBe(30);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point', async () => {
    expect(() => Align.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM' })
    );
    await expect(Align.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
  });
});

describe('Align static reporting', () => {
  it('reads the revision and its pinned-ness off the binary', () => {
    const { Align } = load(fakeNative().module);
    expect(Align.modelRevision).toBe('main');
    // The risk this package is written to surface: upstream pins a branch.
    expect(Align.revisionIsPinned).toBe(false);
  });

  it('reports a pinned revision as pinned once upstream tags the repo', () => {
    const { Align } = load(
      fakeNative({ modelRevision: 'v0.1.0', revisionIsPinned: true }).module
    );
    expect(Align.revisionIsPinned).toBe(true);
  });

  it('prefers the native unsupported reason, which knows the OS version', () => {
    const { Align } = load(
      fakeNative({
        isSupported: false,
        unsupportedReason: 'Align needs iOS 26 or newer.',
      }).module
    );
    expect(Align.unsupportedReason).toBe('Align needs iOS 26 or newer.');
  });
});

describe('load and lifecycle', () => {
  it('creates, warms, and reports what it resolved', async () => {
    const { align, native } = await loaded();
    expect(native.module.createModel).toHaveBeenCalledWith({ directory: undefined });
    expect(native.module.load).toHaveBeenCalledTimes(1);
    expect(align.isDownloaded()).toBe(true);
    expect(align.resolvedDirectory()).toBe('/models/align');
  });

  it('reads the language list off the model rather than a constant here', async () => {
    const { align, native } = await loaded();
    expect(align.supportedLanguages()).toEqual([
      'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'zh',
    ]);
    expect(native.model.supportedLanguages).toHaveBeenCalled();
  });

  it('releases the model when warming fails, so a failed load leaks nothing', async () => {
    const native = fakeNative({
      load: jest.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ERR_MODEL_UNAVAILABLE' });
      }),
    });
    const { Align } = load(native.module);
    await expect(Align.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('refuses every call after release', async () => {
    const { align } = await loaded();
    align.release();
    align.release(); // idempotent
    expect(() => align.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(align.transcribe({ uri: 'file:///a.m4a', locale: 'en-US' })).rejects.toMatchObject(
      { code: 'ERR_RELEASED' }
    );
  });

  it('download is the same call as warm', async () => {
    const { align, native } = await loaded();
    await align.download();
    expect(native.module.load).toHaveBeenCalledTimes(2);
  });
});

describe('transcribe', () => {
  it('converts a file:// URI to a path and hands the result over synchronously', async () => {
    const { align, native } = await loaded();
    const transcript = await align.transcribe({
      uri: 'file:///tmp/a%20clip.m4a',
      locale: 'en-US',
    });
    expect(native.module.transcribe).toHaveBeenCalledWith(
      native.model,
      '/tmp/a clip.m4a',
      { locale: 'en-US', allowUnrefined: false, maxBufferedSeconds: 30 },
      expect.stringMatching(/^align-/)
    );
    // The two-step shape limit 4 forces: the async call returns nothing, and the
    // record comes back off a synchronous member.
    expect(native.model.takeTranscript).toHaveBeenCalledWith(expect.stringMatching(/^align-/));
    expect(transcript.words).toHaveLength(2);
    expect(transcript.refinedWordCount).toBe(1);
  });

  it('takes the transcript under the same job id the work used', async () => {
    const { align, native } = await loaded();
    await align.transcribe({ uri: '/a.m4a', locale: 'en-US' });
    const usedJobId = native.module.transcribe.mock.calls[0][3];
    expect(native.model.takeTranscript).toHaveBeenCalledWith(usedJobId);
  });

  it('forwards allowUnrefined and the buffer window', async () => {
    const { align, native } = await loaded();
    await align.transcribe({
      uri: '/a.m4a',
      locale: 'cy-GB',
      allowUnrefined: true,
      maxBufferedSeconds: 10,
    });
    expect(native.module.transcribe.mock.calls[0][2]).toEqual({
      locale: 'cy-GB',
      allowUnrefined: true,
      maxBufferedSeconds: 10,
    });
  });

  it('scopes progress to its own job and unsubscribes afterwards', async () => {
    const native = fakeNative();
    const events: string[] = [];
    // The job id is whatever the counter is up to, so it is read back off the
    // call rather than guessed: that is the property under test.
    native.module.transcribe = jest.fn(async (_model, _path, _options, jobId: string) => {
      for (const listener of [...native.listeners]) {
        listener({ jobId, phase: 'transcribing', fraction: 0.5 });
        listener({ jobId: 'somebody-else', phase: 'transcribing', fraction: 0.9 });
      }
    });
    const { Align } = load(native.module);
    const align = await Align.load();
    await align.transcribe({
      uri: '/a.m4a',
      locale: 'en-US',
      onProgress: (event) => events.push(`${event.phase}:${event.fraction}`),
    });
    expect(events).toEqual(['transcribing:0.5']);
    expect(native.listeners).toHaveLength(0);
  });

  it('wraps a native failure as a DesertAntError with its code intact', async () => {
    const native = fakeNative({
      transcribe: jest.fn(async () => {
        throw Object.assign(new Error('no speech assets'), { code: 'ERR_MODEL_UNAVAILABLE' });
      }),
    });
    const { Align } = load(native.module);
    const align = await Align.load();
    await expect(align.transcribe({ uri: '/a.m4a', locale: 'en-US' })).rejects.toMatchObject({
      code: 'ERR_MODEL_UNAVAILABLE',
      model: 'align',
    });
  });
});

describe('arguments refused before any native call', () => {
  // Every one of these is something upstream accepts silently. A locale it has no
  // language id for turns `refine` into a passthrough that returns Apple's own
  // timestamps with no error at all, which is a typo voiding the entire benefit.
  const bad: [string, Record<string, unknown>][] = [
    ['no uri', { locale: 'en-US' }],
    ['empty uri', { uri: '', locale: 'en-US' }],
    ['no locale', { uri: '/a.m4a' }],
    ['empty locale', { uri: '/a.m4a', locale: '' }],
    ['a sentence for a locale', { uri: '/a.m4a', locale: 'english please' }],
    ['a language name', { uri: '/a.m4a', locale: 'english' }],
    ['a zero buffer window', { uri: '/a.m4a', locale: 'en-US', maxBufferedSeconds: 0 }],
    ['a negative buffer window', { uri: '/a.m4a', locale: 'en-US', maxBufferedSeconds: -5 }],
    ['a NaN buffer window', { uri: '/a.m4a', locale: 'en-US', maxBufferedSeconds: NaN }],
  ];

  it.each(bad)('refuses %s without touching native', async (_what, options) => {
    const native = fakeNative();
    const { Align } = load(native.module);
    const align = await Align.load();
    await expect(align.transcribe(options as never)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
      model: 'align',
    });
    expect(native.module.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'en'],
    ['a region subtag', 'en-US'],
    ['an underscore', 'es_ES'],
    ['a script subtag', 'zh-Hans-CN'],
    ['a three-letter code', 'fil-PH'],
  ])('accepts %s', async (_what, locale) => {
    const native = fakeNative();
    const { Align } = load(native.module);
    const align = await Align.load();
    await expect(align.transcribe({ uri: '/a.m4a', locale })).resolves.toBeDefined();
  });

  it('refuses a bad locale on prepareLocale too', async () => {
    const { align, native } = await loaded();
    await expect(align.prepareLocale('')).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.prepareLocale).not.toHaveBeenCalled();
  });

  it('prepares a locale when it is well-formed', async () => {
    const { align, native } = await loaded();
    await align.prepareLocale('ja-JP');
    expect(native.module.prepareLocale).toHaveBeenCalledWith(
      native.model,
      'ja-JP',
      expect.stringMatching(/^align-/)
    );
  });
});

describe('timestampShift', () => {
  function word(overrides: Partial<AlignedWord> = {}): AlignedWord {
    return {
      text: 'w',
      start: 1,
      end: 2,
      originalStart: 1,
      originalEnd: 2,
      refined: false,
      ...overrides,
    };
  }

  it('measures nothing over an empty list', () => {
    expect(timestampShift([])).toEqual({
      wordCount: 0,
      refinedCount: 0,
      meanAbsSec: 0,
      maxAbsSec: 0,
      meanStartSec: 0,
      meanEndSec: 0,
    });
  });

  it('measures nothing over words the refiner declined to move', () => {
    const shift = timestampShift([word(), word(), word()]);
    expect(shift.wordCount).toBe(3);
    expect(shift.refinedCount).toBe(0);
    expect(shift.meanAbsSec).toBe(0);
    expect(shift.maxAbsSec).toBe(0);
  });

  it('averages over boundaries, not words', () => {
    // One word, start pulled 40 ms earlier and end pushed 20 ms later. Two
    // boundaries moved 0.04 and 0.02, so the mean boundary movement is 0.03 --
    // not 0.06, which is what averaging over words would give.
    const shift = timestampShift([
      word({ start: 0.96, end: 2.02, originalStart: 1, originalEnd: 2, refined: true }),
    ]);
    expect(shift.wordCount).toBe(1);
    expect(shift.refinedCount).toBe(1);
    expect(shift.meanAbsSec).toBeCloseTo(0.03, 10);
    expect(shift.maxAbsSec).toBeCloseTo(0.04, 10);
    expect(shift.meanStartSec).toBeCloseTo(-0.04, 10);
    expect(shift.meanEndSec).toBeCloseTo(0.02, 10);
  });

  it('keeps the signed means signed, so a systematic bias is visible', () => {
    // Both words pulled earlier at both ends: the signed means are negative while
    // the absolute mean is positive. That difference is the whole reason both are
    // reported.
    const shift = timestampShift([
      word({ start: 0.9, end: 1.9, originalStart: 1, originalEnd: 2, refined: true }),
      word({ start: 2.8, end: 3.8, originalStart: 3, originalEnd: 4, refined: true }),
    ]);
    expect(shift.meanStartSec).toBeCloseTo(-0.15, 10);
    expect(shift.meanEndSec).toBeCloseTo(-0.15, 10);
    expect(shift.meanAbsSec).toBeCloseTo(0.15, 10);
  });

  it('divides by every word, so unrefined words pull the mean down', () => {
    // Three words, one moved 0.1 at each boundary. Six boundaries, 0.2 of total
    // movement: 0.0333..., not 0.1.
    const shift = timestampShift([
      word({ start: 0.9, end: 2.1, originalStart: 1, originalEnd: 2, refined: true }),
      word(),
      word(),
    ]);
    expect(shift.refinedCount).toBe(1);
    expect(shift.meanAbsSec).toBeCloseTo(0.2 / 6, 10);
  });

  it('survives a non-finite timestamp rather than poisoning every mean', () => {
    const shift = timestampShift([
      word({ start: NaN, end: 2.1, originalStart: 1, originalEnd: 2, refined: true }),
      word({ start: 0.9, end: 2.1, originalStart: 1, originalEnd: 2, refined: true }),
    ]);
    expect(Number.isFinite(shift.meanAbsSec)).toBe(true);
    expect(shift.maxAbsSec).toBeCloseTo(0.1, 10);
  });
});
