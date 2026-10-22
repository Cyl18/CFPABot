import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { api, errorMessage } from "@/lib/api.ts";
import { qk, useLlmConfig, usePrs } from "@/lib/queries.ts";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { Textarea } from "@/ui/Input.tsx";
import { Select } from "@/ui/Select.tsx";

export function NewSessionPage() {
  const llm = useLlmConfig(true);
  const prs = usePrs("open");
  const navigate = useNavigate();
  const client = useQueryClient();
  const [model, setModel] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [message, setMessage] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createSession({
        message: message.trim(),
        ...(model === "" ? {} : { model }),
        ...(prNumber === "" ? {} : { prNumber: Number(prNumber) }),
      }),
    onSuccess: (session) => {
      void client.invalidateQueries({ queryKey: qk.sessions });
      void navigate({ to: "/agent/$id", params: { id: session.id } });
    },
  });

  const modelOptions = [
    { value: "", label: "使用默认模型" },
    ...(llm.data?.endpoints ?? []).map((endpoint) => ({ value: endpoint.id, label: endpoint.id })),
  ];

  const prOptions = [
    { value: "", label: "不关联 PR" },
    ...(prs.data ?? []).map((pr) => ({ value: String(pr.number), label: `#${pr.number} ${pr.title}` })),
  ];

  const choosePr = (value: string): void => {
    setPrNumber(value);
    if (value !== "" && message.trim() === "") setMessage(`审查 PR #${value}`);
  };

  return (
    <>
      <PageHeader title="新会话" description="发一条消息开始；可选关联一个 PR，标题会自动带上 PR 编号。" />
      <Card>
        <CardBody>
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="模型" options={modelOptions} value={model} onChange={(event) => setModel(event.target.value)} />
              <Select label="关联 PR（可选）" options={prOptions} value={prNumber} onChange={(event) => choosePr(event.target.value)} />
            </div>
            <Textarea
              label="消息"
              rows={6}
              autoFocus
              placeholder="例如：审查 PR #1234，重点检查物品名称的术语一致性"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            {create.isError && <p className="text-xs text-danger">{errorMessage(create.error)}</p>}
            <div className="flex justify-end">
              <Button variant="primary" loading={create.isPending} disabled={message.trim() === ""} onClick={() => create.mutate()}>
                开始会话
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
