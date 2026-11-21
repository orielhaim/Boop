import { expect, test } from "bun:test";
import { join } from "node:path";

test("file processing matches the GCM vector and recovers a verified native upload receipt", async () => {
  const run = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../scripts/test-media-files.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [status, stderr] = await Promise.all([
    run.exited,
    new Response(run.stderr).text(),
  ]);
  if (status !== 0) throw new Error(stderr);
  const stdout = await new Response(run.stdout).text();
  expect(stdout).toContain("File AES-GCM vector");
  expect(stdout).toContain("receipt persisted before native acknowledgement");
});
