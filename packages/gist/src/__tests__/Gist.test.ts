/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, which arguments are rejected before a native
 * call is made at all, that the two-step "do the work, then hand the result over"
 * shape is preserved, that a distribution becomes a map on this side, and that
 * the numbers a UI shows are read off the binary rather than duplicated here.
 *
 * Tagging itself is not testable here -- it needs the weights and an inference
 * session -- so the native module is a spy and the example app proves the rest.
 *
 * Two rules this file deliberately does NOT test. It does not recompute the
 * taxonomy's tuned threshold from a ranking, because neither SDK exposes that
 * number and a test that reconstructed it would be asserting a second
 * implementation into existence. And it does not reimplement `channelTopics` to
 * check the roll-up's arithmetic: that arithmetic is upstream's, bound rather
 * than ported, and what is worth pinning here is the conversion into it.
 */

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

function tagging(overrides: Record<string, unknown> = {}) {
  return {
    topics: [
      { slug: 'technology', name: 'Technology & Software', score: 0.91 },
      { slug: 'business', name: 'Business & Entrepreneurship', score: 0.44 },
    ],
    threshold: null,
    processingSec: 0.012,
    modelRevision: 'v2.2.0',
    variant: 'multilingual',
    ...overrides,
  };
}

function distribution(overrides: Record<string, unknown> = {}) {
  return {
    scores: [
      { slug: 'business', score: 0.44 },
      { slug: 'sports', score: 0.01 },
      { slug: 'technology', score: 0.91 },
    ],
    processingSec: 0.011,
    modelRevision: 'v2.2.0',
    variant: 'multilingual',
    ...overrides,
  };
}

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    takeTagging: jest.fn(() => tagging()),
    takeDistribution: jest.fn(() => distribution()),
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
      modelRevision: 'v2.2.0',
      modelRepo: 'desert-ant-labs/gist',
      defaultTopK: 3,
      variants: ['multilingual', 'english'],
      defaultVariant: 'multilingual',
      defaultRollupOptions: {
        topN: 5,
        floor: 0.05,
        minPosts: 3,
        halfLifeDays: 0,
        touch: 0.15,
        nowMillis: 0,
      },
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      classify: jest.fn(async () => undefined),
      scores: jest.fn(async () => undefined),
      channelTopics: jest.fn(() => [{ slug: 'technology', share: 0.31, postCount: 9 }]),
      ...overrides,
    },
  };
}

function load(native: unknown) {
  let gist!: typeof import('../Gist');
  let channel!: typeof import('../channel');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    gist = require('../Gist');
    channel = require('../channel');
  });
  return { Gist: gist.Gist, channelTopics: channel.channelTopics };
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (a web build, or one never prebuilt)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const { Gist } = load(null);
    expect(Gist.isSupported).toBe(false);
    expect(Gist.unsupportedReason).toMatch(/not available in this build/);
    expect(Gist.nativeCoreVersion).toBeNull();
    expect(Gist.modelRevision).toBeNull();
    expect(Gist.modelRepo).toBeNull();
  });

  it('still answers the questions a UI asks while rendering', () => {
    const { Gist } = load(null);
    expect(Gist.defaultTopK).toBe(3);
    expect(Gist.defaultVariant).toBe('multilingual');
    expect(Gist.variants).toEqual(['multilingual']);
    expect(Gist.defaultRollupOptions).toEqual({
      topN: 5,
      floor: 0.05,
      minPosts: 3,
      halfLifeDays: 0,
      touch: 0.15,
      nowMillis: 0,
    });
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point, roll-up included', async () => {
    const { Gist, channelTopics } = load(null);
    expect(() => Gist.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'gist' })
    );
    await expect(Gist.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
    // The roll-up needs no model, but it is still a native function.
    expect(() => channelTopics([])).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM' })
    );
  });
});

describe('on a device whose ABI has no LiteRT build', () => {
  it('prefers the native reason, which names the ABIs the device reported', () => {
    const { Gist } = load(
      fakeNative({
        isSupported: false,
        unsupportedReason: 'Gist ships arm64-v8a and x86_64 only; this device reports armeabi-v7a',
      }).module
    );
    expect(Gist.isSupported).toBe(false);
    expect(Gist.unsupportedReason).toMatch(/armeabi-v7a/);
  });
});

describe('reading the binary rather than duplicating it', () => {
  it('reports the topic count and roll-up defaults the linked module uses', () => {
    const { Gist } = load(
      fakeNative({
        defaultTopK: 5,
        defaultRollupOptions: { topN: 8, floor: 0.1, minPosts: 4, halfLifeDays: 30, touch: 0.2, nowMillis: 0 },
      }).module
    );
    expect(Gist.defaultTopK).toBe(5);
    expect(Gist.defaultRollupOptions.topN).toBe(8);
    expect(Gist.defaultRollupOptions.halfLifeDays).toBe(30);
  });

  it('falls back when the module reports a value that cannot be right', () => {
    // A zero here would mean a classify that returns nothing.
    const { Gist } = load(fakeNative({ defaultTopK: 0 }).module);
    expect(Gist.defaultTopK).toBe(3);
  });

  it('reports the variants this platform actually has', () => {
    const ios = load(fakeNative().module);
    expect(ios.Gist.variants).toEqual(['multilingual', 'english']);
    const android = load(fakeNative({ variants: ['multilingual'] }).module);
    expect(android.Gist.variants).toEqual(['multilingual']);
  });
});

describe('variants', () => {
  it('passes the chosen variant to the native constructor', () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    Gist.create({ variant: 'english' });
    expect(native.module.createModel).toHaveBeenCalledWith({
      directory: undefined,
      variant: 'english',
    });
  });

  it('defaults to the multilingual build the module names', () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = Gist.create();
    expect(gist.variant).toBe('multilingual');
    expect(native.module.createModel).toHaveBeenCalledWith({
      directory: undefined,
      variant: 'multilingual',
    });
  });

  // The asymmetry the Kotlin SDK forces: `Gist(context, directory)` takes no
  // variant, so the English build is Swift-only today. Refused with a readable
  // sentence rather than silently pulling 74 MB instead of 15.
  it('refuses a variant this platform does not have, before touching native', () => {
    const native = fakeNative({ variants: ['multilingual'] });
    const { Gist } = load(native.module);
    expect(() => Gist.create({ variant: 'english' })).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'gist' })
    );
    expect(native.module.createModel).not.toHaveBeenCalled();
  });

  it('rejects a variant name that is not one at all', () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    expect(() => Gist.create({ variant: 'huge' as never })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(native.module.createModel).not.toHaveBeenCalled();
  });
});

describe('classify', () => {
  it('runs the work, then reads the result back synchronously', async () => {
    // The split is a workaround for a real crash, so it is worth pinning: the
    // async half must return nothing and the record must come back off the
    // synchronous member. A refactor that "simplifies" this into one async call
    // reintroduces a segfault -- see ios/GistModel.swift.
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    const result = await gist.classify('How to start a podcast with your iPhone');
    expect(native.module.classify).toHaveBeenCalledWith(
      native.model,
      'How to start a podcast with your iPhone',
      { topK: 3, threshold: -1 },
      expect.any(String)
    );
    expect(native.model.takeTagging).toHaveBeenCalledWith(
      native.module.classify.mock.calls[0]![3]
    );
    expect(result.topics).toHaveLength(2);
    expect(result.topic).toEqual({
      slug: 'technology',
      name: 'Technology & Software',
      score: 0.91,
    });
  });

  it('takes its own job, so two concurrent calls cannot swap answers', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    await Promise.all([gist.classify('one'), gist.classify('two')]);
    const first = native.module.classify.mock.calls[0]![3];
    const second = native.module.classify.mock.calls[1]![3];
    expect(first).not.toBe(second);
    expect(native.model.takeTagging.mock.calls.map((c) => c[0])).toEqual([first, second]);
  });

  it('flattens the top topic, and reports null when there is none', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    native.model.takeTagging.mockReturnValueOnce(tagging({ topics: [] }));
    const blank = await gist.classify('   ');
    expect(blank.topics).toEqual([]);
    expect(blank.topic).toBeNull();
  });

  it('echoes an explicit threshold and reports null when none was given', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    expect((await gist.classify('a')).threshold).toBeNull();

    native.model.takeTagging.mockReturnValueOnce(tagging({ threshold: 0.5 }));
    const strict = await gist.classify('a', { threshold: 0.5 });
    expect(strict.threshold).toBe(0.5);
    expect(native.module.classify).toHaveBeenLastCalledWith(
      native.model,
      'a',
      { topK: 3, threshold: 0.5 },
      expect.any(String)
    );
  });

  it('sends the sentinel rather than an absent field when no threshold is given', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    await gist.classify('a');
    expect(native.module.classify.mock.calls[0]![2]).toEqual({ topK: 3, threshold: -1 });
  });

  it('defaults topK to what the module reports', async () => {
    const native = fakeNative({ defaultTopK: 6 });
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    await gist.classify('a');
    expect(native.module.classify.mock.calls[0]![2]).toEqual({ topK: 6, threshold: -1 });
  });

  it('rejects a topK that is not a whole number of at least one', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    for (const topK of [0, -1, 1.5, NaN]) {
      await expect(gist.classify('a', { topK })).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
      });
    }
    expect(native.module.classify).not.toHaveBeenCalled();
  });

  it('rejects a threshold that is not a probability', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    for (const threshold of [-0.1, 1.1, NaN, '0.5' as never]) {
      await expect(gist.classify('a', { threshold })).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
      });
    }
    expect(native.module.classify).not.toHaveBeenCalled();
  });

  it('rejects text that is not a string before touching native', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    await expect(gist.classify(undefined as never)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
      model: 'gist',
    });
    expect(native.module.classify).not.toHaveBeenCalled();
  });

  it('accepts the empty string, because blank input is an answer rather than an error', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    native.model.takeTagging.mockReturnValueOnce(tagging({ topics: [] }));
    await expect(gist.classify('')).resolves.toMatchObject({ topics: [], topic: null });
    expect(native.module.classify).toHaveBeenCalled();
  });

  it('forwards only the progress belonging to its own call', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    const seen: number[] = [];
    native.module.classify.mockImplementationOnce(async () => {
      native.listeners.forEach((l) => l({ jobId: 'gist-99', phase: 'loadingModel', fraction: 0.1 }));
      native.listeners.forEach((l) => l({ jobId: 'gist-2', phase: 'loadingModel', fraction: 0.5 }));
    });
    await gist.classify('a', { onProgress: (e) => seen.push(e.fraction) });
    expect(seen).toEqual([0.5]);
  });
});

describe('scores', () => {
  it('folds the wire array into a map, since that is what a roll-up eats', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    const result = await gist.scores('a post about databases');
    expect(native.module.scores).toHaveBeenCalledWith(
      native.model,
      'a post about databases',
      expect.any(String)
    );
    expect(result.scores).toEqual({ business: 0.44, sports: 0.01, technology: 0.91 });
    expect(result.processingSec).toBe(0.011);
    expect(result.modelRevision).toBe('v2.2.0');
    expect(result.variant).toBe('multilingual');
  });

  it('reads the distribution back off the same job the work was done under', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    await gist.scores('a');
    expect(native.model.takeDistribution).toHaveBeenCalledWith(
      native.module.scores.mock.calls[0]![2]
    );
  });
});

describe('channelTopics', () => {
  it('converts each post from a map to the array the bridge takes', () => {
    const native = fakeNative();
    const { channelTopics } = load(native.module);
    channelTopics([{ topics: { technology: 0.9, business: 0.2 } }]);
    expect(native.module.channelTopics.mock.calls[0]![0]).toEqual([
      {
        topics: [
          { slug: 'technology', score: 0.9 },
          { slug: 'business', score: 0.2 },
        ],
        timestampMillis: 0,
      },
    ]);
  });

  it('fills every option from the binary defaults, not from a caller partial', () => {
    const native = fakeNative();
    const { channelTopics } = load(native.module);
    channelTopics([{ topics: { a: 1 } }], { topN: 2 });
    expect(native.module.channelTopics.mock.calls[0]![1]).toEqual({
      topN: 2,
      floor: 0.05,
      minPosts: 3,
      halfLifeDays: 0,
      touch: 0.15,
      nowMillis: 0,
    });
  });

  it('sends 0 for a post with no timestamp, which is upstream’s "never decayed"', () => {
    const native = fakeNative();
    const { channelTopics } = load(native.module);
    channelTopics([{ topics: { a: 1 } }, { topics: { a: 1 }, timestampMillis: 1_700_000_000_000 }]);
    const posts = native.module.channelTopics.mock.calls[0]![0] as { timestampMillis: number }[];
    expect(posts[0]!.timestampMillis).toBe(0);
    expect(posts[1]!.timestampMillis).toBe(1_700_000_000_000);
  });

  it('returns whatever the native roll-up decided, untouched', () => {
    const native = fakeNative();
    const { channelTopics } = load(native.module);
    expect(channelTopics([{ topics: { technology: 0.9 } }])).toEqual([
      { slug: 'technology', share: 0.31, postCount: 9 },
    ]);
  });

  it('rejects a malformed post and a nonsense option before touching native', () => {
    const native = fakeNative();
    const { channelTopics } = load(native.module);
    expect(() => channelTopics([{} as never])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(() => channelTopics([{ topics: { a: 'high' as never } }])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(() => channelTopics([{ topics: { a: 1 } }], { topN: 0 })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(() => channelTopics([{ topics: { a: 1 } }], { minPosts: 1.5 })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(native.module.channelTopics).not.toHaveBeenCalled();
  });

  it('needs no model, so it answers on a handle that was never created', () => {
    const native = fakeNative();
    const { channelTopics } = load(native.module);
    channelTopics([{ topics: { a: 1 } }]);
    expect(native.module.createModel).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('releases the native model once, however many times it is asked', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    gist.release();
    gist.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('throws ERR_RELEASED from every entry point afterwards', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    gist.release();
    expect(() => gist.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(gist.classify('a')).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(gist.scores('a')).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(gist.warm()).rejects.toMatchObject({ code: 'ERR_RELEASED' });
  });

  it('releases the model when warming it fails, rather than leaking a handle', async () => {
    const native = fakeNative({
      load: jest.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ERR_MODEL_UNAVAILABLE' });
      }),
    });
    const { Gist } = load(native.module);
    await expect(Gist.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('warm and download are the same call, because upstream fuses them', async () => {
    const native = fakeNative();
    const { Gist } = load(native.module);
    const gist = Gist.create();
    await gist.warm();
    await gist.download();
    expect(native.module.load).toHaveBeenCalledTimes(2);
  });

  it('wraps an uncoded native failure as ERR_INFERENCE_FAILED with the cause kept', async () => {
    const boom = new Error('something in Core ML');
    const native = fakeNative({
      classify: jest.fn(async () => {
        throw boom;
      }),
    });
    const { Gist } = load(native.module);
    const gist = await Gist.load();
    await expect(gist.classify('a')).rejects.toMatchObject({
      code: 'ERR_INFERENCE_FAILED',
      model: 'gist',
      cause: boom,
    });
  });
});
