import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const targetDir = resolve(
  process.env.BOOP_SOCIAL_TARGET_DIR ?? join(root, "target"),
);
const staging = join(targetDir, "native-staging");
const windows = process.platform === "win32";
const executable = (name: string) => (windows ? `${name}.exe` : name);
const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: targetDir };
// ABI builds can use separate Cargo directories without rebuilding the host bindgen tool.
const hostTargetDir = resolve(
  process.env.BOOP_SOCIAL_HOST_TARGET_DIR ?? join(root, "target"),
);
const hostEnv = { ...env, CARGO_TARGET_DIR: hostTargetDir };
const kotlinPath = join(
  "kotlin",
  "app",
  "boop",
  "social",
  "ffi",
  "boop_social.kt",
);
const framework = "BoopSocialFFI";
const iosDeploymentTarget = "18.0";
const androidApi = "26";
const targets = new Map([
  ["x86", ["i686-linux-android", "i686-linux-android"]],
  ["x86_64", ["x86_64-linux-android", "x86_64-linux-android"]],
  ["arm64-v8a", ["aarch64-linux-android", "aarch64-linux-android"]],
  ["armeabi-v7a", ["armv7-linux-androideabi", "armv7a-linux-androideabi"]],
]);

function run(
  command: string[],
  options: { environment?: NodeJS.ProcessEnv; capture?: boolean } = {},
): string {
  const result = Bun.spawnSync(command, {
    cwd: root,
    env: options.environment ?? env,
    stdin: "ignore",
    stderr: "inherit",
    stdout: options.capture ? "pipe" : "inherit",
  });
  if (!result.success)
    throw new Error(`${command[0]} exited with ${result.exitCode}`);
  return result.stdout?.toString().trim() ?? "";
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function fingerprint(configuration: unknown) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      configuration,
      rustc: run(["rustc", "-vV"], { capture: true }),
      cargo: run(["cargo", "-V"], { capture: true }),
      bun: Bun.version,
      environment: Object.entries(env)
        .filter(([name]) =>
          /^(?:CARGO_(?:BUILD|PROFILE|TARGET)|RUSTFLAGS|RUSTUP_TOOLCHAIN$|RUSTC(?:_|$)|CC(?:_|$)|CFLAGS(?:_|$)|AR(?:_|$)|MAKEFLAGS$|OPENSSL_|IPHONEOS_DEPLOYMENT_TARGET$)/.test(
            name,
          ),
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    }),
  );
  const paths = ["Cargo.toml", "Cargo.lock", "uniffi.toml"];
  for (const file of ["build.rs", "rust-toolchain", "rust-toolchain.toml"]) {
    if (await Bun.file(join(root, file)).exists()) paths.push(file);
  }
  for (const directory of ["src", "scripts", "patches", ".cargo", "vendor"]) {
    const glob = new Bun.Glob(`${directory}/**/*`);
    for await (const path of glob.scan({
      cwd: root,
      dot: true,
      onlyFiles: true,
    })) {
      paths.push(path);
    }
  }
  for (const path of paths.sort()) {
    const bytes = await readFile(join(root, path));
    hash.update(JSON.stringify([path, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

type ArtifactStamps = Record<string, string>;
async function artifactStamps(
  path: string,
  artifacts: string[],
): Promise<ArtifactStamps> {
  const files = [];
  for (const artifact of artifacts) {
    const file = join(path, artifact);
    if ((await Bun.file(file).stat()).isDirectory()) {
      const tree = new Bun.Glob("**/*");
      for await (const child of tree.scan({
        cwd: file,
        dot: true,
        onlyFiles: true,
      })) {
        files.push(join(artifact, child));
      }
    } else {
      files.push(artifact);
    }
  }
  const hashes: ArtifactStamps = {};
  for (const file of files.sort()) {
    hashes[file.replaceAll("\\", "/")] = createHash("sha256")
      .update(await readFile(join(path, file)))
      .digest("hex");
  }
  return hashes;
}

async function isCurrent(path: string, input: string, files: string[]) {
  try {
    const stamp: unknown = await Bun.file(join(path, "provenance.json")).json();
    return (
      object(stamp) &&
      stamp.input === input &&
      JSON.stringify(stamp.artifacts) ===
        JSON.stringify(await artifactStamps(path, files))
    );
  } catch {
    return false;
  }
}

async function writeProvenance(path: string, input: string, files: string[]) {
  const artifacts = await artifactStamps(path, files);
  await writeFile(
    join(path, "provenance.json"),
    JSON.stringify({ input, artifacts }, null, 2) + "\n",
  );
}

async function generateBindings(
  library: string,
  language: "kotlin" | "swift",
  output: string,
) {
  await mkdir(output, { recursive: true });
  run(
    [
      "cargo",
      "run",
      "--locked",
      "--features",
      "bindgen",
      "--bin",
      "boop-social-bindgen",
      "--",
      "generate",
      "--library",
      library,
      "--language",
      language,
      "--out-dir",
      output,
      "--config",
      join(import.meta.dir, "uniffi-bindgen.toml"),
      "--no-format",
    ],
    { environment: hostEnv },
  );
}

async function ndkRoot() {
  const explicit = env.ANDROID_NDK_HOME ?? env.ANDROID_NDK_ROOT;
  if (explicit) return resolve(explicit);
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error("Set ANDROID_NDK_HOME or ANDROID_HOME");
  const directory = join(sdk, "ndk");
  if (env.BOOP_SOCIAL_NDK_VERSION)
    return join(directory, env.BOOP_SOCIAL_NDK_VERSION);
  const versions = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((first, second) =>
      second.localeCompare(first, "en", { numeric: true }),
    );
  if (!versions[0]) throw new Error("No installed Android NDK found");
  return join(directory, versions[0]);
}

function parseAbis(value?: string) {
  const names = value?.split(",").map((name) => name.trim()) ?? [
    ...targets.keys(),
  ];
  return [...new Set(names)].map((name) => {
    const entry = targets.get(name);
    if (!entry) throw new Error(`Unsupported Android ABI: ${name}`);
    const [rustTarget, clangTarget] = entry;
    if (!rustTarget || !clangTarget)
      throw new Error(`Invalid target mapping: ${name}`);
    return { name, rustTarget, clangTarget: clangTarget + androidApi };
  });
}

function sodiumArchive() {
  // Cargo resolves the crate archive using the checksum recorded in this SDK's lockfile.
  const metadata: unknown = JSON.parse(
    run(
      [
        "cargo",
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        "x86_64-pc-windows-msvc",
      ],
      { capture: true },
    ),
  );
  if (!object(metadata) || !Array.isArray(metadata.packages)) {
    throw new Error("Cargo metadata did not include dependency paths");
  }
  const sodium = metadata.packages.find(
    (pkg: unknown) => object(pkg) && pkg.name === "libsodium-sys-stable",
  );
  if (!object(sodium) || typeof sodium.manifest_path !== "string") {
    throw new Error("Cargo metadata did not include libsodium-sys-stable");
  }
  return join(dirname(sodium.manifest_path), "LATEST.tar.gz");
}

async function windowsSodium(
  abi: ReturnType<typeof parseAbis>[number],
  llvmBin: string,
  ndkProperties: string,
) {
  const make = Bun.which("make");
  const candidates = [
    env.BOOP_MSYS2_BIN,
    make ? dirname(make) : undefined,
    "C:/msys64/usr/bin",
  ];
  let msys: string | undefined;
  for (const path of candidates) {
    if (
      path &&
      (await Bun.file(join(path, "cygpath.exe")).exists()) &&
      (await Bun.file(join(path, "pkg-config.exe")).exists())
    ) {
      msys = resolve(path);
      break;
    }
  }
  if (!msys)
    throw new Error(
      "Install MSYS2 make, perl, pkgconf and diffutils. Set BOOP_MSYS2_BIN to its usr/bin directory.",
    );
  const archive = sodiumArchive();
  const buildScript = join(import.meta.dir, "build-sodium-msys2.sh");
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .update(await readFile(buildScript))
    .update(JSON.stringify([abi.clangTarget, ndkProperties]))
    .digest("hex");
  const work = join(staging, "sodium", abi.name, digest.slice(0, 20));
  const destination = join(work, "installed");
  const artifacts = [
    "include",
    "lib/libsodium.a",
    "lib/pkgconfig/libsodium.pc",
  ];
  if (!(await isCurrent(destination, digest, artifacts))) {
    run([
      join(msys, "bash.exe"),
      buildScript,
      archive,
      work,
      llvmBin,
      abi.rustTarget,
      abi.clangTarget,
      String(Math.min(8, availableParallelism())),
    ]);
    await writeProvenance(destination, digest, artifacts);
  }
  const perl = env.OPENSSL_SRC_PERL ?? join(msys, "perl.exe");
  if (!(await Bun.file(perl).exists()))
    throw new Error("MSYS2 Perl is required for Android SQLCipher on Windows");
  const pkgconf = join(msys, "pkg-config.exe");
  return {
    PATH: `${env.PATH ?? ""};${msys}`,
    OPENSSL_SRC_PERL: perl,
    // openssl-src cannot inherit Cargo's jobserver on a Windows host.
    MAKEFLAGS: env.MAKEFLAGS ?? `-j${Math.min(8, availableParallelism())}`,
    SODIUM_USE_PKG_CONFIG: "1",
    SODIUM_LIB_DIR: undefined,
    SODIUM_SHARED: undefined,
    PKG_CONFIG: pkgconf,
    PKG_CONFIG_ALLOW_CROSS: "1",
    PKG_CONFIG_ALL_STATIC: "1",
    PKG_CONFIG_LIBDIR: run(
      [join(msys, "cygpath.exe"), "-u", join(destination, "lib", "pkgconfig")],
      { capture: true },
    ),
    PKG_CONFIG_PATH: "",
  };
}

function requireSocialExports(symbols: string[]) {
  const ffi =
    /^(?:_)?(?:ffi_boop_social_|uniffi_boop_social_|UNIFFI_META_BOOP_SOCIAL_|UNIFFI_META_NAMESPACE_BOOP_SOCIAL$)/;
  if (
    !symbols.some((symbol) =>
      symbol.includes("uniffi_boop_social_fn_constructor_socialengine_new"),
    )
  ) {
    throw new Error("Social constructor missing from native exports");
  }
  const unexpected = symbols.filter((symbol) => !ffi.test(symbol));
  if (unexpected.length)
    throw new Error(`Unexpected Social export(s): ${unexpected.join(", ")}`);
}

function auditAndroid(library: string, llvmBin: string, require16K: boolean) {
  const readelf = join(llvmBin, executable("llvm-readelf"));
  const headers = run(
    [readelf, "--wide", "--program-headers", "--dynamic", library],
    { capture: true },
  );
  if (
    /NEEDED[^\n]*\[(?:libmarmot|libsqlite|libcrypto|libsodium)/.test(headers)
  ) {
    throw new Error(
      "Social unexpectedly links another SDK or unbundled crypto or storage",
    );
  }
  if (require16K) {
    const segments = headers
      .split("\n")
      .filter((line) => /^\s*LOAD\s/.test(line));
    if (
      !segments.length ||
      segments.some((line) => Number(line.trim().split(/\s+/).at(-1)) < 16384)
    ) {
      throw new Error("64-bit Social library has unaligned ELF load segments");
    }
  }
  const dynamicSymbols = run([readelf, "--wide", "--dyn-syms", library], {
    capture: true,
  });
  const exported = dynamicSymbols.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const symbol = fields[7];
    return (fields[4] === "GLOBAL" || fields[4] === "WEAK") &&
      (fields[5] === "DEFAULT" || fields[5] === "PROTECTED") &&
      fields[6] !== "UND" &&
      symbol
      ? [symbol]
      : [];
  });
  requireSocialExports(exported);
}

async function android(abiValue: string | undefined, output?: string) {
  const abis = parseAbis(abiValue);
  const dest = resolve(output ?? join(root, "native", "android"));
  const ndk = (await ndkRoot()).replaceAll("\\", "/");
  const ndkProperties = await readFile(join(ndk, "source.properties"), "utf8");
  const hostTag = windows
    ? "windows-x86_64"
    : process.platform === "darwin"
      ? "darwin-x86_64"
      : "linux-x86_64";
  const llvmBin = join(
    ndk,
    "toolchains",
    "llvm",
    "prebuilt",
    hostTag,
    "bin",
  ).replaceAll("\\", "/");
  // OpenSSL's Makefile runs under MSYS2 on Windows and needs forward slashes.
  const tool = (name: string) => `${llvmBin}/${executable(name)}`;
  const clang = tool("clang");
  if (!(await Bun.file(clang).exists()))
    throw new Error(`Missing NDK clang: ${clang}`);
  const input = await fingerprint({
    platform: "android",
    abis,
    ndk,
    ndkProperties,
  });
  const libraries = abis.map(({ name }) =>
    join("jniLibs", name, "libboop_social.so"),
  );
  const files = [kotlinPath, ...libraries];
  if (await isCurrent(dest, input, files)) {
    console.info(dest);
    return;
  }

  await mkdir(dest, { recursive: true });
  for (const [index, abi] of abis.entries()) {
    const library = libraries[index];
    if (!library) throw new Error("Android artifact mapping is incomplete");
    const abiInput = await fingerprint({
      platform: "android",
      abi,
      ndk,
      ndkProperties,
    });
    const abiDirectory = join(dest, "jniLibs", abi.name);
    const name = basename(library);
    if (await isCurrent(abiDirectory, abiInput, [name])) continue;
    const key = abi.rustTarget.replaceAll("-", "_");
    const nativeLibs = windows
      ? await windowsSodium(abi, llvmBin, ndkProperties)
      : {};
    const require16K = abi.name === "x86_64" || abi.name === "arm64-v8a";
    const rustflags = [
      "-C",
      `link-arg=--target=${abi.clangTarget}`,
      ...(require16K
        ? [
            "-C",
            "link-arg=-Wl,-z,max-page-size=16384",
            "-C",
            "link-arg=-Wl,-z,common-page-size=16384",
          ]
        : []),
    ].join(" ");
    run(
      [
        "cargo",
        "rustc",
        "--locked",
        "--release",
        "--target",
        abi.rustTarget,
        "--lib",
        "--",
        "-C",
        "link-arg=-Wl,--exclude-libs,ALL",
      ],
      {
        environment: {
          ...env,
          ...nativeLibs,
          ANDROID_NDK_HOME: ndk,
          ANDROID_NDK_ROOT: ndk,
          [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: clang,
          [`CARGO_TARGET_${key.toUpperCase()}_RUSTFLAGS`]: rustflags,
          [`CC_${key}`]: clang,
          [`CFLAGS_${key}`]: `--target=${abi.clangTarget}`,
          [`AR_${key}`]: tool("llvm-ar"),
          [`RANLIB_${key}`]: tool("llvm-ranlib"),
        },
      },
    );
    const binary = join(targetDir, abi.rustTarget, "release", name);
    auditAndroid(binary, llvmBin, require16K);
    await mkdir(abiDirectory, { recursive: true });
    await copyFile(binary, join(dest, library));
    await writeProvenance(abiDirectory, abiInput, [name]);
  }
  const metadata = libraries[0];
  if (!metadata) throw new Error("Select at least one Android ABI");
  await generateBindings(join(dest, metadata), "kotlin", join(dest, "kotlin"));
  if (
    (await fingerprint({ platform: "android", abis, ndk, ndkProperties })) !==
    input
  ) {
    throw new Error(
      "Social sources changed during the Android build. Run it again.",
    );
  }
  await writeProvenance(dest, input, files);
  console.info(dest);
}

const plist = (platform: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${framework}</string>
  <key>CFBundleIdentifier</key><string>app.boop.social.ffi</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${framework}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>${platform}</string></array>
  <key>MinimumOSVersion</key><string>${iosDeploymentTarget}</string>
</dict></plist>
`;

async function ios(output?: string) {
  if (process.platform !== "darwin")
    throw new Error("iOS packaging requires macOS and Xcode");
  const dest = resolve(output ?? join(root, "native", "ios"));
  const xcode = run(["xcodebuild", "-version"], { capture: true });
  const configuration = {
    platform: "ios",
    xcode,
    deploymentTarget: iosDeploymentTarget,
  };
  const input = await fingerprint(configuration);
  const artifacts = ["BoopSocial.swift", `${framework}.xcframework`];
  if (await isCurrent(dest, input, artifacts)) {
    console.info(dest);
    return;
  }

  await mkdir(staging, { recursive: true });
  const work = await mkdtemp(join(staging, "ios-"));
  const linker = join(staging, `apple-linker-${input.slice(0, 16)}`);
  await copyFile(join(import.meta.dir, "apple-linker.sh"), linker);
  await chmod(linker, 0o755);
  const swift = join(work, "swift");
  const slices = [
    { target: "aarch64-apple-ios", platform: "iPhoneOS" },
    { target: "aarch64-apple-ios-sim", platform: "iPhoneSimulator" },
  ];
  const xcframework = ["xcodebuild", "-create-xcframework"];
  for (const [index, slice] of slices.entries()) {
    run(
      [
        "cargo",
        "rustc",
        "--locked",
        "--release",
        "--target",
        slice.target,
        "--lib",
        "--crate-type",
        "cdylib",
        "--",
        "-C",
        `linker=${linker}`,
        "-C",
        `link-arg=-Wl,-install_name,@rpath/${framework}.framework/${framework}`,
      ],
      {
        environment: {
          ...env,
          IPHONEOS_DEPLOYMENT_TARGET: iosDeploymentTarget,
        },
      },
    );
    const binary = join(
      targetDir,
      slice.target,
      "release",
      "libboop_social.dylib",
    );
    requireSocialExports(
      run(["xcrun", "nm", "-gUj", binary], { capture: true }).split(/\r?\n/),
    );
    const dependencies = run(["xcrun", "otool", "-L", binary], {
      capture: true,
    });
    if (
      /\b(?:MarmotKit|libmarmot|libsqlite|libcrypto|libsodium)\b/.test(
        dependencies,
      )
    ) {
      throw new Error(
        "Social unexpectedly links another SDK or unbundled crypto or storage",
      );
    }
    if (index === 0) await generateBindings(binary, "swift", swift);
    const bundle = join(work, slice.target, `${framework}.framework`);
    await mkdir(join(bundle, "Headers"), { recursive: true });
    await mkdir(join(bundle, "Modules"), { recursive: true });
    await copyFile(binary, join(bundle, framework));
    await writeFile(join(bundle, "Info.plist"), plist(slice.platform));
    await copyFile(
      join(swift, `${framework}.h`),
      join(bundle, "Headers", `${framework}.h`),
    );
    await copyFile(
      join(import.meta.dir, "ios-framework.modulemap"),
      join(bundle, "Modules", "module.modulemap"),
    );
    xcframework.push("-framework", bundle);
  }
  const xcframeworkName = `${framework}.xcframework`;
  run([...xcframework, "-output", join(work, xcframeworkName)]);
  if ((await fingerprint(configuration)) !== input)
    throw new Error(
      "Social sources changed during the iOS build. Run it again.",
    );
  await mkdir(dest, { recursive: true });
  await cp(join(work, xcframeworkName), join(dest, xcframeworkName), {
    recursive: true,
  });
  await copyFile(
    join(swift, "BoopSocial.swift"),
    join(dest, "BoopSocial.swift"),
  );
  await writeProvenance(dest, input, artifacts);
  console.info(dest);
}

const [platform, argument, output] = process.argv.slice(2);
switch (platform) {
  case "android":
    await android(argument, output);
    break;
  case "ios":
    await ios(argument);
    break;
  case "bindings": {
    run(["cargo", "build", "--locked", "--lib"], { environment: hostEnv });
    const binary = windows
      ? "boop_social.dll"
      : process.platform === "darwin"
        ? "libboop_social.dylib"
        : "libboop_social.so";
    const dest = resolve(argument ?? join(root, "native", "bindings"));
    await generateBindings(
      join(hostTargetDir, "debug", binary),
      "kotlin",
      join(dest, "kotlin"),
    );
    await generateBindings(
      join(hostTargetDir, "debug", binary),
      "swift",
      join(dest, "swift"),
    );
    console.info(dest);
    break;
  }
  default:
    throw new Error(
      "Usage: bun scripts/build-native.ts android [comma-separated ABIs] [output directory] | ios [output directory] | bindings [output directory]",
    );
}
