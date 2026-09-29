import type { LlmProtocol, ThinkingLevel } from "@shared/api.ts";
import { useMutation } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { endpointId, inferProtocolFromUrl, normalizeLlmBaseUrl, PROTOCOLS, PROVIDER_PRESETS } from "@/lib/presets.ts";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
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
  thinking?: ThinkingLevel;
  apiKey?: string;
  hasKey: boolean;
}

const THINKING_OPTIONS = [
  { value: "", label: "默认" },
  { value: "off", label: "off" },
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

export interface LlmEndpointFormProps {
  initial: EndpointDraft | null;
  onCancel: () => void;
  onSubmit: (drafts: EndpointDraft[]) => void;
}

export function LlmEndpointForm({ initial, onCancel, onSubmit }: LlmEndpointFormProps) {
  const editing = initial !== null;
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [protocol, setProtocol] = useState<LlmProtocol>(initial?.protocol ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "");
  const [selectedModels, setSelectedModels] = useState<readonly string[]>(initial !== null ? [initial.model] : []);
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow !== undefined ? String(initial.contextWindow) : "");
  const [maxOutput, setMaxOutput] = useState(initial?.maxOutput !== undefined ? String(initial.maxOutput) : "");
  const [thinking, setThinking] = useState<string>(initial?.thinking ?? "");
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

  const canProbe = /^https?:\/\/.+/.test(baseUrl) && (apiKey !== "" || (editing && initial?.hasKey === true));
  const manualModel = model.trim() === "" ? [] : [model.trim()];
  const modelsToUse = editing ? manualModel : selectedModels.length > 0 ? selectedModels : manualModel;
  const keyReady = apiKey !== "" || (editing && initial?.hasKey === true && !identityChanged);
  const valid = provider.trim() !== "" && /^https?:\/\/.+/.test(baseUrl) && keyReady && modelsToUse.length > 0;

  const submit = () => {
    const drafts: EndpointDraft[] = modelsToUse.map((item) => ({
      id: endpointId(provider.trim(), item),
      provider: provider.trim(),
      protocol,
      baseUrl,
      model: item,
      ...(contextWindow !== "" ? { contextWindow: Number(contextWindow) } : {}),
      ...(maxOutput !== "" ? { maxOutput: Number(maxOutput) } : {}),
      ...(thinking !== "" ? { thinking: thinking as ThinkingLevel } : {}),
      ...(apiKey !== "" ? { apiKey } : {}),
      hasKey: apiKey !== "" || (editing && initial?.hasKey === true && !identityChanged),
    }));
    onSubmit(drafts);
  };

  return (
    <Card>
      <CardHeader
        title={editing ? `编辑端点 ${initial?.id}` : "添加端点"}
        description="可粘贴带 /chat/completions 的完整地址，会自动规范为 API 根路径。"
      />
      <CardBody className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="预设"
            options={[{ value: "", label: "自定义" }, ...PROVIDER_PRESETS.map((preset) => ({ value: preset.slug, label: preset.label }))]}
            value={PROVIDER_PRESETS.some((preset) => preset.slug === provider) ? provider : ""}
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
            label="Provider"
            placeholder="自定义 provider 标识，如 siliconflow"
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value);
              setIdentityChanged(true);
            }}
          />
          <Select
            label="协议"
            options={PROTOCOLS.map((item) => ({ value: item.value, label: item.label }))}
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as LlmProtocol)}
          />
          <Input
            label="Base URL"
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={() => {
              const normalized = normalizeLlmBaseUrl(baseUrl);
              setBaseUrl(normalized);
              const inferred = inferProtocolFromUrl(baseUrl);
              if (inferred !== undefined) setProtocol(inferred);
            }}
          />
          <Input
            label="API Key"
            type="password"
            placeholder={identityChanged && editing ? "身份已变更，必须输入新 API Key" : editing && initial?.hasKey === true ? "留空保留原值" : "sk-..."}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Input
            label="Model ID"
            placeholder="gpt-4o-mini"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              setIdentityChanged(true);
            }}
          />
          <Input
            label="Input Limit (tokens)"
            type="number"
            placeholder="128000"
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value)}
          />
          <Input
            label="Max Output (tokens)"
            type="number"
            placeholder="16384"
            value={maxOutput}
            onChange={(event) => setMaxOutput(event.target.value)}
          />
          <Select label="思考强度" options={THINKING_OPTIONS} value={thinking} onChange={(event) => setThinking(event.target.value)} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon={<Download aria-hidden="true" className="size-3.5" />}
            disabled={!canProbe}
            loading={probe.isPending}
            onClick={() => probe.mutate()}
          >
            拉取端点模型
          </Button>
          {probe.isError && <span className="text-xs text-danger">{errorMessage(probe.error)} — 可手动填写 Model ID</span>}
          {probe.data && <span className="text-xs text-muted">共 {probe.data.models.length} 个模型</span>}
        </div>

        {probe.data && (
          <div className="rounded border border-line">
            <div className="border-b border-line px-2 py-1.5">
              <Input
                aria-label="筛选模型"
                placeholder="从已拉取列表中筛选模型"
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
              />
            </div>
            <ul className="scroll-thin max-h-56 overflow-y-auto p-1">
              {models.slice(0, 50).map((item) =>
                editing ? (
                  <li key={item}>
                    <button
                      type="button"
                      className={cn("w-full rounded px-2 py-1 text-left font-mono text-xs hover:bg-elevated", model === item && "bg-accent-soft text-accent")}
                      onClick={() => {
                        setModel(item);
                        setIdentityChanged(true);
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
                      checked={selectedModels.includes(item)}
                      onChange={(event) =>
                        setSelectedModels((previous) =>
                          event.target.checked ? [...previous, item] : previous.filter((value) => value !== item),
                        )
                      }
                    />
                  </li>
                ),
              )}
              {models.length === 0 && <li className="px-2 py-1 text-xs text-muted">没有匹配的模型</li>}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={onCancel}>取消</Button>
          <Button variant="primary" disabled={!valid} icon={<Plus aria-hidden="true" className="size-3.5" />} onClick={submit}>
            {editing ? "更新" : modelsToUse.length > 1 ? `添加 ${modelsToUse.length} 个模型` : "添加"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
