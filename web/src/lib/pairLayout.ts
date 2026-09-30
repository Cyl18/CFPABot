import { useEffect, useState } from "react";
import type { TabItem } from "@/ui/Tabs.tsx";

export type PairLayout = "split" | "stacked";

export const PAIR_LAYOUTS: readonly TabItem<PairLayout>[] = [
  { id: "split", label: "左右" },
  { id: "stacked", label: "上下" },
];

const STORAGE_KEY = "cfpa-pair-layout";

export function usePairLayout(): [PairLayout, (next: PairLayout) => void] {
  const [layout, setLayout] = useState<PairLayout>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === "split" || stored === "stacked" ? stored : "split";
    } catch {
      return "split";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, layout);
    } catch {}
  }, [layout]);

  return [layout, setLayout];
}
