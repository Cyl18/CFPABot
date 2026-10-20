import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api.ts";
import { qk, useMappings } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";

export function MappingsPanel() {
  const mappings = useMappings();
  const client = useQueryClient();
  const [filter, setFilter] = useState("");
  const [slug, setSlug] = useState("");
  const [curseforgeId, setCurseforgeId] = useState("");

  const add = useMutation({
    mutationFn: () => api.addMapping(slug.trim(), Number(curseforgeId)),
    onSuccess: () => {
      setSlug("");
      setCurseforgeId("");
      void client.invalidateQueries({ queryKey: qk.mappings });
      void client.invalidateQueries({ queryKey: qk.status });
    },
  });

  const unmapped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (mappings.data?.unmapped ?? []).filter((item) => needle === "" || item.toLowerCase().includes(needle));
  }, [mappings.data, filter]);

  const columns: readonly Column<{ slug: string; curseforgeId: number; source: string }>[] = [
    { id: "slug", header: "Slug", cell: (row) => <code className="font-mono text-xs">{row.slug}</code> },
    { id: "id", header: "CurseForge ID", width: 160, cell: (row) => <span className="font-mono text-xs">{row.curseforgeId}</span> },
    { id: "source", header: "来源", width: 120, cell: (row) => <Badge tone={row.source === "manual" ? "accent" : "neutral"}>{row.source === "manual" ? "手动" : "自动"}</Badge> },
  ];

  if (mappings.error !== null) return <ErrorState error={mappings.error} onRetry={() => void mappings.refetch()} />;
  if (mappings.isPending) return <SkeletonText lines={6} />;

  const valid = slug.trim() !== "" && Number.isInteger(Number(curseforgeId)) && Number(curseforgeId) > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="添加映射" description="把模组 slug 手动指向 CurseForge 项目 ID，写入后立即生效。" />
        <CardBody className="flex flex-wrap items-end gap-2">
          <Input wrapperClassName="w-64" label="Slug" placeholder="jei" value={slug} onChange={(event) => setSlug(event.target.value)} />
          <Input
            wrapperClassName="w-48"
            label="CurseForge 项目 ID"
            type="number"
            placeholder="238222"
            value={curseforgeId}
            onChange={(event) => setCurseforgeId(event.target.value)}
          />
          <Button
            variant="primary"
            disabled={!valid}
            loading={add.isPending}
            icon={<Plus aria-hidden="true" className="size-3.5" />}
            onClick={() => add.mutate()}
          >
            添加
          </Button>
          {add.isError && <span className="text-xs text-danger">{errorMessage(add.error)}</span>}
          {add.isSuccess && <span className="text-xs text-ok">已添加</span>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="未映射 Slug"
          description={`${mappings.data?.unmapped.length ?? 0} 个`}
          actions={
            <Input
              aria-label="筛选 slug"
              placeholder="筛选 slug…"
              icon={<Search />}
              wrapperClassName="w-56"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          }
        />
        <CardBody>
          {unmapped.length === 0 ? (
            <EmptyState title={filter === "" ? "全部已映射" : "无匹配结果"} compact />
          ) : (
            <ul className="scroll-thin flex max-h-72 flex-wrap gap-1.5 overflow-y-auto">
              {unmapped.map((item) => (
                <li key={item} className="inline-flex h-6 items-center rounded border border-line bg-elevated px-2 font-mono text-xs">
                  {item}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card className="overflow-clip">
        <CardHeader title="已有映射" description={`${mappings.data?.mappings.length ?? 0} 条`} />
        <DataTable
          columns={columns}
          rows={mappings.data?.mappings ?? []}
          rowKey={(row) => row.slug}
          ariaLabel="CurseForge 映射表"
          empty="暂无映射"
          framed={false}
          valign="middle"
        />
      </Card>
    </div>
  );
}
