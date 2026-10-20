import { PageHeader } from "@/components/PageHeader.tsx";
import { Tabs, type TabItem } from "@/ui/Tabs.tsx";
import { CachePanel } from "@/routes/admin/CachePanel.tsx";
import { LlmPanel } from "@/routes/admin/LlmPanel.tsx";
import { LogsPanel } from "@/routes/admin/LogsPanel.tsx";
import { MappingsPanel } from "@/routes/admin/MappingsPanel.tsx";
import { StatusPanel } from "@/routes/admin/StatusPanel.tsx";

export type AdminTab = "status" | "llm" | "mappings" | "logs" | "cache";

const TABS: readonly TabItem<AdminTab>[] = [
  { id: "status", label: "系统状态" },
  { id: "llm", label: "LLM 配置" },
  { id: "mappings", label: "映射" },
  { id: "logs", label: "日志" },
  { id: "cache", label: "缓存" },
];

export function AdminPage({ tab, onTabChange }: { tab: AdminTab; onTabChange: (tab: AdminTab) => void }) {
  return (
    <>
      <PageHeader title="管理" description="系统状态、模型配置、映射与日志。" />
      <Tabs items={TABS} value={tab} onChange={onTabChange} ariaLabel="管理页面分区" variant="underline" className="mb-5" />

      {tab === "status" && <StatusPanel />}
      {tab === "llm" && <LlmPanel />}
      {tab === "mappings" && <MappingsPanel />}
      {tab === "logs" && <LogsPanel />}
      {tab === "cache" && <CachePanel />}
    </>
  );
}
