import { SEARCH_PROVIDER_PRESETS, type LlmConfigUpdate, type LlmConfigView, type ThinkingLevel } from "@shared/api.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useModelsDevIndex } from "@/hooks/useModelsDev.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { thinkingOptionsFor, withCurrentThinking } from "@/lib/models-dev.ts";
import { qk, useLlmConfig } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { Select } from "@/ui/Select.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";
import { LlmEndpointForm, type EndpointDraft } from "@/routes/admin/LlmEndpointForm.tsx";

const NOTICE_MS = 2500;

interface TestResult {
  ok: boolean;
  text: string;
}

function updateFrom(view: LlmConfigView): LlmConfigUpdate {
  const ids = new Set(view.endpoints.map((endpoint) => endpoint.id));
  return {
    endpoints: view.endpoints.map((endpoint) => ({
      id: endpoint.id,
      provider: endpoint.provider,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      ...(endpoint.contextWindow !== undefined ? { contextWindow: endpoint.contextWindow } : {}),
      ...(endpoint.maxOutput !== undefined ? { maxOutput: endpoint.maxOutput } : {}),
    })),
    agent: view.agent !== undefined && ids.has(view.agent) ? view.agent : "",
    agentThinking: view.agentThinking ?? null,
    reviewers: view.reviewers
      .filter((reviewer) => ids.has(reviewer.id))
      .map((reviewer) => ({ id: reviewer.id, ...(reviewer.thinking ? { thinking: reviewer.thinking } : {}) })),
    search: view.search ? { provider: view.search.provider, endpoint: view.search.endpoint } : null,
  };
}

function formatLimit(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}

export function LlmPanel() {
  const llm = useLlmConfig();
  const client = useQueryClient();
  const modelsDev = useModelsDevIndex();
  const modelsDevIndex = modelsDev.index;
  const modelsDevLoading = modelsDev.status === "loading";
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EndpointDraft | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({});
  const [pendingDelete, setPendingDelete] = useState<EndpointDraft | null>(null);
  const [reviewerToAdd, setReviewerToAdd] = useState("");
  const [searchProvider, setSearchProvider] = useState("");
  const [searchEndpoint, setSearchEndpoint] = useState("");
  const [searchKey, setSearchKey] = useState("");
  const [searchHasKey, setSearchHasKey] = useState(false);
  const noticeTimer = useRef<number | undefined>(undefined);

  const data = llm.data;

  useEffect(() => {
    if (!data) return;
    setSearchProvider(data.search?.provider ?? "");
    setSearchEndpoint(data.search?.endpoint ?? "");
    setSearchHasKey(data.search?.hasKey ?? false);
    setSearchKey("");
  }, [data]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const flash = (text: string) => {
    setNotice({ kind: "ok", text });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const save = useMutation({
    mutationFn: (next: LlmConfigUpdate) => api.updateLlm(next),
    onSuccess: (view) => {
      client.setQueryData(qk.llm, view);
      flash("已保存");
    },
    onError: (error) => {
      setNotice({ kind: "error", text: `保存失败：${errorMessage(error)}` });
      void llm.refetch();
    },
  });

  const persist = (next: LlmConfigUpdate, after?: () => void) => {
    save.mutate(next, { onSuccess: () => after?.() });
  };

  const test = useMutation({
    mutationFn: (id: string) => api.testLlm(id),
    onSuccess: (result, id) =>
      setTestResult((previous) => ({
        ...previous,
        [id]: result.ok ? { ok: true, text: result.reply ? `可用：${result.reply}` : "可用" } : { ok: false, text: result.error ?? "测试失败" },
      })),
    onError: (error, id) => setTestResult((previous) => ({ ...previous, [id]: { ok: false, text: errorMessage(error) } })),
  });

  if (llm.error !== null) return <ErrorState error={llm.error} onRetry={() => void llm.refetch()} />;
  if (llm.isPending || !data) return <SkeletonText lines={6} />;

  const endpoints = data.endpoints;
  const agentValue = data.agent !== undefined && endpoints.some((endpoint) => endpoint.id === data.agent) ? data.agent : "";
  const reviewers = data.reviewers.filter((reviewer) => endpoints.some((endpoint) => endpoint.id === reviewer.id));
  const resolvedAgent = agentValue !== "" ? agentValue : endpoints[0]?.id;
  const agentEndpoint = endpoints.find((endpoint) => endpoint.id === resolvedAgent);
  const agentThinkingOptions = withCurrentThinking(
    thinkingOptionsFor(modelsDevIndex, agentEndpoint?.model ?? "", agentEndpoint?.provider),
    data.agentThinking,
  );
  const reviewerCandidates = endpoints.filter((endpoint) => !reviewers.some((reviewer) => reviewer.id === endpoint.id));
  const searchPreset = SEARCH_PROVIDER_PRESETS.find((preset) => preset.id === searchProvider);

  const submitEndpoint = (drafts: EndpointDraft[]) => {
    if (drafts.length === 0) return;
    const base = updateFrom(data);
    const oldId = editing?.id;
    const newId = drafts[0]?.id;
    const endpoints = base.endpoints.filter((endpoint) => endpoint.id !== oldId);
    for (const draft of drafts) {
      const index = endpoints.findIndex((endpoint) => endpoint.id === draft.id);
      const next = {
        id: draft.id,
        provider: draft.provider,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        model: draft.model,
        ...(draft.contextWindow !== undefined ? { contextWindow: draft.contextWindow } : {}),
        ...(draft.maxOutput !== undefined ? { maxOutput: draft.maxOutput } : {}),
        ...(draft.apiKey !== undefined && draft.apiKey !== "" ? { apiKey: draft.apiKey } : {}),
      };
      if (index >= 0) endpoints[index] = next;
      else endpoints.push(next);
    }
    const agent = oldId !== undefined && base.agent === oldId && newId !== undefined ? newId : base.agent;
    const reviewers = base.reviewers
      .map((reviewer) => (oldId !== undefined && reviewer.id === oldId && newId !== undefined ? { ...reviewer, id: newId } : reviewer))
      .filter((reviewer, index, all) => all.findIndex((item) => item.id === reviewer.id) === index);
    persist({ ...base, endpoints, agent: agent ?? "", reviewers }, () => {
      setFormOpen(false);
      setEditing(null);
    });
  };

  const deleteEndpoint = () => {
    if (!pendingDelete) return;
    const base = updateFrom(data);
    const id = pendingDelete.id;
    persist(
      {
        ...base,
        endpoints: base.endpoints.filter((endpoint) => endpoint.id !== id),
        agent: base.agent === id ? "" : (base.agent ?? ""),
        reviewers: base.reviewers.filter((reviewer) => reviewer.id !== id),
      },
      () => setPendingDelete(null),
    );
  };

  const changeAgent = (value: string) => {
    const nextId = value === "" ? endpoints[0]?.id : value;
    const endpoint = endpoints.find((item) => item.id === nextId);
    const options = thinkingOptionsFor(modelsDevIndex, endpoint?.model ?? "", endpoint?.provider);
    const keep = data.agentThinking !== undefined && options.some((option) => option.value === data.agentThinking);
    persist({ ...updateFrom(data), agent: value, agentThinking: keep && data.agentThinking !== undefined ? data.agentThinking : null });
  };

  const changeAgentThinking = (value: string) => {
    persist({ ...updateFrom(data), agentThinking: value === "" ? null : (value as ThinkingLevel) });
  };

  const addReviewer = () => {
    if (reviewerToAdd === "" || reviewers.some((reviewer) => reviewer.id === reviewerToAdd)) return;
    persist({ ...updateFrom(data), reviewers: [...reviewers, { id: reviewerToAdd }] }, () => setReviewerToAdd(""));
  };

  const removeReviewer = (id: string) => {
    persist({ ...updateFrom(data), reviewers: reviewers.filter((reviewer) => reviewer.id !== id) });
  };

  const changeReviewerThinking = (id: string, value: string) => {
    persist({
      ...updateFrom(data),
      reviewers: reviewers.map((reviewer) =>
        reviewer.id === id ? { id: reviewer.id, ...(value !== "" ? { thinking: value as ThinkingLevel } : {}) } : reviewer,
      ),
    });
  };

  const saveSearch = (provider: string, endpoint: string, apiKey?: string) => {
    persist({
      ...updateFrom(data),
      search: provider === "" ? null : { provider, endpoint, ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}) },
    });
  };

  const changeSearchProvider = (value: string) => {
    const preset = SEARCH_PROVIDER_PRESETS.find((item) => item.id === value);
    const endpoint = preset?.selfHosted === true ? preset.endpoint : "";
    setSearchProvider(value);
    setSearchEndpoint(endpoint);
    setSearchKey("");
    setSearchHasKey(false);
    saveSearch(value, endpoint);
  };

  const saveSearchKey = () => {
    const key = searchKey.trim();
    if (searchProvider === "" || key === "") return;
    persist(
      { ...updateFrom(data), search: { provider: searchProvider, endpoint: searchEndpoint, apiKey: key } },
      () => setSearchKey(""),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-6 items-center gap-2 text-xs">
        {notice !== null && (
          <span className={notice.kind === "ok" ? "text-ok" : "text-danger"} role={notice.kind === "error" ? "alert" : "status"}>
            {notice.text}
          </span>
        )}
        {save.isPending && <span className="text-muted">保存中…</span>}
      </div>

      <Card>
        <CardHeader
          title="端点"
          description="模型调用地址与凭据。密钥只写不读，留空表示保留原值。"
          actions={
            <>
              <Button size="sm" icon={<RefreshCw aria-hidden="true" className="size-3.5" />} disabled={save.isPending} onClick={() => void llm.refetch()}>
                刷新
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus aria-hidden="true" className="size-3.5" />}
                disabled={save.isPending}
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                添加端点
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-2">
          {endpoints.length === 0 ? (
            <EmptyState
              title="还没有端点"
              description="先添加至少一个模型端点，再配置主模型与审查模型集。"
              compact
              action={
                <Button size="sm" variant="primary" icon={<Plus aria-hidden="true" className="size-3.5" />} onClick={() => setFormOpen(true)}>
                  添加端点
                </Button>
              }
            />
          ) : (
            endpoints.map((endpoint) => {
              const result = testResult[endpoint.id];
              return (
                <div key={endpoint.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-elevated/40 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="truncate font-mono text-xs">{endpoint.id}</code>
                      <Badge>{endpoint.protocol}</Badge>
                      {endpoint.hasKey ? <Badge tone="ok">有密钥</Badge> : <Badge tone="danger">缺密钥</Badge>}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted">{endpoint.baseUrl}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    {endpoint.contextWindow !== undefined && <span>in {formatLimit(endpoint.contextWindow)}</span>}
                    {endpoint.maxOutput !== undefined && <span>out {formatLimit(endpoint.maxOutput)}</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    {result !== undefined && (
                      <span className={`max-w-56 truncate text-xs ${result.ok ? "text-ok" : "text-danger"}`} title={result.text}>
                        {result.ok ? "✓" : "✗"} {result.text}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={test.isPending && test.variables === endpoint.id}
                      disabled={save.isPending}
                      onClick={() => test.mutate(endpoint.id)}
                    >
                      测试
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="编辑"
                      aria-label={`编辑 ${endpoint.id}`}
                      icon={<Pencil aria-hidden="true" className="size-3.5" />}
                      disabled={save.isPending}
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
                      aria-label={`删除 ${endpoint.id}`}
                      icon={<Trash2 aria-hidden="true" className="size-3.5" />}
                      disabled={save.isPending}
                      onClick={() => setPendingDelete(endpoint)}
                    />
                  </div>
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Agent 默认模型" description="新建会话使用主模型；审查任务使用审查模型集。" />
        <CardBody className="flex flex-col gap-4">
          <div>
            <div className="flex flex-wrap items-end gap-2">
              <Select
                wrapperClassName="min-w-64 flex-1"
                label="主模型"
                options={[{ value: "", label: "自动（使用第一个端点）" }, ...endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.id }))]}
                value={agentValue}
                disabled={endpoints.length === 0 || save.isPending}
                onChange={(event) => changeAgent(event.target.value)}
              />
              <Select
                wrapperClassName="w-40"
                label="思考强度"
                options={agentThinkingOptions}
                value={data.agentThinking ?? ""}
                disabled={endpoints.length === 0 || save.isPending || modelsDevLoading}
                onChange={(event) => changeAgentThinking(event.target.value)}
              />
            </div>
            <p className="mt-1 text-xs text-muted">
              {endpoints.length === 0
                ? "先添加至少一个端点。"
                : agentValue !== ""
                  ? `显式指定 ${agentValue}。`
                  : `留空时自动使用 ${resolvedAgent}（列表中的第一个端点）。`}
            </p>
            <p className="mt-1 text-xs text-muted">
              {modelsDev.status === "loading"
                ? "正在加载 models.dev 模型规格…"
                : modelsDev.status === "error"
                  ? "models.dev 不可用，暂用通用思考选项。"
                  : "思考强度选项来自 models.dev 的 reasoning_options。"}
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">审查模型集（MoA）</span>
              <span className={reviewers.length > 0 && reviewers.length < 2 ? "text-xs text-warn" : "text-xs text-muted"}>
                {reviewers.length} 个{reviewers.length > 0 && reviewers.length < 2 ? "，至少需要 2 个" : ""}
              </span>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {reviewers.map((reviewer) => {
                const endpoint = endpoints.find((item) => item.id === reviewer.id);
                const options = withCurrentThinking(
                  thinkingOptionsFor(modelsDevIndex, endpoint?.model ?? "", endpoint?.provider),
                  reviewer.thinking,
                );
                return (
                  <li key={reviewer.id} className="flex items-center gap-2 rounded border border-line bg-elevated/40 px-2 py-1">
                    <code className="flex-1 truncate font-mono text-xs">{reviewer.id}</code>
                    <Select
                      wrapperClassName="w-36"
                      aria-label={`思考强度 ${reviewer.id}`}
                      options={options}
                      value={reviewer.thinking ?? ""}
                      disabled={save.isPending || modelsDevLoading}
                      onChange={(event) => changeReviewerThinking(reviewer.id, event.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      title="移除"
                      aria-label={`移除 ${reviewer.id}`}
                      icon={<X aria-hidden="true" className="size-3.5" />}
                      disabled={save.isPending}
                      onClick={() => removeReviewer(reviewer.id)}
                    />
                  </li>
                );
              })}
              {reviewers.length === 0 && <li className="text-xs text-muted">尚未配置审查模型。</li>}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select
                wrapperClassName="w-72"
                aria-label="添加审查模型"
                options={[{ value: "", label: "选择端点…" }, ...reviewerCandidates.map((endpoint) => ({ value: endpoint.id, label: endpoint.id }))]}
                value={reviewerToAdd}
                disabled={reviewerCandidates.length === 0 || save.isPending}
                onChange={(event) => setReviewerToAdd(event.target.value)}
              />
              <Button
                size="sm"
                icon={<Plus aria-hidden="true" className="size-3.5" />}
                disabled={reviewerToAdd === "" || save.isPending}
                onClick={addReviewer}
              >
                添加
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Web 搜索" description="web_search 工具使用的 provider 与凭据。" />
        <CardBody className="flex flex-col gap-3">
          <Select
            label="Provider"
            options={[
              { value: "", label: "自动（按环境变量）" },
              ...SEARCH_PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: `${preset.label}（${preset.id}）` })),
            ]}
            value={searchProvider}
            disabled={save.isPending}
            hint={
              searchProvider === ""
                ? "留空时不写入任何密钥，由 omp 按已存在的环境变量自动选择 provider。"
                : undefined
            }
            onChange={(event) => changeSearchProvider(event.target.value)}
          />
          {searchProvider !== "" && (
            <>
              {searchPreset?.keyless === true ? (
                <p className="text-xs text-muted">该 provider 不需要凭据，选中后由 omp 直接抓取结果。</p>
              ) : (
                <>
                  {searchPreset?.selfHosted === true && (
                    <Input
                      label="端点"
                      placeholder={searchPreset.endpoint !== "" ? searchPreset.endpoint : "留空使用 SDK 内置地址"}
                      value={searchEndpoint}
                      disabled={save.isPending}
                      onChange={(event) => setSearchEndpoint(event.target.value)}
                      onBlur={() => saveSearch(searchProvider, searchEndpoint)}
                    />
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      wrapperClassName="min-w-64 flex-1"
                      label="密钥 / Token"
                      type="password"
                      placeholder={searchHasKey ? "已保存，留空不修改" : "粘贴 API Key"}
                      value={searchKey}
                      disabled={save.isPending}
                      onChange={(event) => setSearchKey(event.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={searchKey.trim() === "" || save.isPending}
                      onClick={saveSearchKey}
                    >
                      保存密钥
                    </Button>
                    {searchHasKey && <Badge tone="ok">已保存</Badge>}
                  </div>
                </>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {formOpen && (
        <LlmEndpointForm
          initial={editing}
          modelsDevIndex={modelsDevIndex}
          saving={save.isPending}
          onCancel={() => {
            if (save.isPending) return;
            setFormOpen(false);
            setEditing(null);
          }}
          onSubmit={submitEndpoint}
        />
      )}

      <Dialog
        open={pendingDelete !== null}
        onClose={() => {
          if (!save.isPending) setPendingDelete(null);
        }}
        title="删除端点"
        size="sm"
        description={`删除端点 ${pendingDelete?.id ?? ""}？`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)} disabled={save.isPending}>
              取消
            </Button>
            <Button variant="danger" loading={save.isPending} onClick={deleteEndpoint}>
              删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">引用该端点的主模型与审查模型集会自动清理。</p>
      </Dialog>
    </div>
  );
}
