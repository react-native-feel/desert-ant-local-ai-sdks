/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, what happens where the module is there but
 * the build cannot generate, which arguments are rejected before a native call is
 * made at all, that the two-step "do the work, then hand the result over" shape is
 * preserved, and that `cardShape` measures what it claims to.
 *
 * Generation itself is not testable here and is not testable anywhere in this
 * repo -- it needs the `MLX` package trait, which a CocoaPods build cannot enable
 * -- so the native module is a spy throughout. That is a larger gap than the
 * other packages have and it is stated rather than papered over: the spy below
 * proves the plumbing, and nothing in this file has ever seen a card the model
 * wrote.
 *
 * One rule this file deliberately does NOT break: it does not assert what a
 * title should say. `cardShape` is the exception and is the exception on purpose
 * -- it is the one piece of arithmetic this package performs rather than
 * forwards, so it is the one piece that needs pinning. The expected values below
 * are computed from the inputs by hand, not read off this implementation.
 */

import { cardShape } from '../card';

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

const FILES = [
  'model.safetensors',
  'model.safetensors.index.json',
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'chat_template.jinja',
];

/** A card record the way native builds one. */
function wire(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Filming a two-person podcast on iPhone',
    description:
      'A walkthrough of recording a two-person podcast using two iPhones and a single shared mic.',
    isEmpty: false,
    processingSec: 0.42,
    modelRevision: 'v0.1.0',
    modelRuntime: 'mlx',
    ...overrides,
  };
}

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    resolvedDirectory: jest.fn(() => '/models/title/v0.1.0'),
    missingFiles: jest.fn(() => [] as string[]),
    installedBytes: jest.fn(() => 293_658_528),
    takeCard: jest.fn(() => wire()),
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
      // The shipped state: the module binds, the folder can be fetched, and
      // nothing can be generated.
      isSupported: false,
      canDownloadWeights: true,
      mlxTraitEnabled: false,
      unsupportedReason:
        "This build cannot generate: desert-ant-core's `MLX` package trait is off.",
      nativeCoreVersion: '3.1.0',
      modelId: 'title',
      modelRepo: 'desert-ant-labs/title',
      modelRevision: 'v0.1.0',
      revisionIsPinned: true,
      modelSummary: 'On-device titles and descriptions.',
      modelFiles: FILES,
      weightsFileName: 'model.safetensors',
      osFloorIOS: 17,
      defaultMaxTokens: 96,
      createModel: jest.fn(() => model),
      prepare: jest.fn(async () => undefined),
      describe: jest.fn(async () => undefined),
      ...overrides,
    },
  };
}

/** The build this package cannot produce today, for the half of the surface that
 *  only exists there. */
function generatingNative(overrides: Record<string, unknown> = {}) {
  return fakeNative({
    isSupported: true,
    mlxTraitEnabled: true,
    unsupportedReason: '',
    ...overrides,
  });
}

function load(native: unknown) {
  let mod!: typeof import('../Title');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    mod = require('../Title');
  });
  return { Title: mod.Title };
}

async function loaded(native = fakeNative()) {
  const { Title } = load(native.module);
  return { Title, title: await Title.load(), native };
}

describe('Title without a native module', () => {
  const { Title } = load(null);

  it('reports unsupported rather than throwing at import', () => {
    expect(Title.isSupported).toBe(false);
    expect(Title.canDownloadWeights).toBe(false);
    expect(Title.mlxTraitEnabled).toBe(false);
    expect(Title.nativeCoreVersion).toBeNull();
    expect(Title.modelRevision).toBeNull();
    expect(Title.modelRepo).toBeNull();
    expect(Title.modelFiles).toEqual([]);
  });

  it('explains why, naming upstream rather than this package', () => {
    expect(Title.unsupportedReason).toMatch(/Apple silicon/);
  });

  it('falls back to upstream default for the decode cap', () => {
    expect(Title.defaultMaxTokens).toBe(96);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point', async () => {
    expect(() => Title.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM' })
    );
    await expect(Title.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
  });
});

describe('the two booleans, which is the whole shape of this package', () => {
  it('separates "this build cannot generate" from "this platform cannot run it"', () => {
    const { Title } = load(fakeNative().module);
    expect(Title.isSupported).toBe(false);
    // The point: the download half is alive even though the model half is not.
    expect(Title.canDownloadWeights).toBe(true);
    expect(Title.mlxTraitEnabled).toBe(false);
  });

  it('still constructs and downloads with isSupported false', async () => {
    const { title, native } = await loaded();
    expect(native.module.createModel).toHaveBeenCalledWith({
      directory: undefined,
      maxTokens: 96,
    });
    expect(native.module.prepare).toHaveBeenCalledTimes(1);
    expect(title.isDownloaded()).toBe(true);
    expect(title.resolvedDirectory()).toBe('/models/title/v0.1.0');
    expect(title.missingFiles()).toEqual([]);
    expect(title.installedBytes()).toBe(293_658_528);
  });

  it('refuses to generate, with a code an app can branch on and a reason', async () => {
    const { title, native } = await loaded(
      fakeNative({
        describe: jest.fn(async () => {
          throw Object.assign(new Error('the MLX trait is off'), {
            code: 'ERR_UNSUPPORTED_PLATFORM',
          });
        }),
      })
    );
    await expect(title.describe('a passage worth naming')).rejects.toMatchObject({
      code: 'ERR_UNSUPPORTED_PLATFORM',
    });
    expect(native.module.describe).toHaveBeenCalledTimes(1);
  });

  it('reports the trait as enabled once it is, without an edit here', () => {
    const { Title } = load(generatingNative().module);
    expect(Title.mlxTraitEnabled).toBe(true);
    expect(Title.isSupported).toBe(true);
    expect(Title.unsupportedReason).toBeNull();
  });
});

describe('static reporting', () => {
  it('reads the catalog off the binary rather than restating it here', () => {
    const { Title } = load(fakeNative().module);
    expect(Title.modelId).toBe('title');
    expect(Title.modelRepo).toBe('desert-ant-labs/title');
    expect(Title.modelRevision).toBe('v0.1.0');
    expect(Title.revisionIsPinned).toBe(true);
    expect(Title.weightsFileName).toBe('model.safetensors');
    expect(Title.osFloorIOS).toBe(17);
    expect(Title.modelFiles).toHaveLength(7);
  });

  it('reports an unpinned revision as unpinned, if upstream ever moves to a branch', () => {
    const { Title } = load(
      fakeNative({ modelRevision: 'main', revisionIsPinned: false }).module
    );
    expect(Title.revisionIsPinned).toBe(false);
  });

  it('prefers the native unsupported reason, which knows how the binary was built', () => {
    const { Title } = load(fakeNative().module);
    expect(Title.unsupportedReason).toMatch(/MLX/);
  });
});

describe('load and lifecycle', () => {
  it('forwards a directory and a decode cap', async () => {
    const native = fakeNative();
    const { Title } = load(native.module);
    await Title.load({ directory: '/tmp/title', maxTokens: 32 });
    expect(native.module.createModel).toHaveBeenCalledWith({
      directory: '/tmp/title',
      maxTokens: 32,
    });
  });

  it('routes download progress to the caller that asked for it', async () => {
    const native = fakeNative({
      prepare: jest.fn(async () => undefined),
    });
    const { Title } = load(native.module);
    const seen: number[] = [];
    native.module.prepare = jest.fn(async () => {
      native.listeners.forEach((l) => l({ jobId: 'title-1', phase: 'loadingModel', fraction: 0.5 }));
      // Another call's ticks must not reach this subscriber.
      native.listeners.forEach((l) => l({ jobId: 'title-99', phase: 'loadingModel', fraction: 1 }));
    });
    await Title.load({ onProgress: (event) => seen.push(event.fraction) });
    expect(seen).toEqual([0.5]);
  });

  it('unsubscribes when the call finishes', async () => {
    const native = fakeNative();
    const { Title } = load(native.module);
    await Title.load({ onProgress: () => undefined });
    expect(native.listeners).toHaveLength(0);
  });

  it('releases the model when warming fails, rather than leaking it', async () => {
    const native = fakeNative({
      prepare: jest.fn(async () => {
        throw new Error('network gone');
      }),
    });
    const { Title } = load(native.module);
    await expect(Title.load()).rejects.toBeDefined();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('refuses everything after release', async () => {
    const { title } = await loaded();
    title.release();
    title.release(); // idempotent
    expect(() => title.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(title.describe('anything')).rejects.toMatchObject({ code: 'ERR_RELEASED' });
  });
});

describe('describe, on a build that can', () => {
  it('does the work and takes the result separately', async () => {
    const native = generatingNative();
    const { Title } = load(native.module);
    const title = await Title.load();
    const card = await title.describe('Some text about recording a podcast.');

    // The shape limit 4 forces: the async call returns nothing, and the record
    // comes back through a synchronous member -- under the SAME job id, which is
    // what keeps two concurrent calls from taking each other's answer.
    const jobId = native.module.describe.mock.calls[0]![2] as string;
    expect(jobId).toMatch(/^title-\d+$/);
    expect(native.module.describe).toHaveBeenCalledWith(
      native.model,
      'Some text about recording a podcast.',
      jobId
    );
    await expect(native.module.describe.mock.results[0]!.value).resolves.toBeUndefined();
    expect(native.model.takeCard).toHaveBeenCalledWith(jobId);
    expect(card.title).toBe('Filming a two-person podcast on iPhone');
    expect(card.modelRuntime).toBe('mlx');
  });

  it('gives each call its own job id, so concurrent calls do not collide', async () => {
    const native = generatingNative();
    const { Title } = load(native.module);
    const title = await Title.load();
    await title.describe('one');
    await title.describe('two');
    const ids = native.module.describe.mock.calls.map((call: unknown[]) => call[2]);
    expect(new Set(ids).size).toBe(2);
  });

  it('passes the passage through unchanged, including its whitespace', async () => {
    const native = generatingNative();
    const { Title } = load(native.module);
    const title = await Title.load();
    await title.describe('  a passage with edges  ');
    expect(native.module.describe.mock.calls[0]![1]).toBe('  a passage with edges  ');
  });
});

describe('arguments refused before any native call', () => {
  it('refuses an empty or whitespace passage', async () => {
    const native = generatingNative();
    const { Title } = load(native.module);
    const title = await Title.load();
    for (const bad of ['', '   ', '\n\t']) {
      await expect(title.describe(bad)).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT' });
    }
    await expect(title.describe(undefined as never)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.describe).not.toHaveBeenCalled();
  });

  it('refuses a decode cap that is not a positive whole number of tokens', () => {
    const native = fakeNative();
    const { Title } = load(native.module);
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => Title.create({ maxTokens: bad })).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
      );
    }
    expect(native.module.createModel).not.toHaveBeenCalled();
  });

  it('refuses a directory that is present but blank', () => {
    const native = fakeNative();
    const { Title } = load(native.module);
    expect(() => Title.create({ directory: '   ' })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(native.module.createModel).not.toHaveBeenCalled();
  });
});

describe('cardShape', () => {
  // Every expectation below is counted by hand from the strings, not read off
  // the implementation.

  it('accepts a card of the published shape', () => {
    const shape = cardShape({
      title: 'Filming a two-person podcast on iPhone',
      description: 'A walkthrough of recording two people with two phones and one mic.',
    });
    expect(shape.titleWordCount).toBe(6);
    expect(shape.titleWordsInRange).toBe(true);
    expect(shape.titleEndsWithPunctuation).toBe(false);
    expect(shape.descriptionSentenceCount).toBe(1);
    expect(shape.descriptionSentencesInRange).toBe(true);
    expect(shape.matchesPublishedShape).toBe(true);
  });

  it('counts two sentences as two', () => {
    const shape = cardShape({
      title: 'Moving the review to Thursday',
      description: 'The weekly review moves to Thursday. Everyone has confirmed.',
    });
    expect(shape.descriptionSentenceCount).toBe(2);
    expect(shape.matchesPublishedShape).toBe(true);
  });

  it('flags a title that is too short and one that is too long', () => {
    expect(cardShape({ title: 'Podcast setup', description: 'A note.' }).titleWordsInRange).toBe(
      false
    );
    expect(
      cardShape({
        title: 'A rather long title about filming a two person podcast on an iPhone',
        description: 'A note.',
      }).titleWordsInRange
    ).toBe(false);
  });

  it('flags a title that ends in punctuation', () => {
    const shape = cardShape({ title: 'Filming a podcast on iPhone.', description: 'A note.' });
    expect(shape.titleEndsWithPunctuation).toBe(true);
    expect(shape.matchesPublishedShape).toBe(false);
  });

  it('flags a description that runs past two sentences', () => {
    const shape = cardShape({
      title: 'Filming a podcast on iPhone',
      description: 'One. Two. Three.',
    });
    expect(shape.descriptionSentenceCount).toBe(3);
    expect(shape.matchesPublishedShape).toBe(false);
  });

  it('counts an unterminated description as one sentence, not zero', () => {
    // The model routinely ends without a period, and that is not a failure.
    const shape = cardShape({
      title: 'Filming a podcast on iPhone',
      description: 'A walkthrough of recording two people with two phones',
    });
    expect(shape.descriptionSentenceCount).toBe(1);
    expect(shape.matchesPublishedShape).toBe(true);
  });

  it('collapses a run of terminal punctuation instead of counting each mark', () => {
    expect(
      cardShape({ title: 'Waiting for the update', description: 'It is late...' })
        .descriptionSentenceCount
    ).toBe(1);
  });

  it('counts CJK terminal punctuation, because the model writes in the passage language', () => {
    const shape = cardShape({
      title: 'iPhone で podcast を撮影する',
      description: '二台の iPhone で収録する方法。マイクは一本。',
    });
    expect(shape.descriptionSentenceCount).toBe(2);
  });

  it('flags emoji and hashtags, which the prompt forbids', () => {
    const emoji = cardShape({ title: 'Filming a podcast 🎙 today', description: 'A note.' });
    expect(emoji.hasEmoji).toBe(true);
    expect(emoji.matchesPublishedShape).toBe(false);

    const tag = cardShape({ title: 'Filming a podcast on iPhone', description: 'A note. #podcast' });
    expect(tag.hasHashtag).toBe(true);
    expect(tag.matchesPublishedShape).toBe(false);
  });

  it('does not mistake a digit for an emoji', () => {
    // `\p{Emoji}` matches ASCII digits, because they are keycap bases. The
    // regression this pins is a card with a number in it reading as emoji.
    const shape = cardShape({
      title: 'Recording 2 people on 1 mic',
      description: 'A setup for 2 speakers.',
    });
    expect(shape.hasEmoji).toBe(false);
    expect(shape.matchesPublishedShape).toBe(true);
  });

  it('does not mistake a mid-word hash for a hashtag', () => {
    expect(cardShape({ title: 'Writing in C# on macOS', description: 'A note.' }).hasHashtag).toBe(
      false
    );
  });

  it('survives an empty card and a missing one', () => {
    for (const input of [null, undefined, { title: '', description: '' }]) {
      const shape = cardShape(input);
      expect(shape.titleWordCount).toBe(0);
      expect(shape.descriptionSentenceCount).toBe(0);
      expect(shape.matchesPublishedShape).toBe(false);
    }
  });
});
