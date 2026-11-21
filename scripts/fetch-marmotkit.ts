import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const version = "0.18.0";
const source = "34646a577807f2b112ee031f3c164ec58aa18b64";
const sha256 = {
  android: "d757f5340ca8ea0b7384ebabb4d8fec5a55d64aa51c63c7443ffce15a5a53440",
  ios: "66b30594f50f4667fd80c95ec49d7c8b1405074b6c9e270bbb62952d3e549068",
};

const platform = process.argv[2];
if (platform !== "android" && platform !== "ios") {
  throw new Error("Usage: bun scripts/fetch-marmotkit.ts android|ios");
}

const release = `marmotkit-v${version}`;
const name = `marmotkit-${platform}-${version}`;
const output = join(import.meta.dir, "..", ".expo", "marmotkit");
const destination = join(output, name);
const manifest = z.object({ source_sha: z.literal(source) });
const installed = Bun.file(join(destination, "manifest.json"));
if (await installed.exists()) {
  manifest.parse(await installed.json());
  console.info(destination);
  process.exit(0);
}

await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(output, ".download-"));
try {
  const url = `https://github.com/marmot-protocol/mdk/releases/download/${release}/${name}.zip`;
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status})`);
  const archive = join(temporary, `${name}.zip`);
  const hash = createHash("sha256");
  const file = Bun.file(archive).writer();
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      await file.write(chunk);
    }
  } finally {
    await file.end();
  }
  if (hash.digest("hex") !== sha256[platform])
    throw new Error("MarmotKit archive checksum mismatch");

  const extract = Bun.spawnSync(["tar", "-xf", archive, "-C", temporary], {
    stderr: "inherit",
  });
  if (!extract.success) throw new Error("MarmotKit archive extraction failed");
  const extracted = join(temporary, name);
  manifest.parse(await Bun.file(join(extracted, "manifest.json")).json());
  try {
    await rename(extracted, destination);
  } catch (error) {
    if (!(await installed.exists())) throw error;
    manifest.parse(await installed.json());
  }
  console.info(destination);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
