import { parseModelSelector, SEARCH_PROVIDER_PRESETS, type LlmConfigUpdate, type LlmConfigView } from "@cfpa/contracts/api";
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
    roles: { ...view.roles },
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
  const [roleName, setRoleName] = useState("");
  const [roleEndpoint, setRoleEndpoint] = useState("");
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
  const roleEntries = Object.entries(data.roles).sort(([a], [b]) =>
    a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b),
  );
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
    const roles = Object.fromEntries(
      Object.entries(base.roles).map(([name, selector]) => {
        const { endpoint, thinking } = parseModelSelector(selector);
        if (oldId === undefined || newId === undefined || endpoint !== oldId) return [name, selector];
        return [name, thinking === undefined ? newId : `${newId}:${thinking}`];
      }),
    );
    persist({ ...base, endpoints, roles }, () => {
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
        roles: Object.fromEntries(Object.entries(base.roles).filter(([, selector]) => parseModelSelector(selector).endpoint !== id)),
      },
      () => setPendingDelete(null),
    );
  };

  const saveRole = (name: string, selector: string) => {
    persist({ ...updateFrom(data), roles: { ...data.roles, [name]: selector } });
  };

  const changeRoleEndpoint = (name: string, endpointId: string) => {
    const endpoint = endpoints.find((item) => item.id === endpointId);
    const thinking = parseModelSelector(data.roles[name] ?? "").thinking;
    const keep =
      thinking !== undefined &&
      thinkingOptionsFor(modelsDevIndex, endpoint?.model ?? "", endpoint?.provider).some((option) => option.value === thinking);
    saveRole(name, keep ? `${endpointId}:${thinking}` : endpointId);
  };

  const changeRoleThinking = (name: string, value: string) => {
    const endpoint = parseModelSelector(data.roles[name] ?? "").endpoint;
    saveRole(name, value === "" ? endpoint : `${endpoint}:${value}`);
  };

  const addRole = () => {
    const name = roleName.trim();
    if (name === "" || roleEndpoint === "" || data.roles[name] !== undefined) return;
    persist({ ...updateFrom(data), roles: { ...data.roles, [name]: roleEndpoint } }, () => {
      setRoleName("");
      setRoleEndpoint("");
    });
  };

  const removeRole = (name: string) => {
    const roles = { ...data.roles };
    delete roles[name];
    persist({ ...updateFrom(data), roles });
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
              description="先添加至少一个模型端点，再配置模型别名。"
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
        <CardHeader
          title="模型别名"
          description="别名 → 端点[:思考强度]。default 是主模型，其余别名在 eval 的 completion 里按 @name 使用。"
        />
        <CardBody className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1">
            {roleEntries.map(([name, selector]) => {
              const { endpoint: endpointId, thinking } = parseModelSelector(selector);
              const endpoint = endpoints.find((item) => item.id === endpointId);
              const options = withCurrentThinking(
                thinkingOptionsFor(modelsDevIndex, endpoint?.model ?? "", endpoint?.provider),
                thinking,
              );
              return (
                <li key={name} className="flex flex-wrap items-center gap-2 rounded border border-line bg-elevated/40 px-2 py-1">
                  <code className="w-28 truncate font-mono text-xs">@{name}</code>
                  <Select
                    wrapperClassName="min-w-56 flex-1"
                    aria-label={`端点 ${name}`}
                    options={endpoints.map((item) => ({ value: item.id, label: item.id }))}
                    value={endpoint?.id ?? ""}
                    disabled={save.isPending || endpoints.length === 0}
                    onChange={(event) => changeRoleEndpoint(name, event.target.value)}
                  />
                  <Select
                    wrapperClassName="w-36"
                    aria-label={`思考强度 ${name}`}
                    options={options}
                    value={thinking ?? ""}
                    disabled={save.isPending || modelsDevLoading}
                    onChange={(event) => changeRoleThinking(name, event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className={name === "default" ? undefined : "text-danger"}
                    title={name === "default" ? "default 是主模型" : "移除"}
                    aria-label={`移除别名 ${name}`}
                    icon={<X aria-hidden="true" className="size-3.5" />}
                    disabled={save.isPending || name === "default"}
                    onClick={() => removeRole(name)}
                  />
                </li>
              );
            })}
            {roleEntries.length === 0 && <li className="text-xs text-muted">还没有别名。先加一个 default。</li>}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              wrapperClassName="w-40"
              label="新别名"
              placeholder="taska"
              value={roleName}
              disabled={save.isPending}
              onChange={(event) => setRoleName(event.target.value)}
            />
            <Select
              wrapperClassName="min-w-56 flex-1"
              label="端点"
              options={[{ value: "", label: "选择端点…" }, ...endpoints.map((item) => ({ value: item.id, label: item.id }))]}
              value={roleEndpoint}
              disabled={save.isPending || endpoints.length === 0}
              onChange={(event) => setRoleEndpoint(event.target.value)}
            />
            <Button
              size="sm"
              icon={<Plus aria-hidden="true" className="size-3.5" />}
              disabled={roleName.trim() === "" || roleEndpoint === "" || save.isPending}
              onClick={addRole}
            >
              添加
            </Button>
          </div>
          <p className="text-xs text-muted">
            派子代理用 <code className="font-mono">delegate</code>，单次调用用 <code className="font-mono">completion(prompt, model=&quot;@taska&quot;)</code>。
          </p>
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
        <p className="text-sm text-muted">引用该端点的模型别名会自动清理。</p>
      </Dialog>
    </div>
  );
}
