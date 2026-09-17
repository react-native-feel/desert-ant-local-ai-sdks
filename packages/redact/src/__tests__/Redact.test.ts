/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, which arguments are rejected before a native
 * call is made at all, that the two-step "do the work, then hand the result over"
 * shape is preserved, that the label lists and the confidence floor are read off
 * the binary rather than duplicated here, and that `restore` puts back exactly
 * what was taken out.
 *
 * Detection itself is not testable here -- it needs the weights and an inference
 * session -- so the native module is a spy and the example app proves the rest.
 *
 * One rule this file deliberately does NOT test: it does not assert which labels
 * a given sentence produces, because the taxonomy and the weights are upstream's
 * and an answer key here would be a fixture of this package's memory rather than
 * of the model's behaviour.
 */

import { restore } from '../restore';

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

const LABELS = [
  'GIVEN_NAME',
  'SURNAME',
  'STREET_NAME',
  'BUILDING_NUMBER',
  'SECONDARY_ADDRESS',
  'CITY',
  'STATE',
  'ZIP_CODE',
  'EMAIL',
  'PHONE',
  'CREDIT_CARD',
  'BANK_ACCOUNT',
  'ROUTING_NUMBER',
  'IP_ADDRESS',
  'URL',
  'GOVERNMENT_ID',
  'PASSPORT',
  'DRIVERS_LICENSE',
  'TAX_ID',
  'SSN',
  'IMEI',
  'ORG',
];

function redaction(overrides: Record<string, unknown> = {}) {
  return {
    redactedText: 'Email [GIVEN_NAME_1] at [EMAIL_1].',
    items: [
      {
        label: 'GIVEN_NAME',
        original: 'Anna',
        placeholder: '[GIVEN_NAME_1]',
        confidence: 0.94,
        start: 6,
        end: 10,
      },
      {
        label: 'EMAIL',
        original: 'anna@example.com',
        placeholder: '[EMAIL_1]',
        confidence: 1,
        start: 14,
        end: 30,
      },
    ],
    processingSec: 0.031,
    modelRevision: 'v0.4.0',
    ...overrides,
  };
}

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    takeRedaction: jest.fn(() => redaction()),
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
      modelRevision: 'v0.4.0',
      modelRepo: 'desert-ant-labs/redact',
      labels: LABELS,
      defaultLabels: LABELS.filter((label) => label !== 'ORG'),
      labelDisplayNames: {
        GIVEN_NAME: 'Given name',
        EMAIL: 'Email',
        IP_ADDRESS: 'IP address',
        ORG: 'Organisation',
      },
      defaultMinimumConfidence: 0.6,
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      redaction: jest.fn(async () => undefined),
      ...overrides,
    },
  };
}

function load(native: unknown) {
  let mod!: typeof import('../Redact');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    mod = require('../Redact');
  });
  return { Redact: mod.Redact };
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (a web build, or one never prebuilt)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const { Redact } = load(null);
    expect(Redact.isSupported).toBe(false);
    expect(Redact.unsupportedReason).toMatch(/not available in this build/);
    expect(Redact.nativeCoreVersion).toBeNull();
    expect(Redact.modelRevision).toBeNull();
    expect(Redact.modelRepo).toBeNull();
  });

  it('still answers the questions a UI asks while rendering', () => {
    const { Redact } = load(null);
    expect(Redact.defaultMinimumConfidence).toBe(0.6);
    expect(Redact.labels).toHaveLength(22);
    expect(Redact.labels).toContain('ORG');
    expect(Redact.defaultLabels).toHaveLength(21);
    expect(Redact.defaultLabels).not.toContain('ORG');
    expect(Redact.labelDisplayNames).toEqual({});
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point', async () => {
    const { Redact } = load(null);
    expect(() => Redact.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'redact' })
    );
    await expect(Redact.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
  });
});

describe('on a device whose ABI has no LiteRT build', () => {
  it('prefers the native reason, which names the ABIs the device reported', () => {
    const { Redact } = load(
      fakeNative({
        isSupported: false,
        unsupportedReason:
          'Redact ships arm64-v8a and x86_64 only; this device reports armeabi-v7a',
      }).module
    );
    expect(Redact.isSupported).toBe(false);
    expect(Redact.unsupportedReason).toMatch(/armeabi-v7a/);
  });
});

describe('reading the binary rather than duplicating it', () => {
  it('reports the label lists the linked module has, in its order', () => {
    const native = fakeNative({
      labels: ['EMAIL', 'PHONE', 'ORG'],
      defaultLabels: ['EMAIL', 'PHONE'],
    });
    const { Redact } = load(native.module);
    expect(Redact.labels).toEqual(['EMAIL', 'PHONE', 'ORG']);
    expect(Redact.defaultLabels).toEqual(['EMAIL', 'PHONE']);
  });

  // The union in types.ts is an editor convenience; the binary is the authority,
  // so a label a future SDK adds has to survive both the getter and the guard.
  it('passes through a label the union does not name yet', async () => {
    const native = fakeNative({ labels: [...LABELS, 'VEHICLE_ID'] });
    const { Redact } = load(native.module);
    expect(Redact.labels).toContain('VEHICLE_ID');
    const redact = await Redact.load();
    await redact.redaction('a', { labels: ['VEHICLE_ID' as never] });
    expect(native.module.redaction.mock.calls[0]![2]).toEqual({
      minimumConfidence: 0.6,
      labels: ['VEHICLE_ID'],
    });
  });

  it('reports the confidence floor the module uses', () => {
    const { Redact } = load(fakeNative({ defaultMinimumConfidence: 0.75 }).module);
    expect(Redact.defaultMinimumConfidence).toBe(0.75);
  });

  it('falls back when the module reports a value that cannot be right', () => {
    const { Redact } = load(fakeNative({ defaultMinimumConfidence: 4 }).module);
    expect(Redact.defaultMinimumConfidence).toBe(0.6);
  });
});

describe('display names', () => {
  it('reports the map the platform has', () => {
    const { Redact } = load(fakeNative().module);
    expect(Redact.labelDisplayNames.IP_ADDRESS).toBe('IP address');
    expect(Redact.displayName('EMAIL')).toBe('Email');
  });

  // The one real asymmetry between the two upstream SDKs: `Label.displayName` is
  // Swift-only. Refused rather than derived -- a title-cased slug would be wrong
  // for IMEI, SSN, ORG and IP_ADDRESS, and wrong in a privacy UI is worse than
  // absent.
  it('refuses with ERR_UNSUPPORTED_PLATFORM where the SDK publishes none', () => {
    const { Redact } = load(fakeNative({ labelDisplayNames: {} }).module);
    expect(Redact.labelDisplayNames).toEqual({});
    expect(() => Redact.displayName('EMAIL')).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'redact' })
    );
  });

  it('rejects a label this build does not have', () => {
    const { Redact } = load(fakeNative().module);
    expect(() => Redact.displayName('NOT_A_LABEL' as never)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
  });
});

describe('redaction', () => {
  it('runs the work, then reads the result back synchronously', async () => {
    // The split is a workaround for a real crash, so it is worth pinning: the
    // async half must return nothing and the record must come back off the
    // synchronous member. A refactor that "simplifies" this into one async call
    // reintroduces a segfault -- see ios/RedactModel.swift.
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    const result = await redact.redaction('Email Anna at anna@example.com.');
    expect(native.module.redaction).toHaveBeenCalledWith(
      native.model,
      'Email Anna at anna@example.com.',
      { minimumConfidence: 0.6, labels: [] },
      expect.any(String)
    );
    expect(native.model.takeRedaction).toHaveBeenCalledWith(
      native.module.redaction.mock.calls[0]![3]
    );
    expect(result.redactedText).toBe('Email [GIVEN_NAME_1] at [EMAIL_1].');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      label: 'GIVEN_NAME',
      original: 'Anna',
      placeholder: '[GIVEN_NAME_1]',
      confidence: 0.94,
      start: 6,
      end: 10,
    });
    expect(result.modelRevision).toBe('v0.4.0');
    expect(result.processingSec).toBe(0.031);
  });

  it('takes its own job, so two concurrent calls cannot swap answers', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await Promise.all([redact.redaction('one'), redact.redaction('two')]);
    const first = native.module.redaction.mock.calls[0]![3];
    const second = native.module.redaction.mock.calls[1]![3];
    expect(first).not.toBe(second);
    expect(native.model.takeRedaction.mock.calls.map((c) => c[0])).toEqual([first, second]);
  });

  it('sends the empty label array that means "the model’s default set"', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await redact.redaction('a');
    expect(native.module.redaction.mock.calls[0]![2]).toEqual({
      minimumConfidence: 0.6,
      labels: [],
    });
  });

  it('forwards an explicit label selection', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await redact.redaction('a', { labels: ['EMAIL', 'PHONE'] });
    expect(native.module.redaction.mock.calls[0]![2]).toEqual({
      minimumConfidence: 0.6,
      labels: ['EMAIL', 'PHONE'],
    });
  });

  // Upstream's binding resolves label names with `compactMap(Label.init(rawValue:))`,
  // which drops what it does not recognise: one typo silently widens the
  // redaction, and a set of nothing but typos silently redacts nothing at all.
  it('rejects a label the binary does not have, rather than letting it be dropped', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await expect(
      redact.redaction('a', { labels: ['EMIAL' as never] })
    ).rejects.toMatchObject({ code: 'ERR_INVALID_ARGUMENT', model: 'redact' });
    expect(native.module.redaction).not.toHaveBeenCalled();
  });

  it('rejects an empty label array, which would redact nothing at all', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await expect(redact.redaction('a', { labels: [] })).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.redaction).not.toHaveBeenCalled();
  });

  it('defaults the confidence to what the module reports', async () => {
    const native = fakeNative({ defaultMinimumConfidence: 0.8 });
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await redact.redaction('a');
    expect(native.module.redaction.mock.calls[0]![2]).toEqual({
      minimumConfidence: 0.8,
      labels: [],
    });
  });

  // Upstream clamps an out-of-range confidence into 0...1 and a non-finite one to
  // 0.6. A silently clamped threshold is a redaction policy that is not the one
  // the caller asked for, so this refuses instead.
  it('rejects a confidence that is not a probability rather than clamping it', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    for (const bad of [-0.1, 1.1, NaN, Infinity, '0.5' as never]) {
      await expect(redact.redaction('a', { minimumConfidence: bad })).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
      });
    }
    expect(native.module.redaction).not.toHaveBeenCalled();
  });

  it('accepts the bounds themselves', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await redact.redaction('a', { minimumConfidence: 0 });
    await redact.redaction('a', { minimumConfidence: 1 });
    expect(native.module.redaction.mock.calls.map((c) => (c[2] as { minimumConfidence: number }).minimumConfidence)).toEqual([0, 1]);
  });

  it('rejects text that is not a string before touching native', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await expect(redact.redaction(undefined as never)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
      model: 'redact',
    });
    expect(native.module.redaction).not.toHaveBeenCalled();
  });

  it('accepts the empty string, because blank input is an answer rather than an error', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    native.model.takeRedaction.mockReturnValueOnce(
      redaction({ redactedText: '', items: [], processingSec: 0 })
    );
    await expect(redact.redaction('')).resolves.toMatchObject({ redactedText: '', items: [] });
    expect(native.module.redaction).toHaveBeenCalled();
  });

  it('forwards only the progress belonging to its own call', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    const seen: number[] = [];
    native.module.redaction.mockImplementationOnce(async () => {
      native.listeners.forEach((l) =>
        l({ jobId: 'redact-99', phase: 'loadingModel', fraction: 0.1 })
      );
      native.listeners.forEach((l) =>
        l({ jobId: 'redact-2', phase: 'loadingModel', fraction: 0.5 })
      );
    });
    await redact.redaction('a', { onProgress: (e) => seen.push(e.fraction) });
    expect(seen).toEqual([0.5]);
  });
});

describe('restore', () => {
  // The round trip is the whole product: mask, send the masked text somewhere,
  // put the originals back into what comes back.
  it('puts every original back into the redacted text itself', () => {
    const r = redaction();
    expect(restore(r, r.redactedText)).toBe('Email Anna at anna@example.com.');
  });

  it('fills the originals into a rewritten reply', () => {
    const r = redaction();
    const reply = 'Sure — I will write to [GIVEN_NAME_1] at [EMAIL_1] today.';
    expect(restore(r, reply)).toBe('Sure — I will write to Anna at anna@example.com today.');
  });

  it('replaces every occurrence, not just the first', () => {
    const r = redaction();
    expect(restore(r, '[GIVEN_NAME_1], [GIVEN_NAME_1], [GIVEN_NAME_1]')).toBe('Anna, Anna, Anna');
  });

  // Placeholders are bracketed and numbered, so none is a prefix of another and
  // no substitution can create or destroy a later one.
  it('does not depend on the order of the items', () => {
    const r = redaction();
    const reversed = { items: [...r.items].reverse() };
    expect(restore(reversed, r.redactedText)).toBe(restore(r, r.redactedText));
  });

  it('leaves text with no placeholders alone', () => {
    expect(restore(redaction(), 'nothing to put back')).toBe('nothing to put back');
  });

  it('needs no model, so it answers where the native module is absent', () => {
    // Imported at the top level from '../restore' with no native module mocked
    // into this describe block at all, which is the point: this call is pure.
    expect(restore({ items: [] }, 'anything')).toBe('anything');
  });

  it('rejects arguments that are not a redaction and a string', () => {
    expect(() => restore(undefined as never, 'a')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT', model: 'redact' })
    );
    expect(() => restore({ items: [] }, undefined as never)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(() => restore({ items: [{ placeholder: 1 } as never] }, 'a')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
  });
});

describe('the items a redaction carries', () => {
  it('reports offsets that slice the original back out of the source text', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    const source = 'Email Anna at anna@example.com.';
    const result = await redact.redaction(source);
    for (const item of result.items) {
      expect(source.slice(item.start, item.end)).toBe(item.original);
    }
  });
});

describe('lifecycle', () => {
  it('releases the native model once, however many times it is asked', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    redact.release();
    redact.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('throws ERR_RELEASED from every entry point afterwards', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    redact.release();
    expect(() => redact.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(redact.redaction('a')).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(redact.warm()).rejects.toMatchObject({ code: 'ERR_RELEASED' });
  });

  it('releases the model when warming it fails, rather than leaking a handle', async () => {
    const native = fakeNative({
      load: jest.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ERR_MODEL_UNAVAILABLE' });
      }),
    });
    const { Redact } = load(native.module);
    await expect(Redact.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('warm and download are the same call, because upstream fuses them', async () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = Redact.create();
    await redact.warm();
    await redact.download();
    expect(native.module.load).toHaveBeenCalledTimes(2);
  });

  it('creates without touching the network, so isDownloaded can be asked cheaply', () => {
    const native = fakeNative();
    const { Redact } = load(native.module);
    const redact = Redact.create();
    expect(redact.isDownloaded()).toBe(true);
    expect(native.module.load).not.toHaveBeenCalled();
    expect(native.module.createModel).toHaveBeenCalledWith({ directory: undefined });
  });

  it('wraps an uncoded native failure as ERR_INFERENCE_FAILED with the cause kept', async () => {
    const boom = new Error('something in Core ML');
    const native = fakeNative({
      redaction: jest.fn(async () => {
        throw boom;
      }),
    });
    const { Redact } = load(native.module);
    const redact = await Redact.load();
    await expect(redact.redaction('a')).rejects.toMatchObject({
      code: 'ERR_INFERENCE_FAILED',
      model: 'redact',
      cause: boom,
    });
  });
});
