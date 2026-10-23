import { useEffect, useState } from "react";
import { fetchModelsDevModels, loadModelsDevCache, type FlatModelEntry } from "@/lib/models-dev.ts";

export type ModelsDevStatus = "loading" | "ready" | "error";

export interface ModelsDevState {
  index: FlatModelEntry[] | null;
  status: ModelsDevStatus;
}

export function useModelsDevIndex(): ModelsDevState {
  const [index, setIndex] = useState<FlatModelEntry[] | null>(() => loadModelsDevCache());
  const [status, setStatus] = useState<ModelsDevStatus>(() => (index ? "ready" : "loading"));
  useEffect(() => {
    let alive = true;
    void fetchModelsDevModels()
      .then((entries) => {
        if (!alive) return;
        if (entries) setIndex(entries);
        setStatus(entries ? "ready" : "error");
      })
      .catch(() => {
        if (!alive) return;
        setStatus((current) => (current === "ready" ? "ready" : "error"));
      });
    return () => {
      alive = false;
    };
  }, []);
  return { index, status };
}
