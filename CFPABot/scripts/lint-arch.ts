// scripts/lint-arch.ts
// Architecture boundary linter — enforces the dependency-direction rules
// documented in AGENTS.md ("模块放置规则") and src/api/README.md.
//
// Run: bun run lint:arch   (exit 0 = clean, 1 = violations found)
//
// Rules (all mechanically checkable from import statements / source tokens):
//   1. shared-no-io      — src/flows/_shared must be pure: no node:fs,
//                          node:child_process, node:http(s), @octokit, Bun.file/
//                          Bun.write/Bun.spawn/Bun.$, or bare fetch(.
//   2. shared-no-upward  — src/flows/_shared must not import @/client, @/api,
//                          or @/flows/* (only sibling @/flows/_shared).
//   3. api-no-fs         — src/api must not import node:fs.
//                          Exception: src/api/auth.ts (AES key loading, AGENTS.md).
//   4. api-no-octokit    — src/api must not import @octokit/*.
//                          Exception: src/api/webhook/receiver.ts (HMAC verify).
//   5. api-no-shared     — src/api must not import @/flows/_shared/*.
//   6. client-no-upward  — src/client must not import @/api or @/flows.
//   7. flows-no-api      — src/flows must not import @/api.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

interface Rule {
  name: string;
  dirs: string[];
  check: (rel: string, src: string) => string[];
}

const srcRoot = join(process.cwd(), "src");

const RULES: Rule[] = [
  {
    name: "shared-no-io",
    dirs: ["flows/_shared"],
    check: (_rel, src) => {
      const body = stripComments(src);
      const forbidden = [
        "node:fs",
        "node:child_process",
        "node:http",
        "node:https",
        "@octokit",
        "Bun.write(",
        "Bun.file(",
        "Bun.spawn(",
        "Bun.$(",
        "fetch(",
      ];
      return forbidden
        .filter((tok) => body.includes(tok))
        .map((tok) => `_shared 层禁止 I/O,但包含 \`${tok}\``);
    },
  },
  {
    name: "shared-no-upward",
    dirs: ["flows/_shared"],
    check: (_rel, src) =>
      importSpecifiers(src)
        .filter((spec) => {
          if (spec.startsWith("@/client") || spec.startsWith("@/api")) return true;
          if (spec.startsWith("@/flows/") && !spec.startsWith("@/flows/_shared")) return true;
          return false;
        })
        .map((spec) => `_shared 层禁止向上导入 \`${spec}\``),
  },
  {
    name: "api-no-fs",
    dirs: ["api"],
    check: (rel, src) =>
      rel === "api/auth.ts"
        ? []
        : importSpecifiers(src)
            .filter((spec) => spec.startsWith("node:fs"))
            .map((spec) => `api 层禁止导入 \`${spec}\`(唯一例外: auth.ts)`),
  },
  {
    name: "api-no-octokit",
    dirs: ["api"],
    check: (rel, src) =>
      rel === "api/webhook/receiver.ts"
        ? []
        : importSpecifiers(src)
            .filter((spec) => spec.startsWith("@octokit"))
            .map((spec) => `api 层禁止导入 \`${spec}\`(唯一例外: webhook/receiver.ts)`),
  },
  {
    name: "api-no-shared",
    dirs: ["api"],
    check: (_rel, src) =>
      importSpecifiers(src)
        .filter((spec) => spec.startsWith("@/flows/_shared"))
        .map((spec) => `api 层禁止导入 \`${spec}\`——应经 Flow 进入业务层`),
  },
  {
    name: "client-no-upward",
    dirs: ["client"],
    check: (_rel, src) =>
      importSpecifiers(src)
        .filter((spec) => spec.startsWith("@/api") || spec.startsWith("@/flows"))
        .map((spec) => `client 层禁止向上导入 \`${spec}\``),
  },
  {
    name: "flows-no-api",
    dirs: ["flows"],
    check: (_rel, src) =>
      importSpecifiers(src)
        .filter((spec) => spec.startsWith("@/api"))
        .map((spec) => `flows 层禁止导入 \`${spec}\``),
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "__tests__") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push((m[1] ?? m[2]) as string);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])[ \t]*\/\/.*$/gm, "$1");
}

// ─── Main ────────────────────────────────────────────────────────────

let violations = 0;
const checkedByRule: Record<string, number> = {};

for (const file of walk(srcRoot)) {
  const src = readFileSync(file, "utf8");
  const norm = file.replace(/\\/g, "/");
  const root = srcRoot.replace(/\\/g, "/");
  const rel = norm.slice(root.length + 1);
  for (const rule of RULES) {
    if (!rule.dirs.some((d) => norm.startsWith(root + "/" + d))) continue;
    checkedByRule[rule.name] = (checkedByRule[rule.name] ?? 0) + 1;
    for (const msg of rule.check(rel, src)) {
      violations += 1;
      console.error(`  ✗ ${rel} — ${rule.name}: ${msg}`);
    }
  }
}

console.log("lint:arch 完成 — 检查 " + RULES.length + " 条规则");
for (const [name, count] of Object.entries(checkedByRule)) {
  console.log(`  ${name}: ${count} 个文件`);
}
if (violations > 0) {
  console.error(`\n✗ ${violations} 处架构违规`);
  process.exit(1);
}
console.log("✓ 无架构违规");
