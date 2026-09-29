import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api.ts";
import { qk, useLlmConfig } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Select } from "@/ui/Select.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";
import { LlmEndpointForm, type EndpointDraft } from "@/routes/admin/LlmEndpointForm.tsx";

export function LlmPanel() {
  const llm = useLlmConfig();
  const client = useQueryClient();
  const [endpoints, setEndpoints] = useState<readonly EndpointDraft[]>([]);
  const [agent, setAgent] = useState("");
  const [reviewers, setReviewers] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState<EndpointDraft | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<EndpointDraft | null>(null);
  const [reviewerToAdd, setReviewerToAdd] = useState("");

  useEffect(() => {
    const data = llm.data;
    if (!data || dirty) return;
    setEndpoints(data.endpoints.map((endpoint) => ({ ...endpoint })));
    setAgent(data.agent ?? "");
    setReviewers(data.reviewers);
  }, [llm.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      api.updateLlm({
        endpoints: endpoints.map((endpoint) => ({
          id: endpoint.id,
          provider: endpoint.provider,
          protocol: endpoint.protocol,
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          ...(endpoint.contextWindow !== undefined ? { contextWindow: endpoint.contextWindow } : {}),
          ...(endpoint.maxOutput !== undefined ? { maxOutput: endpoint.maxOutput } : {}),
          ...(endpoint.thinking !== undefined ? { thinking: endpoint.thinking } : {}),
          ...(endpoint.apiKey !== undefined && endpoint.apiKey !== "" ? { apiKey: endpoint.apiKey } : {}),
        })),
        ...(agent === "" ? {} : { agent }),
        reviewers: [...reviewers],
      }),
    onSuccess: (view) => {
      setNotice({ kind: "ok", text: "配置已保存" });
      setDirty(false);
      client.setQueryData(qk.llm, view);
      setEndpoints(view.endpoints.map((endpoint) => ({ ...endpoint })));
      setAgent(view.agent ?? "");
      setReviewers(view.reviewers);
    },
    onError: (error) => setNotice({ kind: "error", text: `保存失败：${errorMessage(error)}` }),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.testLlm(id),
    onSuccess: (result, id) => setTestResult((previous) => ({ ...previous, [id]: result.ok ? `✓ 可用${result.reply ? `：${result.reply}` : ""}` : `✗ ${result.error ?? "失败"}` })),
    onError: (error, id) => setTestResult((previous) => ({ ...previous, [id]: `✗ ${errorMessage(error)}` })),
  });

  const update = (mutate: (previous: readonly EndpointDraft[]) => readonly EndpointDraft[]) => {
    setEndpoints(mutate);
    setDirty(true);
    setNotice(null);
  };

  if (llm.error !== null) return <ErrorState error={llm.error} onRetry={() => void llm.refetch()} />;
  if (llm.isPending) return <SkeletonText lines={6} />;

  const endpointOptions = endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.id }));
  const reviewerCandidates = endpoints.filter((endpoint) => !reviewers.includes(endpoint.id));

  return (
    <div className="flex flex-col gap-3">
      {notice !== null && (
        <p className={notice.kind === "ok" ? "rounded border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ok" : "rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"}>
          {notice.text}
        </p>
      )}

      <Card>
        <CardHeader
          title="端点"
          description={`${endpoints.length} 个端点`}
          actions={
            <>
              <Button size="sm" icon={<RefreshCw aria-hidden="true" className="size-3.5" />} onClick={() => void llm.refetch()}>
                刷新
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus aria-hidden="true" className="size-3.5" />}
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                添加模型
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-2">
          {endpoints.length === 0 ? (
            <EmptyState title="还没有端点" description="添加至少两个端点后才能配置审查模型集。" compact />
          ) : (
            endpoints.map((endpoint) => (
              <div key={endpoint.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-elevated/40 px-3 py-2">
                <code className="font-mono text-xs">{endpoint.id}</code>
                <Badge>{endpoint.protocol}</Badge>
                {endpoint.hasKey || (endpoint.apiKey ?? "") !== "" ? <Badge tone="ok">有密钥</Badge> : <Badge tone="danger">缺密钥</Badge>}
                {endpoint.contextWindow !== undefined && <span className="text-xs text-muted">in {endpoint.contextWindow}</span>}
                {endpoint.maxOutput !== undefined && <span className="text-xs text-muted">out {endpoint.maxOutput}</span>}
                {testResult[endpoint.id] !== undefined && (
                  <span className={testResult[endpoint.id]?.startsWith("✓") === true ? "text-xs text-ok" : "text-xs text-danger"}>
                    {testResult[endpoint.id]}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" loading={test.isPending && test.variables === endpoint.id} onClick={() => test.mutate(endpoint.id)}>
                    测试
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="编辑"
                    aria-label="编辑"
                    icon={<Pencil aria-hidden="true" className="size-3.5" />}
                    onClick={() => {
                      setEditing(endpoint);
                      setFormOpen(true);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    title="删除"
                    aria-label="删除"
                    icon={<Trash2 aria-hidden="true" className="size-3.5" />}
                    onClick={() => setPendingDelete(endpoint)}
                  />
                </span>
              </div>
            ))
          )}
          {dirty && (
            <div className="flex items-center gap-2">
              <Button variant="primary" loading={save.isPending} icon={<Check aria-hidden="true" className="size-3.5" />} onClick={() => save.mutate()}>
                保存配置
              </Button>
              <Button variant="ghost" icon={<X aria-hidden="true" className="size-3.5" />} onClick={() => { setDirty(false); setNotice(null); void llm.refetch(); }}>
                放弃修改
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {formOpen && (
        <LlmEndpointForm
          initial={editing}
          onCancel={() => setFormOpen(false)}
          onSubmit={(drafts) => {
            setFormOpen(false);
            update((previous) => {
              let next = [...previous];
              for (const draft of drafts) {
                const index = next.findIndex((endpoint) => endpoint.id === draft.id);
                if (index >= 0) next = next.map((endpoint, current) => (current === index ? draft : endpoint));
                else next = [...next, draft];
              }
              return next;
            });
          }}
        />
      )}

      <Card>
        <CardHeader title="Agent 默认配置" description="新建会话与审查任务默认使用下列模型。" />
        <CardBody className="flex flex-col gap-3">
          <Select
            label="主模型"
            options={[{ value: "", label: "- 自动选择第一个端点 -" }, ...endpointOptions]}
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value);
              setDirty(true);
            }}
          />
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted">审查模型集（MoA，至少 2 个）</div>
            <ul className="flex flex-col gap-1">
              {reviewers.map((reviewer) => (
                <li key={reviewer} className="flex items-center gap-2 rounded border border-line bg-elevated/40 px-2 py-1">
                  <code className="font-mono text-xs">{reviewer}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-danger"
                    title="移除"
                    aria-label="移除"
                    icon={<Trash2 aria-hidden="true" className="size-3.5" />}
                    onClick={() => {
                      setReviewers((previous) => previous.filter((item) => item !== reviewer));
                      setDirty(true);
                    }}
                  />
                </li>
              ))}
              {reviewers.length === 0 && <li className="text-xs text-muted">尚未配置审查模型。</li>}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <Select
                wrapperClassName="w-72"
                aria-label="添加审查模型"
                options={[{ value: "", label: "选择端点…" }, ...reviewerCandidates.map((endpoint) => ({ value: endpoint.id, label: endpoint.id }))]}
                value={reviewerToAdd}
                onChange={(event) => setReviewerToAdd(event.target.value)}
              />
              <Button
                disabled={reviewerToAdd === ""}
                icon={<Plus aria-hidden="true" className="size-3.5" />}
                onClick={() => {
                  setReviewers((previous) => [...previous, reviewerToAdd]);
                  setReviewerToAdd("");
                  setDirty(true);
                }}
              >
                添加
              </Button>
              {reviewers.length > 0 && reviewers.length < 2 && <span className="text-xs text-warn">审查模型集至少需要 2 个模型</span>}
              {reviewers.length >= 2 && <span className="text-xs text-muted">已添加 {reviewers.length} 个模型</span>}
            </div>
          </div>
        </CardBody>
      </Card>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="删除端点"
        size="sm"
        description={`删除端点 ${pendingDelete?.id ?? ""}？${reviewers.includes(pendingDelete?.id ?? "") || agent === pendingDelete?.id ? "该端点被 Agent 配置引用，保存后引用会被移除。" : ""}`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (!target) return;
                setReviewers((previous) => previous.filter((item) => item !== target.id));
                if (agent === target.id) setAgent("");
                update((previous) => previous.filter((endpoint) => endpoint.id !== target.id));
              }}
            >
              删除
            </Button>
          </>
        }
      />
    </div>
  );
}
