const PLACEHOLDER_RE = /%(?:(\d+)\$)?([sd])|\{(\d+)\}|\{([A-Za-z_][\w.]*)\}/g;
const FORMAT_CODE_RE = /[§&][0-9a-fk-or]/gi;
const TAG_RE = /<\/?[A-Za-z][^>]*>/g;

export const CJK_SPACE_RE = /[\u3400-\u9fff][ \t]+[\u3400-\u9fff]/;

export function placeholders(text: string): string[] {
  const shielded = text.replace(/%%/g, "\u0000");
  const found: { pos: number; sig: string }[] = [];
  let next = 1;
  for (const match of shielded.matchAll(PLACEHOLDER_RE)) {
    const explicit = match[1];
    const type = match[2];
    const index = match[3];
    const name = match[4];
    if (type !== undefined) {
      const pos = explicit !== undefined ? Number(explicit) : next;
      next = pos + 1;
      found.push({ pos, sig: `%${type}` });
    } else if (index !== undefined) {
      found.push({ pos: Number(index) + 1, sig: "{}" });
    } else if (name !== undefined) {
      found.push({ pos: 0, sig: `{${name}}` });
    }
  }
  return found.sort((a, b) => a.pos - b.pos || a.sig.localeCompare(b.sig)).map((entry) => `${entry.pos}:${entry.sig}`);
}

export function formatCodes(text: string): string[] {
  return (text.match(FORMAT_CODE_RE) ?? []).map((code) => code.toLowerCase()).sort();
}

export function tags(text: string): string[] {
  return (text.match(TAG_RE) ?? []).map((tag) => tag.replace(/\s+/g, " ")).sort();
}
