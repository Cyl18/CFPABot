import { gh } from "../github/client.ts";
import type { PrFile } from "../../shared/api.ts";

export function sidePaths(file: PrFile): { base: string | null; head: string | null } {
  return {
    base: file.status === "added" ? null : file.status === "renamed" ? file.previousPath ?? file.path : file.path,
    head: file.status === "removed" ? null : file.path,
  };
}

export function memoReader(): (path: string | null, ref: string) => Promise<string | null> {
  const reads = new Map<string, Promise<string | null>>();
  return (path, ref) => {
    if (path === null) return Promise.resolve(null);
    const key = `${ref}\u0000${path}`;
    let pending = reads.get(key);
    if (!pending) {
      pending = gh.getFile(path, ref);
      reads.set(key, pending);
    }
    return pending;
  };
}
