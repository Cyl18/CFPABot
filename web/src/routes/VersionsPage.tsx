import { PageHeader } from "@/components/PageHeader.tsx";
import { CrossVersionPanel } from "@/components/CrossVersionPanel.tsx";
import { crossVersionPatch, crossVersionQuery } from "@/lib/crossVersionSearch.ts";
import type { SearchPatch, VersionsSearch } from "@/lib/search.ts";

export function VersionsPage({
  slug,
  search,
  onSearchChange,
}: {
  slug: string;
  search: VersionsSearch;
  onSearchChange: (patch: SearchPatch) => void;
}) {
  return (
    <>
      <PageHeader
        back={{ to: "/mods", label: "返回模组列表" }}
        title={
          <>
            跨版本一致性 · <span className="font-mono">{slug}</span>
          </>
        }
        description="基于 main 分支，找出同一句英文在不同版本间译法不一致或尚未复用的地方。"
      />
      <CrossVersionPanel
        key={search.namespace ?? ""}
        slug={slug}
        namespace={search.namespace}
        state={crossVersionQuery(search)}
        onStateChange={(patch) => onSearchChange(crossVersionPatch(patch))}
        onNamespaceChange={(next) => onSearchChange({ namespace: next })}
      />
    </>
  );
}
