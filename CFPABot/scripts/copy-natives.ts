import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const platform = `pi-natives-${process.platform}-${process.arch}`;
const store = join(root, "node_modules", ".bun");
const entry = readdirSync(store).find((name) => name.startsWith(`@oh-my-pi+${platform}@`));
if (!entry) throw new Error(`缺少原生模块：@oh-my-pi/${platform}`);
const source = join(store, entry, "node_modules", "@oh-my-pi", platform);
const target = join(root, "native");
mkdirSync(target, { recursive: true });
for (const file of readdirSync(source)) {
  if (file.endsWith(".node")) cpSync(join(source, file), join(target, file));
}
