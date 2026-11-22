import { expect, test } from "bun:test";
import { nativeUsage, storageBreakdown } from "../src/core/storage/usage";

test("storage counts Marmot attachment bytes once alongside other app files", () => {
  const snapshot = nativeUsage.parse({
    files: {
      marmot: 800,
      profileCache: 80,
      profileLocal: 20,
      linkPreviews: 30,
      database: 50,
      other: 20,
    },
    partial: false,
    freeBytes: 10000,
    traffic: { received: 0, sent: 2500 },
  });

  expect(storageBreakdown(snapshot.files, 300)).toEqual({
    total: 1000,
    categories: {
      downloads: 300,
      profileCache: 80,
      profileLocal: 20,
      linkPreviews: 30,
      marmot: 500,
      database: 50,
      other: 20,
    },
  });
  expect(snapshot.traffic).toEqual({ received: 0, sent: 2500 });
});

test("unknown attachments stay combined with chat data and differ from measured zero", () => {
  for (const report of [undefined, -1, 3.5, 81, Infinity]) {
    const { categories, total } = storageBreakdown({ marmot: 80 }, report);
    expect(total).toBe(80);
    expect(categories.downloads).toBeUndefined();
    expect(categories.marmot).toBe(80);
  }
  expect(storageBreakdown({ marmot: 80 }, 0).categories.downloads).toBe(0);
  expect(
    nativeUsage.safeParse({ files: { profileCache: -1 }, partial: false })
      .success,
  ).toBe(false);
});
