import { useNavigate } from "@tanstack/react-router";
import { CrossVersionPanel } from "@/components/CrossVersionPanel.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

export function VersionsTab({ n, slugs, slug, ns }: { n: number; slugs: readonly string[]; slug?: string; ns?: string }) {
  const navigate = useNavigate();
  const selected = slugs.find((item) => item === slug) ?? slugs[0];

  if (selected === undefined) {
    return <EmptyState title="没有涉及模组" description="此 PR 没有改动任何模组的语言文件，无需做跨版本比较。" />;
  }

  const go = (search: { slug: string; ns?: string }) =>
    void navigate({ to: "/pr/$n/$tab", params: { n: String(n), tab: "versions" }, search, replace: true });

  return (
    <div className="flex flex-col gap-3">
      {slugs.length > 1 && (
        <div role="group" aria-label="模组" className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">模组</span>
          {slugs.map((item) => (
            <ToggleChip key={item} mono pressed={item === selected} onClick={() => go({ slug: item })}>
              {item}
            </ToggleChip>
          ))}
        </div>
      )}
      <CrossVersionPanel
        key={`${selected}\u0000${ns ?? ""}`}
        slug={selected}
        namespace={ns}
        pr={n}
        onNamespaceChange={(next) => go({ slug: selected, ns: next })}
      />
    </div>
  );
}
