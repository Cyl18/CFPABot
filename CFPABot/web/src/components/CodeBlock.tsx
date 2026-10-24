import { useEffect, useState } from "react";
import type { HighlighterCore } from "shiki/core";
import { CopyButton } from "@/ui/CopyButton.tsx";

const LANG_MODULES = {
  bash: () => import("shiki/langs/shellscript.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
} as const;

type Lang = keyof typeof LANG_MODULES;

const ALIASES: Record<string, Lang> = {
  bat: "powershell",
  cmd: "powershell",
  console: "bash",
  htm: "html",
  js: "javascript",
  md: "markdown",
  py: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
};

const THEMES = { light: "github-light", dark: "github-dark" } as const;
const CACHE_LIMIT = 300;
const cache = new Map<string, string>();
let highlighter: Promise<HighlighterCore | null> | null = null;

function canonical(lang: string | undefined): Lang | undefined {
  if (lang === undefined) return undefined;
  const id = lang.toLowerCase();
  if (id in LANG_MODULES) return id as Lang;
  return ALIASES[id];
}

async function createHighlighterCore(): Promise<HighlighterCore | null> {
  try {
    const [core, engine, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ]);
    return await core.createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    });
  } catch {
    return null;
  }
}

const loaded = new Set<Lang>();

async function ensureLanguage(instance: HighlighterCore, id: Lang): Promise<void> {
  if (loaded.has(id)) return;
  const module = await LANG_MODULES[id]();
  await instance.loadLanguage(module.default);
  loaded.add(id);
}

/** 代码块高亮：未命中缓存时先渲染纯文本，shiki 加载完成后再替换，避免闪白。 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const id = canonical(lang);
  const key = id === undefined ? "" : `${id}\u0000${code}`;
  const [html, setHtml] = useState(() => (key === "" ? undefined : cache.get(key)));

  useEffect(() => {
    if (key === "" || id === undefined) {
      setHtml(undefined);
      return;
    }
    const hit = cache.get(key);
    if (hit !== undefined) {
      setHtml(hit);
      return;
    }
    highlighter ??= createHighlighterCore();
    let alive = true;
    void highlighter.then(async (instance) => {
      if (instance === null) return;
      try {
        await ensureLanguage(instance, id);
        if (!alive) return;
        const output = instance.codeToHtml(code, { lang: id, themes: THEMES, defaultColor: false });
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(key, output);
        setHtml(output);
      } catch {}
    });
    return () => {
      alive = false;
    };
  }, [code, id, key]);

  return (
    <div className="group/code relative">
      {html === undefined ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {code !== "" && (
        <CopyButton
          text={code}
          label="复制代码"
          className="absolute right-1.5 top-1.5 bg-surface/90 opacity-0 shadow-[var(--shadow-panel)] backdrop-blur group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      )}
    </div>
  );
}
