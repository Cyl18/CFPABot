import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api.ts";
import { useLlmConfig } from "@/lib/queries.ts";
import { Button } from "@/ui/Button.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { Checkbox, Input, Textarea } from "@/ui/Input.tsx";
import { Select } from "@/ui/Select.tsx";

export interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewSessionDialog({ open, onClose, onCreated }: NewSessionDialogProps) {
  const llm = useLlmConfig(open);
  const [prNumber, setPrNumber] = useState("");
  const [review, setReview] = useState(false);
  const [model, setModel] = useState("");
  const [message, setMessage] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createSession({
        ...(prNumber.trim() === "" ? {} : { prNumber: Number(prNumber) }),
        ...(message.trim() === "" ? {} : { message: message.trim() }),
        ...(review ? { workflow: "review" } : {}),
        ...(model === "" ? {} : { model }),
      }),
    onSuccess: (session) => {
      onCreated(session.id);
      onClose();
    },
  });

  const modelOptions = [
    { value: "", label: "使用默认模型" },
    ...(llm.data?.endpoints ?? []).map((endpoint) => ({ value: endpoint.id, label: endpoint.id })),
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建 Agent 会话"
      description="可选绑定 PR；开启审查后会先生成审查草稿。"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="PR 编号（可选）"
          type="number"
          min={1}
          placeholder="例如 1234"
          value={prNumber}
          onChange={(event) => setPrNumber(event.target.value)}
        />
        <Select label="模型" options={modelOptions} value={model} onChange={(event) => setModel(event.target.value)} />
        <Checkbox label="审查模式" hint="绑定 PR 后按审查流程生成草稿。" checked={review} onChange={(event) => setReview(event.target.checked)} />
        <Textarea
          label="初始消息（可选）"
          placeholder="例如：重点检查物品名称的术语一致性"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        {create.isError && <p className="text-xs text-danger">{errorMessage(create.error)}</p>}
      </div>
    </Dialog>
  );
}
