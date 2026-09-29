import { useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader.tsx";
import { CrossVersionPanel } from "@/components/CrossVersionPanel.tsx";

export function VersionsPage({ slug, namespace }: { slug: string; namespace?: string }) {
  const navigate = useNavigate();
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
        key={namespace ?? ""}
        slug={slug}
        namespace={namespace}
        onNamespaceChange={(next) => void navigate({ to: "/versions/$slug", params: { slug }, search: { namespace: next }, replace: true })}
      />
    </>
  );
}
