import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Use the same Nostr relay implementation as MDK's native host test.
const directory = join(import.meta.dir, "..", ".expo", "marmot-relay-fixture");
const manifest = join(directory, "Cargo.toml");
await mkdir(join(directory, "src"), { recursive: true });
await Promise.all([
  writeFile(
    manifest,
    `[package]
name = "boop-marmot-relay-fixture"
version = "0.1.0"
edition = "2024"

[dependencies]
nostr-relay-builder = "=0.44.0"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "net"] }
`,
  ),
  writeFile(
    join(directory, "src", "main.rs"),
    `#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let relay = nostr_relay_builder::MockRelay::run().await?;
    println!("{}", relay.url().await);
    std::future::pending::<()>().await;
    Ok(())
}
`,
  ),
]);

const relay = Bun.spawn(
  ["cargo", "run", "--quiet", "--manifest-path", manifest],
  {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => relay.kill(signal));
}
process.exitCode = await relay.exited;
