import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bot, Cpu, GitPullRequest, PanelLeft } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api.ts";
import { qk, useLlmConfig, usePrs } from "@/lib/queries.ts";
import { useAgentSidebar } from "@/routes/agent/AgentLayout.tsx";
import { Composer } from "@/routes/agent/Composer.tsx";
import { OptionPicker, type PickerOption } from "@/routes/agent/OptionPicker.tsx";
import { Button } from "@/ui/Button.tsx";

export function NewSessionPage() {
  const llm = useLlmConfig();
  const prs = usePrs("open");
  const navigate = useNavigate();
  const client = useQueryClient();
  const sidebar = useAgentSidebar();
  const [model, setModel] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [message, setMessage] = useState("");

  const create = useMutation({
    mutationFn: (text: string) =>
      api.createSession({
        message: text,
        ...(model === "" ? {} : { model }),
        ...(prNumber === "" ? {} : { prNumber: Number(prNumber) }),
      }),
    onSuccess: (session) => {
      void client.invalidateQueries({ queryKey: qk.sessions });
      void navigate({ to: "/agent/$id", params: { id: session.id } });
    },
  });

  const modelOptions: PickerOption[] = [
    { value: "", label: "默认模型" },
    ...(llm.data?.endpoints ?? []).map((endpoint) => ({ value: endpoint.id, label: endpoint.id })),
  ];

  const prOptions: PickerOption[] = [
    { value: "", label: "不关联 PR" },
    ...(prs.data ?? []).map((pr) => ({ value: String(pr.number), label: `#${pr.number} ${pr.title}`, hint: pr.author })),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="hidden shrink-0 px-4 pt-2 md:block">
        <Button
          variant="ghost"
          size="icon"
          title={sidebar.open ? "隐藏会话列表" : "显示会话列表"}
          aria-label={sidebar.open ? "隐藏会话列表" : "显示会话列表"}
          aria-pressed={sidebar.open}
          onClick={sidebar.toggle}
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <div className="scroll-thin flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-8">
        <div className="w-full max-w-3xl">
          <div className="mb-5 text-center">
            <div aria-hidden="true" className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
              <Bot className="size-5" />
            </div>
            <h1 className="text-base font-semibold">新会话</h1>
            <p className="mt-1 text-sm text-muted">说明要审查的 PR 或要处理的任务，Agent 会自己挑工具。</p>
          </div>

          <Composer
            autoFocus
            value={message}
            onChange={setMessage}
            onSubmit={() => create.mutate(message.trim())}
            placeholder="例如：审查 PR #6163，重点看术语一致性和漏掉的 key"
            submitLabel="开始"
            pending={create.isPending}
            hint="Enter 发送 · Shift+Enter 换行"
            error={create.isError ? errorMessage(create.error) : undefined}
            top={
              <>
                <OptionPicker label="模型" value={model} options={modelOptions} onChange={setModel} icon={<Cpu aria-hidden="true" className="size-3 text-muted" />} />
                <OptionPicker
                  label="关联 PR"
                  value={prNumber}
                  options={prOptions}
                  onChange={setPrNumber}
                  icon={<GitPullRequest aria-hidden="true" className="size-3 text-muted" />}
                  searchable
                />
              </>
            }
          />

          <p className="mt-3 text-center text-[11px] text-muted">会话创建后立即开始运行；执行权限默认开启，GitHub 写入默认关闭。</p>
        </div>
      </div>
    </div>
  );
}
