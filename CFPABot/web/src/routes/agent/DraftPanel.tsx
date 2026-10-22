import type { DraftComment, ReviewDraft, Severity, Verdict } from "@shared/api.ts";
import { ExternalLink, Save, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { SeverityBadge, VerdictBadge, VERDICT_OPTIONS } from "@/components/StatusBadges.tsx";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { Select } from "@/ui/Select.tsx";
import { Textarea } from "@/ui/Input.tsx";

const SEVERITY_OPTIONS: readonly { value: Severity; label: string }[] = [
  { value: "critical", label: "严重" },
  { value: "major", label: "主要" },
  { value: "minor", label: "次要" },
  { value: "neutral", label: "中性" },
];

export interface DraftPanelProps {
  draft: ReviewDraft;
  saving: boolean;
  publishing: boolean;
  error?: string;
  onChange: (draft: ReviewDraft) => void;
  onSave: () => void;
  onPublish: () => void;
}

export function DraftPanel({
  draft,
  saving,
  publishing,
  error,
  onChange,
  onSave,
  onPublish,
}: DraftPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const published = draft.publishedAt !== undefined;
  const updateComment = (index: number, patch: Partial<DraftComment>) => {
    const comments = draft.comments.map((comment, current) => (current === index ? { ...comment, ...patch } : comment));
    onChange({ ...draft, comments });
  };

  return (
    <>
      <Card>
        <CardHeader
          title="审查草稿"
          description={`PR #${draft.prNumber} · ${draft.comments.length} 条评论`}
          actions={
            <>
              <VerdictBadge verdict={draft.verdict} />
              {published ? <Badge tone="ok">已发布</Badge> : <Badge tone="warn">待发布</Badge>}
            </>
          }
        />
        <CardBody className="flex flex-col gap-3">
          {error !== undefined && <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{error}</p>}

          <Select
            label="结论"
            options={VERDICT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            value={draft.verdict}
            disabled={published}
            onChange={(event) => onChange({ ...draft, verdict: event.target.value as Verdict })}
          />

          <Textarea
            label="总结"
            className="min-h-24"
            value={draft.summary}
            disabled={published}
            onChange={(event) => onChange({ ...draft, summary: event.target.value })}
          />

          <div className="flex flex-col gap-2">
            {draft.comments.length === 0 && <p className="text-xs text-muted">没有评论。</p>}
            {draft.comments.map((comment, index) => (
              <div key={comment.id} className="rounded-md border border-line bg-elevated/50 p-2.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={comment.severity} />
                  <Badge tone="info">{comment.mqm}</Badge>
                  <code className="font-mono text-xs text-muted">
                    {comment.path}:{comment.line}
                  </code>
                  {comment.suspected === true && <Badge tone="warn">疑似</Badge>}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-danger"
                    title="删除该评论"
                    aria-label="删除该评论"
                    disabled={published}
                    onClick={() => onChange({ ...draft, comments: draft.comments.filter((_, current) => current !== index) })}
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </Button>
                </div>
                <code className="mb-1 block truncate font-mono text-xs text-muted" title={comment.key}>
                  {comment.key}
                </code>
                {(comment.en !== undefined || comment.zh !== undefined) && (
                  <div className="mb-2 grid gap-1 text-xs">
                    {comment.en !== undefined && (
                      <div className="flex gap-2">
                        <span className="w-10 shrink-0 text-muted">EN</span>
                        <span className="break-words">{comment.en}</span>
                      </div>
                    )}
                    {comment.zh !== undefined && (
                      <div className="flex gap-2">
                        <span className="w-10 shrink-0 text-muted">ZH</span>
                        <span className="break-words">{comment.zh}</span>
                      </div>
                    )}
                  </div>
                )}
                <Textarea
                  aria-label="评论内容"
                  className="min-h-20 text-xs"
                  value={comment.body}
                  disabled={published}
                  onChange={(event) => updateComment(index, { body: event.target.value })}
                />
                <Textarea
                  aria-label="修改建议"
                  className="mt-2 min-h-14 text-xs"
                  placeholder="修改建议（可选）"
                  value={comment.suggestion ?? ""}
                  disabled={published}
                  onChange={(event) => updateComment(index, { suggestion: event.target.value === "" ? undefined : event.target.value })}
                />
                <div className="mt-2 flex items-center gap-2">
                  <Select
                    wrapperClassName="w-28"
                    aria-label="严重程度"
                    options={SEVERITY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                    value={comment.severity}
                    disabled={published}
                    onChange={(event) => updateComment(index, { severity: event.target.value as Severity })}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardBody>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          {published && draft.publishedUrl !== undefined && (
            <a
              href={draft.publishedUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mr-auto inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              查看已发布的 Review
            </a>
          )}
          <Button
            icon={<Save aria-hidden="true" className="size-3.5" />}
            loading={saving}
            disabled={published}
            onClick={onSave}
          >
            保存草稿
          </Button>
          <Button
            variant="primary"
            icon={<Send aria-hidden="true" className="size-3.5" />}
            disabled={published}
            onClick={() => setConfirmOpen(true)}
          >
            发布
          </Button>
        </footer>
      </Card>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="确认发布审查"
        description={`将作为 Bot 向 PR #${draft.prNumber} 提交一条 Review，包含 ${draft.comments.length} 条行内评论。`}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={publishing}
              onClick={() => {
                setConfirmOpen(false);
                onPublish();
              }}
            >
              确认发布
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-xs text-muted">结论</div>
            <div className="mt-1">
              <VerdictBadge verdict={draft.verdict} />
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">总结</div>
            <pre className="mt-1 whitespace-pre-wrap rounded border border-line bg-elevated p-2 text-xs">{draft.summary}</pre>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">行内评论（{draft.comments.length}）</div>
            <ul className="flex flex-col gap-2">
              {draft.comments.map((comment) => (
                <li key={comment.id} className="rounded border border-line p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={comment.severity} />
                    <Badge tone="info">{comment.mqm}</Badge>
                    <code className="font-mono text-xs text-muted">
                      {comment.path}:{comment.line}
                    </code>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap text-xs">{comment.body}</pre>
                  {comment.suggestion !== undefined && (
                    <pre className="mt-1 whitespace-pre-wrap rounded border border-line bg-elevated p-1.5 text-xs">建议：{comment.suggestion}</pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Dialog>
    </>
  );
}
