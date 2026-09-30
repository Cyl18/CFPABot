import { CrossVersionPanel } from "@/components/CrossVersionPanel.tsx";
import { crossVersionPatch, crossVersionQuery } from "@/lib/crossVersionSearch.ts";
import type { PrSearch, SearchPatch } from "@/lib/search.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

export function VersionsTab({
  n,
  slugs,
  search,
  onSearchChange,
}: {
  n: number;
  slugs: readonly string[];
  search: PrSearch;
  onSearchChange: (patch: SearchPatch) => void;
}) {
  const selected = slugs.find((item) => item === search.slug) ?? slugs[0];

  if (selected === undefined) {
    return <EmptyState title="没有涉及模组" description="此 PR 没有改动任何模组的语言文件，无需做跨版本比较。" />;
  }

  return (
    <div className="flex flex-col gap-3">
      {slugs.length > 1 && (
        <div role="group" aria-label="模组" className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">模组</span>
          {slugs.map((item) => (
            <ToggleChip key={item} mono pressed={item === selected} onClick={() => onSearchChange({ slug: item, ns: undefined })}>
              {item}
            </ToggleChip>
          ))}
        </div>
      )}
      <CrossVersionPanel
        key={`${selected}\u0000${search.ns ?? ""}`}
        slug={selected}
        namespace={search.ns}
        pr={n}
        state={crossVersionQuery(search, n)}
        onStateChange={(patch) => onSearchChange(crossVersionPatch(patch, n))}
        onNamespaceChange={(next) => onSearchChange({ ns: next })}
      />
    </div>
  );
}
