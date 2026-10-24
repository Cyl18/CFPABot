import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "v0.0.14";
const ASSETS: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

const root = join(import.meta.dir, "..");
const name = process.platform === "win32" ? "packtrans-glossary.exe" : "packtrans-glossary";
const dir = join(root, "runtime", "bin");
const bin = join(dir, name);

/** .mcp.json 与二进制同源生成：Windows 可执行文件必须带 .exe，配置无法静态跨平台。 */
async function writeConfig(command: string): Promise<void> {
  const config = { mcpServers: { glossary: { command, args: ["mcp"] } } };
  await Bun.write(join(root, ".mcp.json"), `${JSON.stringify(config, null, 2)}\n`);
}

if (existsSync(bin)) {
  await writeConfig(`./runtime/bin/${name}`);
  process.exit(0);
}

const target = ASSETS[`${process.platform}-${process.arch}`];
if (target === undefined) {
  console.warn(`[glossary] 没有 ${process.platform}-${process.arch} 的预编译包，术语 MCP 跳过`);
  process.exit(0);
}

const archive = `packtrans-glossary-${VERSION}-${target}`;
const ext = process.platform === "win32" ? "zip" : "tar.gz";
const tmp = await mkdtemp(join(tmpdir(), "glossary-"));
try {
  const res = await fetch(`https://github.com/packtrans/glossary/releases/download/${VERSION}/${archive}.${ext}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const file = join(tmp, `pkg.${ext}`);
  await Bun.write(file, res);
  const untar = Bun.spawnSync(["tar", "-xf", file, "-C", tmp], { stdout: "pipe", stderr: "pipe" });
  if (untar.exitCode !== 0) throw new Error(untar.stderr.toString());
  await mkdir(dir, { recursive: true });
  await cp(join(tmp, archive, name), bin);
  await writeConfig(`./runtime/bin/${name}`);
  console.log(`[glossary] 已安装 ${bin}`);
} catch (err) {
  console.warn(`[glossary] 安装失败，术语 MCP 跳过：${String(err)}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
