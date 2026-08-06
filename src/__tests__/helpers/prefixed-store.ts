// src/__tests__/helpers/prefixed-store.ts
// FileStore wrapper that prepends a root prefix to every path.
// Lets production code keep logical paths while physical I/O goes
// under a unique temp/test-<suite>/ root, keeping tests parallel-safe
// and eliminating accidental production-data deletion.

import type { FileStore } from "@/types.js";
import { createFileStore } from "@/store.js";

export function createPrefixedStore(prefix: string): FileStore {
  const inner = createFileStore();

  function p(path: string): string {
    // Collapse double slashes if prefix is empty
    return `${prefix}/${path}`.replace(/\/\//g, "/");
  }

  return {
    read<T>(path: string): Promise<T | null> {
      return inner.read<T>(p(path));
    },
    write<T>(path: string, data: T): Promise<void> {
      return inner.write<T>(p(path), data);
    },
    append<T>(path: string, line: T): Promise<void> {
      return inner.append<T>(p(path), line);
    },
    list(prefixPath: string): Promise<string[]> {
      return inner.list(p(prefixPath));
    },
  };
}
