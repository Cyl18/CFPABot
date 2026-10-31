import type { DraftComment, ReviewDraft, ReviewEvent, Severity } from "@cfpa/contracts/api";
import { REVIEW_EVENTS, REVIEW_EVENT_META, SEVERITIES, SEVERITY_META } from "@cfpa/contracts/api";
import { MQM_BY_ID, mqmLabel } from "@cfpa/contracts/mqm";
import { ExternalLink, Save, Send, Trash2, X } from "lucide-react";
import { useState } from "react";
import { EventBadge, SeverityBadge } from "@/components/StatusBadges.tsx";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { Textarea } from "@/ui/Input.tsx";
import { Select } from "@/ui/Select.tsx";

const EVENT_OPTIONS = REVIEW_EVENTS.map((value) => ({ value, label: `${REVIEW_EVENT_META[value].label}（${value}）` }));
const SEVERITY_OPTIONS = SEVERITIES.map((value) => ({ value, label: SEVERITY_META[value].label }));

export interface DraftPanelProps {
  draft: ReviewDraft;
  dirty: boolean;
  saving: boolean;
  publishing: boolean;
  error?: string;
  onChange: (draft: ReviewDraft) => void;
  onSave: () => void;
  onPublish: () => void;
  onClose(): void;
}

export function DraftPanel({ draft, dirty, saving, publishing, error, onChange, onSave, onPublish, onClose }: DraftPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const published = draft.publishedAt !== undefined;
  const readonly = published;
  const updateComment = (index: number, patch: Partial<DraftComment>) => {
    const comments = draft.comments.map((comment, current) => (current === index ? { ...comment, ...patch } : comment));
    onChange({ ...draft, comments });
  };

  const state = published ? <Badge tone="ok">已发布</Badge> : dirty ? <Badge tone="warn">未保存</Badge> : <Badge>已保存</Badge>;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-sm font-semibold">审查草稿</span>
          <EventBadge event={draft.event} />
          {state}
          <span className="ml-auto font-mono text-xs text-muted">PR #{draft.prNumber}</span>
          <Button variant="ghost" size="icon" onClick={onClose} title="关闭" aria-label="关闭">
            <X aria-hidden="true" className="size-4" />
          </Button>
        </header>

        <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error !== undefined && <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{error}</p>}

          <Select
            label="结论"
            options={EVENT_OPTIONS}
            value={draft.event}
            disabled={readonly}
            onChange={(event) => onChange({ ...draft, event: event.target.value as ReviewEvent })}
          />

          <Textarea
            label="总结"
            className="min-h-24 text-xs"
            value={draft.summary}
            disabled={readonly}
            onChange={(event) => onChange({ ...draft, summary: event.target.value })}
          />

          <div className="flex items-center justify-between text-xs text-muted">
            <span>行内评论</span>
            <span className="tabular-nums">{draft.comments.length} 条</span>
          </div>

          {draft.comments.length === 0 && <p className="text-xs text-muted">没有评论。</p>}

          {draft.comments.map((comment, index) => (
            <div key={comment.id} className="rounded-md border border-line bg-elevated/40 p-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <SeverityBadge severity={comment.severity} />
                <Badge tone="info" title={MQM_BY_ID.get(comment.mqm)?.rule}>
                  {mqmLabel(comment.mqm)}
                </Badge>
                {comment.suspected === true && <Badge tone="warn">疑似</Badge>}
                <code className="min-w-0 truncate font-mono text-[11px] text-muted" title={`${comment.path}:${comment.line ?? "文件级"}`}>
                  {comment.path}:{comment.line ?? "文件级"}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto shrink-0 text-danger"
                  title="删除该评论"
                  aria-label="删除该评论"
                  disabled={readonly}
                  onClick={() => onChange({ ...draft, comments: draft.comments.filter((_, current) => current !== index) })}
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </Button>
              </div>

              <code className="mb-1.5 block truncate font-mono text-[11px] text-muted" title={comment.key}>
                {comment.key}
              </code>

              {(comment.en !== undefined || comment.zh !== undefined) && (
                <div className="mb-2 grid gap-1 text-xs">
                  {comment.en !== undefined && (
                    <div className="flex gap-2">
                      <span className="w-6 shrink-0 text-muted">EN</span>
                      <span className="break-words">{comment.en}</span>
                    </div>
                  )}
                  {comment.zh !== undefined && (
                    <div className="flex gap-2">
                      <span className="w-6 shrink-0 text-muted">ZH</span>
                      <span className="break-words">{comment.zh}</span>
                    </div>
                  )}
                </div>
              )}

              <Textarea
                aria-label="评论内容"
                className="min-h-20 text-xs"
                value={comment.body}
                disabled={readonly}
                onChange={(event) => updateComment(index, { body: event.target.value })}
              />
              <Textarea
                aria-label="修改建议"
                className="mt-2 min-h-14 text-xs"
                placeholder="修改建议（可选）"
                value={comment.suggestion ?? ""}
                disabled={readonly}
                onChange={(event) => updateComment(index, { suggestion: event.target.value === "" ? undefined : event.target.value })}
              />
              <Select
                wrapperClassName="mt-2 w-28"
                aria-label="严重程度"
                options={SEVERITY_OPTIONS}
                value={comment.severity}
                disabled={readonly}
                onChange={(event) => updateComment(index, { severity: event.target.value as Severity })}
              />
            </div>
          ))}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          {published && draft.publishedUrl !== undefined && (
            <a
              href={draft.publishedUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              查看已发布的 Review
            </a>
          )}
          {!published && dirty && <span className="text-xs text-warn">有未保存的修改</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button icon={<Save aria-hidden="true" className="size-3.5" />} loading={saving} disabled={published || !dirty} onClick={onSave}>
              保存草稿
            </Button>
            <Button
              variant="primary"
              icon={<Send aria-hidden="true" className="size-3.5" />}
              loading={publishing}
              disabled={published || dirty || publishing}
              title={publishing ? "正在发布…" : dirty ? "先保存草稿再发布" : undefined}
              onClick={() => setConfirmOpen(true)}
            >
              发布
            </Button>
          </div>
        </footer>
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="确认发布审查"
        description={`将以 Bot 身份向 PR #${draft.prNumber} 提交 Review，包含 ${draft.comments.length} 条行内评论。`}
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
              <EventBadge event={draft.event} />
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
                    <Badge tone="info" title={MQM_BY_ID.get(comment.mqm)?.rule}>
                      {mqmLabel(comment.mqm)}
                    </Badge>
                    <code className="font-mono text-xs text-muted">
                      {comment.path}:{comment.line ?? "文件级"}
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
