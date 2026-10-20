// 不能走 JSON.parse/Bun.JSON5.parse + Object.entries：整数样式的 key 会被重排，行号也无从取。

export interface FlattenParsed {
  entries: Map<string, string>;
  lines: Map<string, number>;
}

const FORMAT_BY_SUFFIX: Record<string, string> = { ".flatten.json5": "flatten" };

export function specialFormat(path: string): string | null {
  for (const [suffix, format] of Object.entries(FORMAT_BY_SUFFIX)) {
    if (path.endsWith(suffix)) return format;
  }
  return null;
}

const FAIL = Symbol("json5-fail");
const IDENT_START = /[A-Za-z_$\u0080-\uFFFF]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const HEX = /[0-9a-fA-F]/;
const NUMBER = /^(?:[+-]?(?:Infinity|NaN|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|0[xX][0-9a-fA-F]+)$/;
const SIMPLE_ESCAPE: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
};

export function parseFlatten(text: string): FlattenParsed | null {
  const entries = new Map<string, string>();
  const lines = new Map<string, number>();
  const n = text.length;
  let i = 0;
  let line = 1;

  const isBreak = (ch: string): boolean => ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
  const breakLen = (): number => (text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1);
  const isWsChar = (ch: string): boolean =>
    ch === " " || ch === "\t" || ch === "\v" || ch === "\f" || ch === "\u00a0" || ch === "\ufeff";

  const skipWs = (): void => {
    for (;;) {
      const ch = text[i];
      if (ch === undefined) return;
      if (isBreak(ch)) {
        i += breakLen();
        line++;
        continue;
      }
      if (isWsChar(ch)) {
        i++;
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") {
        i += 2;
        while (i < n && !isBreak(text[i] as string)) i++;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
          if (isBreak(text[i] as string)) {
            i += breakLen();
            line++;
            continue;
          }
          i++;
        }
        if (i >= n) throw FAIL;
        i += 2;
        continue;
      }
      return;
    }
  };

  const readHex = (count: number): string => {
    let hex = "";
    for (let k = 0; k < count; k++) {
      const ch = text[i];
      if (ch === undefined || !HEX.test(ch)) throw FAIL;
      hex += ch;
      i++;
    }
    return String.fromCharCode(Number.parseInt(hex, 16));
  };

  const readString = (): string => {
    const quote = text[i] as string;
    i++;
    let out = "";
    for (;;) {
      const ch = text[i];
      if (ch === undefined) throw FAIL;
      if (ch === quote) {
        i++;
        return out;
      }
      if (ch === "\\") {
        i++;
        const esc = text[i];
        if (esc === undefined) throw FAIL;
        if (esc === "\n" || esc === "\u2028" || esc === "\u2029") {
          i++;
          line++;
          continue;
        }
        if (esc === "\r") {
          i += text[i + 1] === "\n" ? 2 : 1;
          line++;
          continue;
        }
        if (esc === "x") {
          i++;
          out += readHex(2);
          continue;
        }
        if (esc === "u") {
          i++;
          out += readHex(4);
          continue;
        }
        out += SIMPLE_ESCAPE[esc] ?? esc;
        i++;
        continue;
      }
      if (isBreak(ch)) throw FAIL;
      out += ch;
      i++;
    }
  };

  const readKey = (): string => {
    const first = text[i];
    if (first === '"' || first === "'") return readString();
    if (first === undefined || (first !== "\\" && !IDENT_START.test(first))) throw FAIL;
    let out = "";
    for (;;) {
      const ch = text[i];
      if (ch === undefined) break;
      if (ch === "\\") {
        if (text[i + 1] !== "u") throw FAIL;
        i += 2;
        out += readHex(4);
        continue;
      }
      if (!IDENT_PART.test(ch)) break;
      out += ch;
      i++;
    }
    if (out === "") throw FAIL;
    return out;
  };

  const readScalar = (): unknown => {
    const start = i;
    while (i < n) {
      const ch = text[i] as string;
      if (ch === "," || ch === "}" || ch === "]" || ch === "/" || isWsChar(ch) || isBreak(ch)) break;
      i++;
    }
    const token = text.slice(start, i);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (!NUMBER.test(token)) throw FAIL;
    return Number(token);
  };

  const jsonText = (value: unknown): string => JSON.stringify(value) ?? "";

  const parseJsValue = (): unknown => {
    skipWs();
    const ch = text[i];
    if (ch === undefined) throw FAIL;
    if (ch === "{") {
      i++;
      return parseJsObject();
    }
    if (ch === "[") {
      i++;
      return parseJsArray();
    }
    if (ch === '"' || ch === "'") return readString();
    return readScalar();
  };

  const parseJsObject = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    let afterValue = false;
    for (;;) {
      skipWs();
      const ch = text[i];
      if (ch === undefined) throw FAIL;
      if (ch === "}") {
        i++;
        return out;
      }
      if (ch === ",") {
        if (!afterValue) throw FAIL;
        afterValue = false;
        i++;
        continue;
      }
      if (afterValue) throw FAIL;
      const key = readKey();
      skipWs();
      if (text[i] !== ":") throw FAIL;
      i++;
      out[key] = parseJsValue();
      afterValue = true;
    }
  };

  const parseJsArray = (): unknown[] => {
    const out: unknown[] = [];
    for (;;) {
      skipWs();
      const ch = text[i];
      if (ch === undefined) throw FAIL;
      if (ch === "]") {
        i++;
        return out;
      }
      if (ch === ",") {
        i++;
        out.push(undefined);
        continue;
      }
      out.push(parseJsValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      throw FAIL;
    }
  };

  const setLeaf = (key: string, value: string, at: number): void => {
    entries.set(key, value);
    lines.set(key, at);
  };

  const parseValue = (key: string, keyLine: number): void => {
    skipWs();
    const ch = text[i];
    if (ch === undefined) throw FAIL;
    if (ch === "{") {
      i++;
      parseObject(key);
      return;
    }
    if (ch === "[") {
      i++;
      setLeaf(key, jsonText(parseJsArray()), keyLine);
      return;
    }
    if (ch === '"' || ch === "'") {
      setLeaf(key, readString(), keyLine);
      return;
    }
    setLeaf(key, jsonText(readScalar()), keyLine);
  };

  const parseObject = (prefix: string | null): void => {
    let afterValue = false;
    for (;;) {
      skipWs();
      const ch = text[i];
      if (ch === undefined) throw FAIL;
      if (ch === "}") {
        i++;
        return;
      }
      if (ch === ",") {
        if (!afterValue) throw FAIL;
        afterValue = false;
        i++;
        continue;
      }
      if (afterValue) throw FAIL;
      const keyLine = line;
      const name = readKey();
      skipWs();
      if (text[i] !== ":") throw FAIL;
      i++;
      let key: string;
      if (prefix === null || prefix === "") key = name;
      else if (name === "") key = prefix;
      else if (":_-/".includes(prefix[prefix.length - 1] as string)) key = prefix + name;
      else key = `${prefix}.${name}`;
      parseValue(key, keyLine);
      afterValue = true;
    }
  };

  try {
    skipWs();
    if (text[i] !== "{") throw FAIL;
    i++;
    parseObject(null);
    skipWs();
    if (i !== n) throw FAIL;
  } catch (err) {
    if (err === FAIL) return null;
    throw err;
  }
  return { entries, lines };
}
