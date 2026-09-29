import type { TextCompareResult } from "@shared/api.ts";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeftRight, FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { InlineTextDiff } from "@/components/InlineTextDiff.tsx";
import { PageHeader } from "@/components/PageHeader.tsx";
import { api, errorMessage } from "@/lib/api.ts";
import { Badge, type BadgeTone } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { Textarea } from "@/ui/Input.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";

interface TextFile {
  name: string;
  content: string;
}

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  add: { label: "新增", tone: "ok" },
  remove: { label: "删除", tone: "danger" },
  modify: { label: "修改", tone: "warn" },
  same: { label: "未变", tone: "neutral" },
};

type Row = TextCompareResult["rows"][number];

export function ComparePage() {
  const [left, setLeft] = useState<TextFile>({ name: "left", content: "" });
  const [right, setRight] = useState<TextFile>({ name: "right", content: "" });
  const leftFile = useRef<HTMLInputElement | null>(null);
  const rightFile = useRef<HTMLInputElement | null>(null);

  const compare = useMutation({ mutationFn: () => api.compareText({ left, right }) });

  async function loadFile(target: "left" | "right", file: File | undefined) {
    if (!file) return;
    const content = await file.text();
    const next = { name: file.name, content };
    if (target === "left") setLeft(next);
    else setRight(next);
  }

  const setSide = (side: "left" | "right", content: string) => {
    if (side === "left") setLeft((previous) => ({ ...previous, content }));
    else setRight((previous) => ({ ...previous, content }));
  };

  const columns: readonly Column<Row>[] = [
    {
      id: "key",
      header: "Key",
      width: 280,
      cell: (row) => (
        <code className="block truncate font-mono text-xs" title={row.key}>
          {row.key}
        </code>
      ),
    },
    {
      id: "status",
      header: "状态",
      width: 72,
      cell: (row) => {
        const meta = STATUS_META[row.status] ?? { label: row.status, tone: "neutral" as BadgeTone };
        return <Badge tone={meta.tone}>{meta.label}</Badge>;
      },
    },
    {
      id: "diff",
      header: <span className="block truncate">{`${left.name} → ${right.name}`}</span>,
      cell: (row) => <InlineTextDiff before={row.left} after={row.right} />,
    },
  ];

  return (
    <>
      <PageHeader title="文本对比" description="粘贴或上传两份语言文件，按 key 比较内容差异（不会写入仓库）。" />

      <div className="grid gap-4 lg:grid-cols-2">
        {(["left", "right"] as const).map((side) => {
          const file = side === "left" ? left : right;
          const ref = side === "left" ? leftFile : rightFile;
          return (
            <Card key={side}>
              <CardHeader
                title={side === "left" ? "左侧文件" : "右侧文件"}
                description={file.name}
                actions={
                  <>
                    <input
                      ref={ref}
                      type="file"
                      accept=".json,.lang,.txt"
                      className="hidden"
                      onChange={(event) => void loadFile(side, event.target.files?.[0])}
                    />
                    <Button size="sm" icon={<FileUp aria-hidden="true" className="size-3.5" />} onClick={() => ref.current?.click()}>
                      上传
                    </Button>
                  </>
                }
              />
              <CardBody>
                <Textarea
                  aria-label={side === "left" ? "左侧内容" : "右侧内容"}
                  className="min-h-52 font-mono text-xs"
                  placeholder='{"item.mod.name": "名称"}'
                  value={file.content}
                  onChange={(event) => setSide(side, event.target.value)}
                />
              </CardBody>
            </Card>
          );
        })}
      </div>

      <div className="my-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<ArrowLeftRight aria-hidden="true" className="size-4" />}
          loading={compare.isPending}
          onClick={() => compare.mutate()}
        >
          开始对比
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setLeft({ name: "left", content: "" });
            setRight({ name: "right", content: "" });
            compare.reset();
          }}
        >
          清空
        </Button>
        {compare.isError && <span className="text-xs text-danger">{errorMessage(compare.error)}</span>}
      </div>

      {compare.isError ? (
        <ErrorState error={compare.error} onRetry={() => compare.mutate()} />
      ) : compare.data ? (
        <div className="flex flex-col gap-4">
          {compare.data.errors.length > 0 && (
            <Card>
              <CardHeader title="解析提示" />
              <CardBody>
                <ul className="list-disc space-y-1 pl-5 text-xs text-warn">
                  {compare.data.errors.map((message, index) => (
                    <li key={index}>{message}</li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
          <DataTable columns={columns} rows={compare.data.rows} rowKey={(row) => row.key} ariaLabel="文本对比结果" empty="没有可比较的 key" />
        </div>
      ) : (
        <EmptyState title="还没有对比结果" description="填入两份内容后点击「开始对比」。" />
      )}
    </>
  );
}
