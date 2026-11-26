import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const version = "0.19.0";
const source = "3fce95465cdea1edc8456dbd1c6691d1c8dc1f2e";
const moduleRoot = resolve(import.meta.dir, "../modules/boop-marmot");
const sdk = join(moduleRoot, "sdk");
const patch = join(moduleRoot, `mdk-${version}.patch`);
const revision = createHash("sha256")
  .update(await readFile(patch))
  .digest("hex");
const provenance = `${source}\n${revision}\n`;
const platform = process.argv[2];
if (platform !== "android" && platform !== "ios")
  throw new Error(
    "Usage: bun scripts/fetch-marmotkit.ts android|ios [Android ABIs]",
  );
const swiftSupport =
  platform === "ios"
    ? await readFile(
        join(moduleRoot, "swift-support", "DeviceSubscriptions.swift"),
        "utf8",
      )
    : "";
const platformProvenance = swiftSupport
  ? provenance + createHash("sha256").update(swiftSupport).digest("hex") + "\n"
  : provenance;

const androidTargets = new Map([
  ["arm64-v8a", "aarch64-linux-android"],
  ["armeabi-v7a", "armv7-linux-androideabi"],
  ["x86", "i686-linux-android"],
  ["x86_64", "x86_64-linux-android"],
]);
const abis =
  platform === "android"
    ? (process.argv[3]?.split(",").map((abi) => abi.trim()) ?? [
        ...androidTargets.keys(),
      ])
    : [];
if (abis.some((abi) => !androidTargets.has(abi)))
  throw new Error("Unknown Android ABI");

const tree = join(sdk, `mdk-${source.slice(0, 12)}-${revision.slice(0, 12)}`);
const dest = join(
  sdk,
  `marmotkit-${platform}-${version}-boop-${revision.slice(0, 12)}`,
);
const stamp = join(dest, "source.txt");
const abiStamp = (abi: string) => join(dest, `source-${abi}.txt`);
const abiLibrary = (abi: string) =>
  join(dest, "jniLibs", abi, "libmarmot_uniffi.so");
const kotlinBinding = join(
  dest,
  "kotlin",
  "dev",
  "ipf",
  "marmotkit",
  "marmot_uniffi.kt",
);
async function exists(path: string) {
  return Bun.file(path).exists();
}
async function matches(path: string) {
  return (await exists(path)) && (await readFile(path, "utf8")) === provenance;
}
async function androidAbiReady(abi: string) {
  return (await exists(abiLibrary(abi))) && (await matches(abiStamp(abi)));
}
async function built() {
  if (
    !(await exists(stamp)) ||
    (await readFile(stamp, "utf8")) !== platformProvenance
  )
    return false;
  if (platform === "ios")
    return (
      await Promise.all([
        exists(join(dest, "MarmotKit.xcframework", "Info.plist")),
        exists(join(dest, "MarmotKit.swift")),
        exists(join(dest, "PrivacyInfo.xcprivacy")),
      ])
    ).every(Boolean);
  return (
    (await exists(kotlinBinding)) &&
    (await Promise.all(abis.map(androidAbiReady))).every(Boolean)
  );
}
if (await built()) {
  console.info(dest);
  process.exit(0);
}

const run = (cmd: string[], cwd: string, env = process.env) => {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) throw new Error(`${cmd[0]} failed (${result.exitCode})`);
};
const isWindows = process.platform === "win32";
if (platform === "ios" && process.platform !== "darwin")
  throw new Error("MarmotKit for iOS requires macOS and Xcode");

await mkdir(tree, { recursive: true });
const sourceStamp = join(tree, ".boop-source");
if (!(await matches(sourceStamp))) {
  run(["git", "init", "--quiet"], tree);
  run(
    [
      "git",
      "fetch",
      "--depth=1",
      "https://github.com/marmot-protocol/mdk.git",
      source,
    ],
    tree,
  );
  const fetched = Bun.spawnSync(["git", "rev-parse", "FETCH_HEAD"], {
    cwd: tree,
  });
  if (!fetched.success || fetched.stdout.toString().trim() !== source)
    throw new Error("MarmotKit source commit mismatch");
  run(
    [
      "git",
      "-c",
      "core.autocrlf=false",
      "checkout",
      "--detach",
      "--force",
      source,
    ],
    tree,
  );
  run(["git", "apply", patch], tree);
  await writeFile(sourceStamp, provenance);
}
const crate = join(tree, "crates", "marmot-uniffi");
const bash = Bun.which("bash");
if (!bash && !isWindows) throw new Error("MarmotKit requires Bash");
const provisionedOdin = join(sdk, "odin-dev-2026-10", "odin");
const odin =
  process.env.ODIN ||
  Bun.which("odin") ||
  (!isWindows && (await exists(provisionedOdin)) ? provisionedOdin : undefined);
if (!odin && isWindows)
  throw new Error("Set ODIN to the pinned Odin dev-2026-10 (84bc3fc) compiler");
if (!odin)
  run(
    [bash ?? "bash", "scripts/install-odin.sh", join(sdk, "odin-dev-2026-10")],
    tree,
  );
const targetDir =
  isWindows && process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR)
    : join(tree, "target");
const env = {
  ...process.env,
  ODIN: odin || provisionedOdin,
  // Upstream places its outputs under the checkout's target directory.
  CARGO_TARGET_DIR: targetDir,
};
await mkdir(dest, { recursive: true });
if (platform === "ios") {
  run(["bash", "crates/marmot-uniffi/xcframework.sh"], tree, env);
  for (const name of [
    "MarmotKit.xcframework",
    "MarmotKit.swift",
    "PrivacyInfo.xcprivacy",
  ])
    await cp(join(crate, "output", name), join(dest, name), {
      recursive: true,
    });
  await appendFile(join(dest, "MarmotKit.swift"), "\n" + swiftSupport);
} else if (!isWindows) {
  run(
    [
      "rustup",
      "target",
      "add",
      ...abis.map((abi) => androidTargets.get(abi) ?? abi),
    ],
    tree,
    env,
  );
  run(["bash", "crates/marmot-uniffi/kotlin-bindings.sh"], tree, {
    ...env,
    ANDROID_ABIS: abis.join(" "),
  });
  const output = join(crate, "output", "android");
  await cp(join(output, "kotlin"), join(dest, "kotlin"), { recursive: true });
  await cp(join(output, "jniLibs"), join(dest, "jniLibs"), { recursive: true });
} else {
  let ndk = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT;
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!ndk && androidHome) {
    const root = join(androidHome, "ndk");
    const versions = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) ndk = join(root, versions[0]);
  }
  if (!ndk)
    throw new Error("Set ANDROID_NDK_HOME to an Android NDK installation");
  ndk = ndk.replaceAll("\\", "/");
  const toolchain = `${ndk}/toolchains/llvm/prebuilt/windows-x86_64`;
  const clang = `${toolchain}/bin/clang.exe`;
  if (!(await exists(clang)))
    throw new Error("Android NDK Windows clang is missing");
  const make = Bun.which("make");
  const perl = Bun.which("perl");
  if (!make || !perl)
    throw new Error(
      "Add native Windows Perl and MSYS2 make to PATH for the Android SQLCipher build",
    );
  // Host OpenSSL needs native Perl. The Android build uses MSYS2 make and
  // prefers the Perl from the same installation.
  const msysPerl = join(dirname(make), "perl.exe");
  const androidPerl =
    process.env.OPENSSL_SRC_PERL ??
    ((await exists(msysPerl)) ? msysPerl : perl);
  const kotlin = join(dest, "kotlin");
  if (!(await matches(stamp)) || !(await exists(kotlinBinding))) {
    await rm(stamp, { force: true });
    run(
      [
        "cargo",
        "build",
        "--locked",
        "--release",
        "-p",
        "marmot-uniffi",
        "--features",
        "cli",
      ],
      tree,
      env,
    );
    run(
      [
        join(targetDir, "release", "uniffi-bindgen.exe"),
        "generate",
        "--library",
        join(targetDir, "release", "marmot_uniffi.dll"),
        "--language",
        "kotlin",
        "--config",
        join(crate, "uniffi.toml"),
        "--no-format",
        "--out-dir",
        kotlin,
      ],
      tree,
      env,
    );
    await cp(join(crate, "kotlin-support"), kotlin, { recursive: true });
    await writeFile(stamp, provenance);
  }
  for (const abi of abis) {
    if (await androidAbiReady(abi)) continue;
    const target = androidTargets.get(abi) ?? abi;
    const targetKey = target.replaceAll("-", "_");
    const cargoKey = targetKey.toUpperCase();
    const clangTarget =
      (abi === "armeabi-v7a" ? "armv7a-linux-androideabi" : target) + "26";
    run(["rustup", "target", "add", target], tree, env);
    const alignment =
      abi === "arm64-v8a" || abi === "x86_64"
        ? [
            "--",
            "-C",
            "link-arg=-Wl,-z,max-page-size=16384",
            "-C",
            "link-arg=-Wl,-z,common-page-size=16384",
          ]
        : [];
    run(
      [
        "cargo",
        "rustc",
        "--release",
        "--locked",
        "-p",
        "marmot-uniffi",
        "--target",
        target,
        "--lib",
        ...alignment,
      ],
      tree,
      {
        ...env,
        ANDROID_NDK_HOME: ndk,
        ANDROID_NDK_ROOT: ndk,
        ODIN_ANDROID_NDK_TOOLCHAIN: toolchain,
        OPENSSL_SRC_PERL: androidPerl,
        [`CARGO_TARGET_${cargoKey}_LINKER`]: clang,
        [`CARGO_TARGET_${cargoKey}_RUSTFLAGS`]: `-C link-arg=--target=${clangTarget}`,
        [`CC_${targetKey}`]: clang,
        [`CFLAGS_${targetKey}`]: `--target=${clangTarget}`,
        [`AR_${targetKey}`]: `${toolchain}/bin/llvm-ar.exe`,
        [`RANLIB_${targetKey}`]: `${toolchain}/bin/llvm-ranlib.exe`,
        CARGO_PROFILE_RELEASE_STRIP: "symbols",
      },
    );
    const jni = join(dest, "jniLibs", abi);
    await mkdir(jni, { recursive: true });
    await rm(abiStamp(abi), { force: true });
    await cp(
      join(targetDir, target, "release", "libmarmot_uniffi.so"),
      join(jni, "libmarmot_uniffi.so"),
    );
    await writeFile(abiStamp(abi), provenance);
  }
}
for (const abi of abis) {
  if (!(await exists(abiLibrary(abi))))
    throw new Error(`MarmotKit build did not produce ${abi}`);
  await writeFile(abiStamp(abi), provenance);
}
await writeFile(stamp, platformProvenance);
console.info(dest);
