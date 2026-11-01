import { Glob } from "bun";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IGNORE = ["node_modules/**", "**/node_modules/**", "dist/**", "**/dist/**"];

// shortcut: 不识别正则字面量，正则里出现反引号会让扫描错位，真遇到就改用 TS 解析器。
function protectedRanges(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const stack: Array<"tpl" | "brace"> = [];
  let mode: "code" | "tpl" | "sq" | "dq" | "line" | "block" = "code";
  let start = 0;
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (mode === "code") {
      if (c === "/" && d === "/") { mode = "line"; i += 2; continue; }

      if (c === "/" && d === "*") { mode = "block"; start = i; i += 2; continue; }

      if (c === "'") { mode = "sq"; i += 1; continue; }

      if (c === '"') { mode = "dq"; i += 1; continue; }

      if (c === "`") { mode = "tpl"; start = i; i += 1; continue; }

      if (c === "{") { stack.push("brace"); i += 1; continue; }

      if (c === "}") {
        if (stack.pop() === "tpl") { mode = "tpl"; i += 1; continue; }
        i += 1; continue;
      }

      i += 1; continue;
    }

    if (mode === "line") {
      if (c === "\n") mode = "code";
      i += 1; continue;
    }

    if (mode === "block") {
      if (c === "*" && d === "/") { out.push([start, i + 2]); mode = "code"; i += 2; continue; }
      i += 1; continue;
    }

    if (mode === "sq" || mode === "dq") {
      if (c === "\\") { i += 2; continue; }

      if (c === "\n") { mode = "code"; i += 1; continue; }

      if (c === (mode === "sq" ? "'" : '"')) mode = "code";
      i += 1; continue;
    }

    if (c === "\\") { i += 2; continue; }

    if (c === "`") { out.push([start, i + 1]); mode = "code"; i += 1; continue; }

    if (c === "$" && d === "{") { stack.push("tpl"); mode = "code"; i += 2; continue; }
    i += 1;
  }

  if (mode === "tpl" || mode === "block") out.push([start, src.length]);

  return out;
}

const BLOCK_KEYWORD = /^(if|for|while|switch|try|do)\b/;
const DECLARATION = /^(const|let|var)\b/;
const TYPE_DECLARATION = /^(import|export|type|interface|function|class|async|enum|declare|abstract)\b/;
const EXPRESSION_TAIL = /[{(,]$/;

function format(src: string): string {
  const ranges = protectedRanges(src);
  const lines = src.split("\n");
  const starts: number[] = [];
  let offset = 0;

  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const out: string[] = [];
  let declarationOpen = false;

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i]!;
    const text = current.trim();
    const above = i > 0 ? lines[i - 1]! : "";
    const aboveText = above.trim();

    const aboveIsDeclaration = declarationOpen && aboveText.endsWith(";");
    const aboveEndsStatement = /[;)}\]]$/.test(aboveText) && !EXPRESSION_TAIL.test(aboveText);

    const currentStart = starts[i]!;
    const aboveStart = i > 0 ? starts[i - 1]! : -1;
    const insideLiteral =
      ranges.some(([a, b]) => currentStart > a && currentStart < b) ||
      ranges.some(([a, b]) => aboveStart > a && aboveStart < b);

    if (i > 0 && text !== "" && aboveText !== "" && aboveEndsStatement && !insideLiteral) {
      const closesBlock = /^[}]+;?$/.test(aboveText);
      const needsBlank =
        /^(return|throw)\b/.test(text) ||
        BLOCK_KEYWORD.test(text) ||
        (aboveIsDeclaration && !DECLARATION.test(text) && !TYPE_DECLARATION.test(text)) ||
        /^(\/\/|\/\*)/.test(text) ||
        (closesBlock && text.endsWith(";"));

      if (needsBlank) out.push("");
    }

    out.push(current);

    if (BLOCK_KEYWORD.test(text) || TYPE_DECLARATION.test(text) || DECLARATION.test(text)) declarationOpen = DECLARATION.test(text);

    if (declarationOpen && text.endsWith(";")) declarationOpen = false;
  }

  return out.join("\n");
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const roots = args.filter((a) => !a.startsWith("--"));

const glob = new Glob("**/*.{ts,tsx}");
const files: string[] = [];

for (const dir of roots.length > 0 ? roots : ["."]) {
  for (const file of glob.scanSync({ cwd: join(ROOT, dir), ignore: IGNORE, dot: false })) {
    files.push(dir === "." ? file : join(dir, file));
  }
}

let changed = 0;

for (const file of files.sort()) {
  const path = join(ROOT, file);
  const before = await Bun.file(path).text();
  const after = format(before);

  if (before === after) continue;

  changed += 1;

  if (check) {
    console.log(file);
    continue;
  }

  await Bun.write(path, after);
}

if (check) {
  if (changed > 0) console.log(`\n${changed} file(s) need newspaper spacing.`);
  process.exit(changed > 0 ? 1 : 0);
}

console.log(`newspaper spacing: ${changed} file(s) updated, ${files.length} scanned`);
