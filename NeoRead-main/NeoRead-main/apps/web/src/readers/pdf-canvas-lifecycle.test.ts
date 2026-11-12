// @vitest-environment jsdom
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

// Exercise the installed PDF.js lifecycle, including our pinned dependency
// patch. These internal classes are not exported; extract their actual code
// rather than reproducing the swap/cancellation algorithm in a mock.
const require = createRequire(import.meta.url);
const source = readFileSync(
  require.resolve("pdfjs-dist/web/pdf_viewer.mjs"),
  "utf8",
);
const baseSource = source.slice(
  source.indexOf("class BasePDFPageView extends"),
  source.indexOf(";// ./web/draw_layer_builder.js"),
);
class Cancelled extends Error {}
const Base = new Function(
  "RenderableView",
  "FeatureTest",
  "RenderingStates",
  "RenderingCancelledException",
  `${baseSource}; return BasePDFPageView;`,
)(
  class {},
  { isBackdropFilterSupported: false },
  { INITIAL: 0, RUNNING: 1, PAUSED: 2, FINISHED: 3 },
  Cancelled,
);
const cancelStart = source.indexOf(
  "const resultPromise = this._drawCanvas(this._getRenderingContext(canvas,",
);
const cancelBody = source.slice(
  source.indexOf("() => {", cancelStart) + 7,
  source.indexOf("}, renderTask =>", cancelStart),
);
const cancellation = new Function(
  "canvas",
  "prevCanvas",
  `return function () { ${cancelBody} };`,
);

function setup() {
  const wrapper = document.createElement("div");
  const old = document.createElement("canvas");
  old.width = 160;
  old.height = 100;
  wrapper.append(old);
  const view = new Base({
    pageColors: {
      foreground: "#dcd7d2",
      background: "#2f2c2f",
      mapColor: (c: string) => c,
    },
  });
  view.div = wrapper;
  view.canvas = old;
  return { view, wrapper, old };
}
function start(view: InstanceType<typeof Base>, wrapper: HTMLElement) {
  const { canvas, prevCanvas } = view._createCanvas((next: HTMLCanvasElement) =>
    wrapper.append(next),
  );
  let resolve!: () => void, reject!: (error: Error) => void;
  const task = {
    promise: new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    }),
    onContinue: undefined as ((cont: () => void) => void) | undefined,
    onError: undefined as ((e: Error) => void) | undefined,
    cancel: vi.fn(),
  };
  view.pdfPage = { render: () => task };
  const finished = vi.fn();
  const done = view._drawCanvas(
    {},
    cancellation(canvas, prevCanvas).bind(view),
    finished,
  );
  return { canvas, task, resolve, reject, done, finished };
}

it.each(["completion", "failure"])(
  "ignores a superseded task's queued %s while a new theme is rendering",
  async (outcome) => {
    const { view, wrapper, old } = setup();
    const previous = start(view, wrapper);
    // A settled render promise can still have a queued continuation when the
    // viewer cancels that task and starts a replacement in the same turn.
    if (outcome === "completion") previous.resolve();
    else previous.reject(new Error("obsolete render failure"));
    previous.task.onError?.(new Cancelled());
    view.pageColors = { ...view.pageColors, background: "#000000" };
    const replacement = start(view, wrapper);
    view.renderingState = 1;
    await previous.done;
    expect(previous.finished).not.toHaveBeenCalled();
    expect(wrapper.firstChild).toBe(old);
    expect(old.width).toBe(160);
    expect(view.canvas).toBe(replacement.canvas);
    expect(view.renderTask).toBe(replacement.task);
    expect(view.renderingState).toBe(1);
    replacement.resolve();
    await replacement.done;
    expect(replacement.finished).toHaveBeenCalledOnce();
    expect(wrapper.firstChild).toBe(replacement.canvas);
  },
);

it("keeps the last completed frame through partial drawing and swaps only on completion", async () => {
  const { view, wrapper, old } = setup();
  const render = start(view, wrapper);
  render.task.onContinue?.(vi.fn());
  expect(wrapper.children).toHaveLength(1);
  expect(wrapper.firstChild).toBe(old);
  expect(old.width).toBe(160);
  render.resolve();
  await render.done;
  expect(wrapper.children).toHaveLength(1);
  expect(wrapper.firstChild).toBe(render.canvas);
  expect(old.width).toBe(0);
});

it("cancellation preserves the previous frame for the next render instead of clearing it", async () => {
  const { view, wrapper, old } = setup();
  const render = start(view, wrapper);
  const error = new Cancelled();
  render.task.onError?.(error);
  render.reject(error);
  await render.done;
  expect(wrapper.firstChild).toBe(old);
  expect(old.width).toBe(160);
  expect(view.canvas).toBe(old);
  expect(render.canvas.width).toBe(0);
  const retry = start(view, wrapper);
  expect(wrapper.firstChild).toBe(old);
  retry.resolve();
  await retry.done;
  expect(wrapper.children).toHaveLength(1);
  expect(wrapper.firstChild).toBe(retry.canvas);
});

it("keeps the completed frame when its replacement fails", async () => {
  const { view, wrapper, old } = setup();
  const render = start(view, wrapper);
  const result = expect(render.done).rejects.toThrow("render failure");
  render.reject(new Error("render failure"));
  await result;
  expect(wrapper.firstChild).toBe(old);
  expect(view.canvas).toBe(old);
  expect(old.width).toBe(160);
});
