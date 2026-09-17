/**
 * The parts of the surface that are ours rather than the model's: what happens
 * where there is no native module, which arguments are rejected before a native
 * call is made at all, that the two-step "do the work, then hand the result over"
 * shape is preserved, that the flat wire record is narrowed back into the right
 * member of the union, and that `outline` draws what upstream's `Shape.outline`
 * draws.
 *
 * Recognition itself is not testable here -- it needs the weights and an
 * inference session -- so the native module is a spy and the example app proves
 * the rest.
 *
 * One rule this file deliberately does NOT test: it does not assert which class a
 * given stroke produces, because the classifier and its calibrated gates are
 * upstream's and an answer key here would be a fixture of this package's memory
 * rather than of the model's behaviour.
 *
 * `outline` is the exception, and it is the exception on purpose: it is the one
 * piece of upstream behaviour this package reimplements rather than calls, so it
 * is the one piece that needs pinning. The expected values below are computed
 * from the geometry by hand, not read off this implementation.
 */

import { isClosed, outline } from '../outline';
import type { Shape } from '../types';

type Listener = (event: { jobId: string; phase: string; fraction: number }) => void;

/** A flat wire record with everything zeroed, the way native builds one. */
function wire(overrides: Record<string, unknown> = {}) {
  return {
    kind: null as string | null,
    points: [] as number[],
    semiMajor: 0,
    semiMinor: 0,
    outerRadius: 0,
    innerRadius: 0,
    rotation: 0,
    pointCount: 0,
    processingSec: 0.004,
    modelRevision: 'v0.3.0',
    ...overrides,
  };
}

function fakeNative(overrides: Record<string, unknown> = {}) {
  const listeners: Listener[] = [];
  const model = {
    isDownloaded: jest.fn(() => true),
    takeRecognition: jest.fn(() =>
      wire({ kind: 'rectangle', points: [0, 0, 10, 0, 10, 6, 0, 6] })
    ),
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
      modelRevision: 'v0.3.0',
      modelRepo: 'desert-ant-labs/shapes',
      defaultMinimumConfidence: 0,
      createModel: jest.fn(() => model),
      load: jest.fn(async () => undefined),
      recognize: jest.fn(async () => undefined),
      ...overrides,
    },
  };
}

function load(native: unknown) {
  let mod!: typeof import('../Shapes');
  jest.isolateModules(() => {
    jest.doMock('../native', () => ({ __esModule: true, default: native }));
    mod = require('../Shapes');
  });
  return { Shapes: mod.Shapes };
}

/** A stroke. Its shape does not matter: the native module is a spy. */
const STROKE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
  { x: 0, y: 0 },
];

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('without a native module (a web build, or one never prebuilt)', () => {
  it('reports unsupported with a reason instead of throwing on import', () => {
    const { Shapes } = load(null);
    expect(Shapes.isSupported).toBe(false);
    expect(Shapes.unsupportedReason).toMatch(/not available in this build/);
    expect(Shapes.nativeCoreVersion).toBeNull();
    expect(Shapes.modelRevision).toBeNull();
    expect(Shapes.modelRepo).toBeNull();
  });

  it('still answers the questions a UI asks while rendering', () => {
    const { Shapes } = load(null);
    expect(Shapes.defaultMinimumConfidence).toBe(0);
    expect(Shapes.kinds).toEqual(['line', 'rectangle', 'triangle', 'ellipse', 'star']);
  });

  it('hands out a copy of the kinds, so a caller cannot edit the list', () => {
    const { Shapes } = load(null);
    Shapes.kinds.push('hexagon' as never);
    expect(Shapes.kinds).toHaveLength(5);
  });

  it('throws ERR_UNSUPPORTED_PLATFORM from every entry point', async () => {
    const { Shapes } = load(null);
    expect(() => Shapes.create()).toThrow(
      expect.objectContaining({ code: 'ERR_UNSUPPORTED_PLATFORM', model: 'shapes' })
    );
    await expect(Shapes.load()).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PLATFORM' });
  });
});

describe('on a device whose ABI has no LiteRT build', () => {
  it('prefers the native reason, which names the ABIs the device reported', () => {
    const { Shapes } = load(
      fakeNative({
        isSupported: false,
        unsupportedReason:
          'Shapes ships arm64-v8a and x86_64 only; this device reports armeabi-v7a',
      }).module
    );
    expect(Shapes.isSupported).toBe(false);
    expect(Shapes.unsupportedReason).toMatch(/armeabi-v7a/);
  });
});

describe('reading the binary rather than duplicating it', () => {
  it('reports the revision and repo the linked module has', () => {
    const { Shapes } = load(fakeNative({ modelRevision: 'v0.9.9' }).module);
    expect(Shapes.modelRevision).toBe('v0.9.9');
    expect(Shapes.modelRepo).toBe('desert-ant-labs/shapes');
  });

  it('reports the confidence floor the module uses', () => {
    const { Shapes } = load(fakeNative({ defaultMinimumConfidence: 0.4 }).module);
    expect(Shapes.defaultMinimumConfidence).toBe(0.4);
  });

  it('falls back when the module reports a value that cannot be right', () => {
    const { Shapes } = load(fakeNative({ defaultMinimumConfidence: 4 }).module);
    expect(Shapes.defaultMinimumConfidence).toBe(0);
  });
});

describe('recognize', () => {
  it('runs the work, then reads the result back synchronously', async () => {
    // The split is a workaround for a real crash, so it is worth pinning: the
    // async half must return nothing and the record must come back off the
    // synchronous member. A refactor that "simplifies" this into one async call
    // reintroduces a segfault -- see ios/ShapesModel.swift.
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    const result = await shapes.recognize(STROKE);
    expect(native.module.recognize).toHaveBeenCalledWith(
      native.model,
      [0, 0, 10, 0, 10, 6, 0, 6, 0, 0],
      { minimumConfidence: 0 },
      expect.any(String)
    );
    expect(native.model.takeRecognition).toHaveBeenCalledWith(
      native.module.recognize.mock.calls[0]![3]
    );
    expect(result.shape).toEqual({
      kind: 'rectangle',
      corners: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 6 },
        { x: 0, y: 6 },
      ],
    });
    expect(result.processingSec).toBe(0.004);
    expect(result.modelRevision).toBe('v0.3.0');
  });

  it('flattens the stroke into the pairs the wire wants', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await shapes.recognize([
      { x: 1.5, y: -2 },
      { x: 3, y: 4 },
    ]);
    expect(native.module.recognize.mock.calls[0]![1]).toEqual([1.5, -2, 3, 4]);
  });

  it('takes its own job, so two concurrent calls cannot swap answers', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await Promise.all([shapes.recognize(STROKE), shapes.recognize(STROKE)]);
    const first = native.module.recognize.mock.calls[0]![3];
    const second = native.module.recognize.mock.calls[1]![3];
    expect(first).not.toBe(second);
    expect(native.model.takeRecognition.mock.calls.map((c) => c[0])).toEqual([first, second]);
  });

  it('forwards only the progress belonging to its own call', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    const seen: number[] = [];
    native.module.recognize.mockImplementationOnce(async () => {
      native.listeners.forEach((l) =>
        l({ jobId: 'shapes-99', phase: 'loadingModel', fraction: 0.1 })
      );
      native.listeners.forEach((l) =>
        l({ jobId: 'shapes-2', phase: 'loadingModel', fraction: 0.5 })
      );
    });
    await shapes.recognize(STROKE, { onProgress: (e) => seen.push(e.fraction) });
    expect(seen).toEqual([0.5]);
  });

  it('defaults the confidence to what the module reports', async () => {
    const native = fakeNative({ defaultMinimumConfidence: 0.7 });
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await shapes.recognize(STROKE);
    expect(native.module.recognize.mock.calls[0]![2]).toEqual({ minimumConfidence: 0.7 });
  });

  // Upstream clamps an out-of-range confidence into 0...1 and a non-finite one to
  // 0. `95` meaning "95%" silently becoming 1.0 is a recognizer that rejects
  // every stroke and says nothing about why, so this refuses instead.
  it('rejects a confidence that is not a probability rather than clamping it', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    for (const bad of [-0.1, 1.1, 95, NaN, Infinity, '0.5' as never]) {
      await expect(shapes.recognize(STROKE, { minimumConfidence: bad })).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
        model: 'shapes',
      });
    }
    expect(native.module.recognize).not.toHaveBeenCalled();
  });

  it('accepts the bounds themselves', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await shapes.recognize(STROKE, { minimumConfidence: 0 });
    await shapes.recognize(STROKE, { minimumConfidence: 1 });
    expect(
      native.module.recognize.mock.calls.map(
        (c) => (c[2] as { minimumConfidence: number }).minimumConfidence
      )
    ).toEqual([0, 1]);
  });

  // The refusal that is this model's own. Upstream's preprocessor does not reject
  // a NaN coordinate: its duplicate test is `abs(dx) > epsilon`, false for NaN,
  // so the point is dropped rather than caught and whatever survives is
  // classified anyway -- a confident shape made of nothing.
  it('rejects a coordinate that is not a finite number', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    const bad = [
      [{ x: 0, y: 0 }, { x: NaN, y: 1 }],
      [{ x: 0, y: 0 }, { x: 1, y: Infinity }],
      [{ x: 0, y: 0 }, { x: -Infinity, y: 1 }],
      [{ x: 0, y: 0 }, { x: '3' as never, y: 1 }],
      [{ x: 0, y: 0 }, { y: 1 } as never],
      [{ x: 0, y: 0 }, null as never],
    ];
    for (const stroke of bad) {
      await expect(shapes.recognize(stroke as never)).rejects.toMatchObject({
        code: 'ERR_INVALID_ARGUMENT',
        model: 'shapes',
      });
    }
    expect(native.module.recognize).not.toHaveBeenCalled();
  });

  it('names the offending point, so a long stroke is debuggable', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await expect(
      shapes.recognize([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: NaN }])
    ).rejects.toMatchObject({ message: expect.stringContaining('point 2') });
  });

  it('rejects something that is not an array of points at all', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await expect(shapes.recognize(undefined as never)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    await expect(shapes.recognize('circle' as never)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARGUMENT',
    });
    expect(native.module.recognize).not.toHaveBeenCalled();
  });

  // A short stroke is not an error on either upstream SDK, so it is not one here:
  // the native half answers it with "no shape" without loading the model.
  it('sends an empty or one-point stroke through rather than refusing it', async () => {
    const native = fakeNative();
    native.model.takeRecognition.mockReturnValue(wire({ processingSec: 0 }));
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await expect(shapes.recognize([])).resolves.toMatchObject({ shape: null });
    await expect(shapes.recognize([{ x: 1, y: 2 }])).resolves.toMatchObject({ shape: null });
    expect(native.module.recognize).toHaveBeenCalledTimes(2);
    expect(native.module.recognize.mock.calls[0]![1]).toEqual([]);
  });
});

describe('narrowing the flat wire record into the union', () => {
  async function recognized(record: ReturnType<typeof wire>) {
    const native = fakeNative();
    native.model.takeRecognition.mockReturnValue(record);
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    return (await shapes.recognize(STROKE)).shape;
  }

  it('a rejected stroke is null, which is a result rather than a failure', async () => {
    expect(await recognized(wire())).toBeNull();
  });

  it('line', async () => {
    expect(await recognized(wire({ kind: 'line', points: [1, 2, 3, 4] }))).toEqual({
      kind: 'line',
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
    });
  });

  it('triangle', async () => {
    expect(await recognized(wire({ kind: 'triangle', points: [0, 0, 4, 0, 2, 3] }))).toEqual({
      kind: 'triangle',
      vertices: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 2, y: 3 },
      ],
    });
  });

  it('ellipse, reading only the fields its kind names', async () => {
    expect(
      await recognized(
        wire({
          kind: 'ellipse',
          points: [5, 5],
          semiMajor: 4,
          semiMinor: 2,
          rotation: 0.5,
          // Belongs to a star. Present on the wire, never read.
          outerRadius: 99,
          pointCount: 7,
        })
      )
    ).toEqual({
      kind: 'ellipse',
      center: { x: 5, y: 5 },
      semiMajor: 4,
      semiMinor: 2,
      rotation: 0.5,
    });
  });

  it('star', async () => {
    expect(
      await recognized(
        wire({
          kind: 'star',
          points: [10, 10],
          outerRadius: 8,
          innerRadius: 3,
          rotation: 0.25,
          pointCount: 6,
          semiMajor: 99,
        })
      )
    ).toEqual({
      kind: 'star',
      center: { x: 10, y: 10 },
      outerRadius: 8,
      innerRadius: 3,
      rotation: 0.25,
      pointCount: 6,
    });
  });

  // `null` already means "the model rejected this stroke". Reusing it for "a
  // class this SDK does not know" would collapse two opposite answers into one,
  // which is what the Kotlin SDK's own FFI decoder does and what this refuses to.
  it('refuses a kind it does not know rather than reporting no shape', async () => {
    await expect(recognized(wire({ kind: 'hexagon', points: [0, 0] }))).rejects.toMatchObject({
      code: 'ERR_INFERENCE_FAILED',
      model: 'shapes',
      message: expect.stringContaining('hexagon'),
    });
  });

  it('refuses a payload that cannot be the kind it claims', async () => {
    await expect(
      recognized(wire({ kind: 'rectangle', points: [0, 0, 1, 1] }))
    ).rejects.toMatchObject({ code: 'ERR_INFERENCE_FAILED' });
  });
});

/**
 * The port. Every expected value here is derived from the geometry rather than
 * from running this code -- which is the only thing that makes the test worth
 * having, since the implementation is the thing under suspicion.
 */
describe('outline', () => {
  it('a line is its two points, and is the only kind drawn open', () => {
    const line: Shape = { kind: 'line', from: { x: 0, y: 0 }, to: { x: 4, y: 3 } };
    expect(outline(line)).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 3 },
    ]);
    expect(isClosed(line)).toBe(false);
  });

  it('a rectangle and a triangle are their own points, closed', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 0, y: 2 },
    ];
    const rectangle: Shape = { kind: 'rectangle', corners };
    expect(outline(rectangle)).toEqual(corners);
    expect(isClosed(rectangle)).toBe(true);

    const vertices = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 3 },
    ];
    expect(outline({ kind: 'triangle', vertices })).toEqual(vertices);
  });

  it('hands back a copy, so a renderer cannot mutate the shape it was given', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const drawn = outline({ kind: 'rectangle', corners });
    drawn.pop();
    expect(corners).toHaveLength(4);
  });

  // An unrotated ellipse sampled at four points is its four axis extremes, and
  // those are arithmetic anyone can check: center +/- semiMajor in x, center +/-
  // semiMinor in y, starting at the +x extreme and going counter-clockwise in
  // math orientation.
  it('samples an unrotated ellipse at its axis extremes', () => {
    const points = outline(
      { kind: 'ellipse', center: { x: 10, y: 20 }, semiMajor: 5, semiMinor: 3, rotation: 0 },
      4
    );
    expect(points).toHaveLength(4);
    const expected = [
      { x: 15, y: 20 },
      { x: 10, y: 23 },
      { x: 5, y: 20 },
      { x: 10, y: 17 },
    ];
    points.forEach((point, i) => {
      expect(point.x).toBeCloseTo(expected[i]!.x, 10);
      expect(point.y).toBeCloseTo(expected[i]!.y, 10);
    });
  });

  // A quarter turn sends the major axis onto +y and the minor onto -x.
  it('rotates the ellipse into the canvas frame', () => {
    const points = outline(
      {
        kind: 'ellipse',
        center: { x: 0, y: 0 },
        semiMajor: 2,
        semiMinor: 1,
        rotation: Math.PI / 2,
      },
      4
    );
    const expected = [
      { x: 0, y: 2 },
      { x: -1, y: 0 },
      { x: 0, y: -2 },
      { x: 1, y: 0 },
    ];
    points.forEach((point, i) => {
      expect(point.x).toBeCloseTo(expected[i]!.x, 10);
      expect(point.y).toBeCloseTo(expected[i]!.y, 10);
    });
  });

  // The snap a caller sees most often: equal axes, so every sample is exactly one
  // radius from the center however many samples there are.
  it('a circle stays a circle at every sample count', () => {
    for (const samples of [3, 12, 96]) {
      const points = outline(
        { kind: 'ellipse', center: { x: -4, y: 7 }, semiMajor: 6, semiMinor: 6, rotation: 1.2 },
        samples
      );
      expect(points).toHaveLength(samples);
      for (const point of points) {
        expect(Math.hypot(point.x + 4, point.y - 7)).toBeCloseTo(6, 10);
      }
    }
  });

  it('defaults an ellipse to upstream 96 samples', () => {
    expect(
      outline({
        kind: 'ellipse',
        center: { x: 0, y: 0 },
        semiMajor: 1,
        semiMinor: 1,
        rotation: 0,
      })
    ).toHaveLength(96);
  });

  it('a star alternates the two radii across twice its point count', () => {
    const points = outline({
      kind: 'star',
      center: { x: 0, y: 0 },
      outerRadius: 10,
      innerRadius: 4,
      rotation: 0,
      pointCount: 5,
    });
    expect(points).toHaveLength(10);
    points.forEach((point, i) => {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(i % 2 === 0 ? 10 : 4, 10);
    });
    // The first outer point is a quarter turn back from +x: directly above the
    // center in a y-down canvas.
    expect(points[0]!.x).toBeCloseTo(0, 10);
    expect(points[0]!.y).toBeCloseTo(-10, 10);
    // And the vertices are evenly spaced by PI / pointCount.
    expect(points[1]!.x).toBeCloseTo(4 * Math.cos(-Math.PI / 2 + Math.PI / 5), 10);
    expect(points[1]!.y).toBeCloseTo(4 * Math.sin(-Math.PI / 2 + Math.PI / 5), 10);
  });

  it('respects a star point count that is not five', () => {
    expect(
      outline({
        kind: 'star',
        center: { x: 0, y: 0 },
        outerRadius: 1,
        innerRadius: 0.5,
        rotation: 0,
        pointCount: 6,
      })
    ).toHaveLength(12);
  });

  it('ignores the sample count for every kind but the ellipse', () => {
    expect(
      outline({ kind: 'line', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, 500)
    ).toHaveLength(2);
    expect(
      outline(
        {
          kind: 'star',
          center: { x: 0, y: 0 },
          outerRadius: 1,
          innerRadius: 0.5,
          rotation: 0,
          pointCount: 5,
        },
        500
      )
    ).toHaveLength(10);
  });

  // Upstream divides by the sample count, so 0 hands back NaN coordinates and 1
  // hands back a single point that draws nothing. Refused rather than reproduced.
  it('refuses a sample count that would produce NaN or nothing', () => {
    const ellipse: Shape = {
      kind: 'ellipse',
      center: { x: 0, y: 0 },
      semiMajor: 1,
      semiMinor: 1,
      rotation: 0,
    };
    for (const bad of [0, 1, 2, -4, 2.5, NaN, Infinity, '96' as never]) {
      expect(() => outline(ellipse, bad)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT', model: 'shapes' })
      );
    }
  });

  it('refuses something that is not a shape', () => {
    expect(() => outline(null as never)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
    expect(() => outline({ kind: 'hexagon' } as never)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARGUMENT' })
    );
  });

  it('needs no model, so it answers where the native module is absent', () => {
    // Imported at the top level from '../outline' with no native module mocked
    // in at all, which is the point: this call is pure.
    expect(outline({ kind: 'line', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } })).toHaveLength(2);
  });
});

describe('lifecycle', () => {
  it('releases the native model once, however many times it is asked', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    shapes.release();
    shapes.release();
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('throws ERR_RELEASED from every entry point afterwards', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    shapes.release();
    expect(() => shapes.isDownloaded()).toThrow(expect.objectContaining({ code: 'ERR_RELEASED' }));
    await expect(shapes.recognize(STROKE)).rejects.toMatchObject({ code: 'ERR_RELEASED' });
    await expect(shapes.warm()).rejects.toMatchObject({ code: 'ERR_RELEASED' });
  });

  it('releases the model when warming it fails, rather than leaking a handle', async () => {
    const native = fakeNative({
      load: jest.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ERR_MODEL_UNAVAILABLE' });
      }),
    });
    const { Shapes } = load(native.module);
    await expect(Shapes.load()).rejects.toMatchObject({ code: 'ERR_MODEL_UNAVAILABLE' });
    expect(native.model.release).toHaveBeenCalledTimes(1);
  });

  it('warm and download are the same call, because upstream fuses them', async () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = Shapes.create();
    await shapes.warm();
    await shapes.download();
    expect(native.module.load).toHaveBeenCalledTimes(2);
  });

  it('creates without touching the network, so isDownloaded can be asked cheaply', () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    const shapes = Shapes.create();
    expect(shapes.isDownloaded()).toBe(true);
    expect(native.module.load).not.toHaveBeenCalled();
    expect(native.module.createModel).toHaveBeenCalledWith({ directory: undefined });
  });

  it('passes a directory through to the native model', () => {
    const native = fakeNative();
    const { Shapes } = load(native.module);
    Shapes.create({ directory: '/tmp/shapes' });
    expect(native.module.createModel).toHaveBeenCalledWith({ directory: '/tmp/shapes' });
  });

  it('wraps an uncoded native failure as ERR_INFERENCE_FAILED with the cause kept', async () => {
    const boom = new Error('something in Core ML');
    const native = fakeNative({
      recognize: jest.fn(async () => {
        throw boom;
      }),
    });
    const { Shapes } = load(native.module);
    const shapes = await Shapes.load();
    await expect(shapes.recognize(STROKE)).rejects.toMatchObject({
      code: 'ERR_INFERENCE_FAILED',
      model: 'shapes',
      cause: boom,
    });
  });
});
