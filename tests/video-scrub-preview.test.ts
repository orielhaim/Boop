import { expect, test } from "bun:test";
import { createScrubPreview } from "../src/components/video/scrub-preview";

function previewFixture(release?: () => void) {
  const requests: { time: number; finish: (frame: string) => void }[] = [];
  const shown: string[] = [];
  const previews = createScrubPreview<string>(
    (time) => new Promise((finish) => requests.push({ time, finish })),
    (frame) => shown.push(frame),
    release,
  );
  return { previews, requests, shown };
}

test("the preview skips obsolete drag positions and decodes the latest exact time", async () => {
  const { previews, requests, shown } = previewFixture();
  previews.request(2.75);
  previews.request(5.1);
  previews.request(9.825);
  expect(requests.map(({ time }) => time)).toEqual([2.75]);

  requests[0]?.finish("old frame");
  await Promise.resolve();
  expect(shown).toEqual([]);
  expect(requests.map(({ time }) => time)).toEqual([2.75, 9.825]);

  requests[1]?.finish("selected frame");
  await Promise.resolve();
  expect(shown).toEqual(["selected frame"]);
});

test("releasing the timeline suppresses a late preview and clearing drops cached frames", async () => {
  const { previews, requests, shown } = previewFixture();
  previews.request(3.25);
  previews.stop();
  requests[0]?.finish("late frame");
  await Promise.resolve();
  expect(shown).toEqual([]);

  previews.clear();
  previews.request(3.25);
  expect(requests.map(({ time }) => time)).toEqual([3.25, 3.25]);
  requests[1]?.finish("new frame");
  await Promise.resolve();
  expect(shown).toEqual(["new frame"]);
});

test("a held position keeps the displayed frame until the matching decode finishes", async () => {
  const { previews, requests, shown } = previewFixture();
  previews.request(2);
  requests[0]?.finish("first frame");
  await Promise.resolve();

  previews.request(3);
  previews.request(4);
  await Bun.sleep(100);
  expect(shown).toEqual(["first frame"]);

  requests[1]?.finish("obsolete frame");
  await Promise.resolve();
  expect(shown).toEqual(["first frame"]);

  requests[2]?.finish("held frame");
  await Promise.resolve();
  expect(shown).toEqual(["first frame", "held frame"]);
});

test("only continued movement can publish a completed intermediate frame", async () => {
  const { previews, requests, shown } = previewFixture();
  previews.request(2);
  previews.request(3);
  requests[0]?.finish("intermediate frame");
  await Promise.resolve();
  expect(shown).toEqual([]);

  previews.request(4);
  expect(shown).toEqual(["intermediate frame"]);
  previews.stop();
});

test("a nearby scrub paints a cached frame immediately and keeps the decoder warm", async () => {
  let releases = 0;
  const { previews, requests, shown } = previewFixture(() => releases++);
  previews.request(12);
  requests[0]?.finish("cached frame");
  await Promise.resolve();

  previews.stop();
  expect(releases).toBe(0);
  previews.request(12.125);
  expect(shown).toEqual(["cached frame", "cached frame"]);
  expect(requests.map(({ time }) => time)).toEqual([12, 12.125]);

  requests[1]?.finish("matching frame");
  await Promise.resolve();
  expect(shown.at(-1)).toBe("matching frame");
  previews.clear();
  expect(releases).toBe(1);
});
