import type { LlmProtocol } from "@shared/api.ts";
import { useMutation } from "@tanstack/react-query";
import { Download, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { pickModelLimits, type FlatModelEntry } from "@/lib/models-dev.ts";
import { endpointId, inferProtocolFromUrl, normalizeLlmBaseUrl, PROTOCOLS, PROVIDER_PRESETS } from "@/lib/presets.ts";
import { Button } from "@/ui/Button.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { Checkbox, Input } from "@/ui/Input.tsx";
import { Select } from "@/ui/Select.tsx";

export interface EndpointDraft {
  id: string;
  provider: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxOutput?: number;
  apiKey?: string;
  hasKey: boolean;
}

const MODEL_LIST_LIMIT = 80;

export interface LlmEndpointFormProps {
  initial: EndpointDraft | null;
  modelsDevIndex: readonly FlatModelEntry[] | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (drafts: EndpointDraft[]) => void;
}

export function LlmEndpointForm({ initial, modelsDevIndex, saving, onCancel, onSubmit }: LlmEndpointFormProps) {
  const editing = initial !== null;
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [protocol, setProtocol] = useState<LlmProtocol>(initial?.protocol ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "");
  const [selectedModels, setSelectedModels] = useState<readonly string[]>([]);
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow !== undefined ? String(initial.contextWindow) : "");
  const [maxOutput, setMaxOutput] = useState(initial?.maxOutput !== undefined ? String(initial.maxOutput) : "");
  const [identityChanged, setIdentityChanged] = useState(false);
  const [modelFilter, setModelFilter] = useState("");

  const probe = useMutation({
    mutationFn: () =>
      api.probeModels({
        baseUrl,
        protocol,
        ...(apiKey !== "" ? { apiKey } : {}),
        ...(editing && initial !== null ? { endpointId: initial.id } : {}),
      }),
  });

  const models = useMemo(() => {
    const list = probe.data?.models ?? [];
    const needle = modelFilter.trim().toLowerCase();
    return needle === "" ? list : list.filter((item) => item.toLowerCase().includes(needle));
  }, [probe.data, modelFilter]);

  const canProbe = /^https?:\/\/.+/.test(baseUrl) && (apiKey !== "" || (editing && initial.hasKey));
  const keyReady = apiKey !== "" || (editing && initial.hasKey && !identityChanged);
  const manualModels = model.trim() === "" ? [] : [model.trim()];
  const modelsToUse = editing ? manualModels : [...new Set([...selectedModels, ...manualModels])];
  const valid = provider.trim() !== "" && /^https?:\/\/.+/.test(baseUrl) && keyReady && modelsToUse.length > 0;

  const enrichLimits = (modelId: string) => {
    const limits = pickModelLimits(modelsDevIndex, modelId, provider.trim());
    if (limits?.contextWindow !== undefined) setContextWindow(String(limits.contextWindow));
    if (limits?.maxOutput !== undefined) setMaxOutput(String(limits.maxOutput));
  };

  useEffect(() => {
    if (!modelsDevIndex || model.trim() === "") return;
    const limits = pickModelLimits(modelsDevIndex, model.trim(), provider.trim());
    if (limits?.contextWindow !== undefined && contextWindow === "") setContextWindow(String(limits.contextWindow));
    if (limits?.maxOutput !== undefined && maxOutput === "") setMaxOutput(String(limits.maxOutput));
  }, [modelsDevIndex]);

  const addTypedModel = () => {
    const value = model.trim();
    if (value === "" || selectedModels.includes(value)) return;
    setSelectedModels((previous) => [...previous, value]);
    setModel("");
    enrichLimits(value);
  };

  const submit = () => {
    const drafts: EndpointDraft[] = modelsToUse.map((item) => {
      const limits = pickModelLimits(modelsDevIndex, item, provider.trim());
      const context = editing ? (contextWindow !== "" ? Number(contextWindow) : undefined) : limits?.contextWindow ?? (contextWindow !== "" ? Number(contextWindow) : undefined);
      const output = editing ? (maxOutput !== "" ? Number(maxOutput) : undefined) : limits?.maxOutput ?? (maxOutput !== "" ? Number(maxOutput) : undefined);
      return {
        id: endpointId(provider.trim(), item),
        provider: provider.trim(),
        protocol,
        baseUrl,
        model: item,
        ...(context !== undefined ? { contextWindow: context } : {}),
        ...(output !== undefined ? { maxOutput: output } : {}),
        ...(apiKey !== "" ? { apiKey } : {}),
        hasKey: keyReady,
      };
    });
    onSubmit(drafts);
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={editing ? `编辑端点 ${initial.id}` : "添加端点"}
      description="地址会自动规范为 API 根路径；添加模式可一次加入多个模型。"
      size="lg"
      footer={
        <>
          <Button onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" loading={saving} disabled={!valid} icon={<Plus aria-hidden="true" className="size-3.5" />} onClick={submit}>
            {editing ? "保存端点" : modelsToUse.length > 1 ? `添加 ${modelsToUse.length} 个模型` : "添加端点"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="预设"
            options={[{ value: "", label: "自定义" }, ...PROVIDER_PRESETS.map((preset) => ({ value: preset.slug, label: preset.label }))]}
            value={PROVIDER_PRESETS.some((preset) => preset.slug === provider) ? provider : ""}
            disabled={saving}
            onChange={(event) => {
              const preset = PROVIDER_PRESETS.find((item) => item.slug === event.target.value);
              if (!preset) return;
              setProvider(preset.slug);
              setBaseUrl(preset.baseUrl);
              setProtocol(preset.protocol);
              setIdentityChanged(true);
            }}
          />
          <Input
            label="Provider ID"
            placeholder="如 openai、anthropic、siliconflow"
            hint="与 omp 的 provider id 对齐，填错会丢掉该 provider 的请求头与兼容规则。"
            value={provider}
            disabled={saving}
            onChange={(event) => {
              setProvider(event.target.value);
              setIdentityChanged(true);
            }}
          />
          <Select
            label="协议"
            options={PROTOCOLS.map((item) => ({ value: item.value, label: item.label }))}
            value={protocol}
            disabled={saving}
            onChange={(event) => setProtocol(event.target.value as LlmProtocol)}
          />
          <Input
            label="Base URL"
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            disabled={saving}
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={() => {
              const inferred = inferProtocolFromUrl(baseUrl);
              setBaseUrl(normalizeLlmBaseUrl(baseUrl));
              if (inferred !== undefined) setProtocol(inferred);
            }}
          />
          <Input
            label="API Key"
            type="password"
            placeholder={identityChanged && editing ? "身份已变更，必须输入新密钥" : editing && initial.hasKey ? "已保存，留空保留原值" : "sk-..."}
            value={apiKey}
            disabled={saving}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Input
            label="Model ID"
            placeholder="如 gpt-4o-mini"
            hint={editing ? "编辑模式只保存当前模型。" : "直接提交会加入输入的模型；也可从下方列表多选。"}
            value={model}
            disabled={saving}
            onChange={(event) => {
              setModel(event.target.value);
              setIdentityChanged(true);
            }}
            onBlur={() => enrichLimits(model.trim())}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || editing) return;
              event.preventDefault();
              addTypedModel();
            }}
          />
          <Input
            label="上下文窗口（tokens）"
            type="number"
            min={1}
            placeholder="128000"
            hint="选择或输入模型后自动从 models.dev 补全；多选时每个模型优先使用自身 limits。"
            value={contextWindow}
            disabled={saving}
            onChange={(event) => setContextWindow(event.target.value)}
          />
          <Input
            label="最大输出（tokens）"
            type="number"
            min={1}
            placeholder="16384"
            value={maxOutput}
            disabled={saving}
            onChange={(event) => setMaxOutput(event.target.value)}
          />
        </div>

        {!editing && selectedModels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">待添加：</span>
            {selectedModels.map((item) => (
              <span key={item} className="inline-flex items-center gap-1 rounded border border-line bg-elevated px-1.5 py-0.5 font-mono text-xs">
                {item}
                <button
                  type="button"
                  aria-label={`移除 ${item}`}
                  className="text-muted hover:text-danger"
                  disabled={saving}
                  onClick={() => setSelectedModels((previous) => previous.filter((value) => value !== item))}
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Download aria-hidden="true" className="size-3.5" />} disabled={!canProbe || saving} loading={probe.isPending} onClick={() => probe.mutate()}>
            拉取端点模型
          </Button>
          {!editing && model.trim() !== "" && (
            <Button icon={<Plus aria-hidden="true" className="size-3.5" />} disabled={saving} onClick={addTypedModel}>
              加入列表
            </Button>
          )}
          {probe.isError && <span className="text-xs text-danger">{errorMessage(probe.error)} — 可手动填写 Model ID</span>}
          {probe.data && <span className="text-xs text-muted">共 {probe.data.models.length} 个模型</span>}
        </div>

        {probe.data && (
          <div className="rounded border border-line">
            <div className="border-b border-line px-2 py-1.5">
              <Input
                aria-label="筛选模型"
                placeholder="筛选已拉取的模型"
                value={modelFilter}
                disabled={saving}
                onChange={(event) => setModelFilter(event.target.value)}
              />
            </div>
            <ul className="scroll-thin max-h-60 overflow-y-auto p-1">
              {models.slice(0, MODEL_LIST_LIMIT).map((item) =>
                editing ? (
                  <li key={item}>
                    <button
                      type="button"
                      disabled={saving}
                      className={cn(
                        "w-full rounded px-2 py-1 text-left font-mono text-xs hover:bg-elevated",
                        model === item && "bg-accent-soft text-accent",
                      )}
                      onClick={() => {
                        setModel(item);
                        setIdentityChanged(true);
                        enrichLimits(item);
                      }}
                    >
                      {item}
                    </button>
                  </li>
                ) : (
                  <li key={item} className="px-1 py-0.5">
                    <Checkbox
                      label={item}
                      className="mr-1"
                      disabled={saving}
                      checked={selectedModels.includes(item)}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setSelectedModels((previous) => [...previous, item]);
                          enrichLimits(item);
                        } else {
                          setSelectedModels((previous) => previous.filter((value) => value !== item));
                        }
                      }}
                    />
                  </li>
                ),
              )}
              {models.length === 0 && <li className="px-2 py-1 text-xs text-muted">没有匹配的模型</li>}
            </ul>
            {models.length > MODEL_LIST_LIMIT && (
              <p className="border-t border-line px-2 py-1 text-xs text-muted">
                仅显示前 {MODEL_LIST_LIMIT} 个，继续输入筛选词缩小范围。
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
