// scripts/fetch-glossary.ts
// Auto-download the packtrans-glossary MCP server binary from GitHub releases.
//
// Target dir: process.env.CFPABOT_GLOSSARY_DIR ?? <cwd>/runtime/bin
//   - Local dev: downloaded once into runtime/bin (gitignored), reused across runs.
//   - Docker: Dockerfile downloads the Linux build into /app/bin and sets
//     CFPABOT_GLOSSARY_DIR=/app/bin — this script sees the binary exists and no-ops.
//
// Platform assets (release: https://github.com/packtrans/glossary/releases):
//   win32 x64  → packtrans-glossary-${VERSION}-x86_64-pc-windows-msvc.zip
//   linux x64  → packtrans-glossary-${VERSION}-x86_64-unknown-linux-gnu.tar.gz
//
// Usage: bun run scripts/fetch-glossary.ts   (idempotent; exits 0 when present)

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { unzip } from "unzipit";

const VERSION = "v0.0.13"; // align with Dockerfile ARG GLOSSARY_VERSION
const TARGET_DIR = process.env.CFPABOT_GLOSSARY_DIR ?? join(process.cwd(), "runtime/bin");
const EXE = process.platform === "win32" ? "packtrans-glossary.exe" : "packtrans-glossary";
const BIN_PATH = join(TARGET_DIR, EXE);

const RELEASE_BASE = `https://github.com/packtrans/glossary/releases/download/${VERSION}`;

function assetName(): string | null {
  const arch = process.arch; // "x64" | "arm64" | ...
  if (process.platform === "win32" && arch === "x64") {
    return `packtrans-glossary-${VERSION}-x86_64-pc-windows-msvc.zip`;
  }
  if (process.platform === "linux" && arch === "x64") {
    return `packtrans-glossary-${VERSION}-x86_64-unknown-linux-gnu.tar.gz`;
  }
  return null;
}

async function main(): Promise<void> {
  if (existsSync(BIN_PATH)) {
    console.log(`exists: ${BIN_PATH}`);
    return;
  }

  const asset = assetName();
  if (!asset) {
    console.error(`unsupported platform: ${process.platform}/${process.arch}`);
    process.exit(1);
  }

  const url = `${RELEASE_BASE}/${asset}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`download failed: HTTP ${res.status} ${res.statusText} (${url})`);
    process.exit(1);
  }

  mkdirSync(TARGET_DIR, { recursive: true });

  if (asset.endsWith(".zip")) {
    const buf = Buffer.from(await res.arrayBuffer());
    const { entries } = await unzip(buf);
    for (const [name, entry] of Object.entries(entries)) {
      const isExecutable =
        name === "packtrans-glossary.exe" ||
        name.endsWith("/packtrans-glossary.exe") ||
        name.endsWith("/packtrans-glossary");
      if (!isExecutable) continue;
      const bytes = await entry.arrayBuffer();
      Bun.write(BIN_PATH, new Uint8Array(bytes));
      console.log(`extracted: ${BIN_PATH}`);
      break;
    }
  } else {
    // .tar.gz — delegate to system tar (present in oven/bun base image).
    const tmp = join(TARGET_DIR, asset);
    await Bun.write(tmp, new Uint8Array(await res.arrayBuffer()));
    const proc = Bun.spawn(["tar", "xzf", tmp, "-C", TARGET_DIR], { stdout: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`tar extract failed (exit ${code})`);
      process.exit(1);
    }
    // Tar layout: packtrans-glossary-${VERSION}-x86_64-unknown-linux-gnu/packtrans-glossary
    const nested = join(TARGET_DIR, `packtrans-glossary-${VERSION}-x86_64-unknown-linux-gnu`, "packtrans-glossary");
    if (existsSync(nested) && !existsSync(BIN_PATH)) {
      await Bun.write(BIN_PATH, await Bun.file(nested).arrayBuffer());
    }
  }

  if (!existsSync(BIN_PATH)) {
    console.error(`binary not found after extraction (asset: ${asset})`);
    process.exit(1);
  }
  console.log("OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
