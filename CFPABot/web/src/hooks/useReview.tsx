import type { FileViewedState, PrReviewState, ReviewEvent, ReviewHtmlResult, ReviewThread } from "@cfpa/contracts/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, isApiError } from "@/lib/api.ts";
import { qk, useMe } from "@/lib/queries.ts";

export type ReviewAccess = "anonymous" | "reauth" | "ready";

export interface OutgoingComment {
  id: string;
  path: string;
  line: number;
  body: string;
  error: string | null;
}

export interface ReviewApi {
  n: number;
  state: PrReviewState | undefined;
  access: ReviewAccess;
  syncing: boolean;
  failure: string | null;
  dismissFailure: () => void;
  pendingCount: number;
  failedCount: number;
  threadsAt: (path: string, line: number) => readonly ReviewThread[];
  threadsOf: (path: string) => readonly ReviewThread[];
  outgoingAt: (path: string, line: number) => readonly OutgoingComment[];
  /** 待提交的本地评论；身份稳定，可作 memo 依赖。 */
  outgoing: readonly OutgoingComment[];
  deleting: ReadonlySet<string>;
  viewedOf: (path: string) => FileViewedState;
  setViewed: (path: string, viewed: boolean) => void;
  addComment: (path: string, line: number, body: string) => void;
  retryComment: (id: string) => void;
  discardComment: (id: string) => void;
  deleteComment: (id: string) => void;
  resolveThread: (id: string, resolved: boolean) => void;
  replyToThread: (id: string, body: string) => Promise<void>;
  submit: (event: ReviewEvent, body: string) => Promise<{ url: string }>;
  isOpen: (path: string, line: number) => boolean;
  setOpen: (path: string, line: number, open: boolean) => void;
  draftOf: (path: string, line: number) => string;
  setDraft: (path: string, line: number, text: string) => void;
}

const ReviewContext = createContext<ReviewApi | null>(null);

const EMPTY: readonly never[] = [];

function spot(path: string, line: number): string {
  return `${path}\u0000${line}`;
}

function withoutComment(state: PrReviewState, id: string): PrReviewState {
  return {
    ...state,
    threads: state.threads
      .map((thread) => ({ ...thread, comments: thread.comments.filter((comment) => comment.id !== id) }))
      .filter((thread) => thread.comments.length > 0),
  };
}

export function ReviewProvider({ n, children }: { n: number; children: ReactNode }) {
  const client = useQueryClient();
  const me = useMe();
  const query = useQuery<PrReviewState>({ queryKey: qk.review(n), queryFn: ({ signal }) => api.review(n, signal), staleTime: 30_000 });
  const state = query.data;

  const chain = useRef<Promise<void>>(Promise.resolve());
  const inflight = useRef(0);
  const [syncing, setSyncing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [outgoing, setOutgoing] = useState<OutgoingComment[]>([]);
  const [viewedOverride, setViewedOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpenSet] = useState<ReadonlySet<string>>(new Set());
  const drafts = useRef(new Map<string, string>());
  const sequence = useRef(0);

  const enqueue = useCallback(
    <T,>(task: () => Promise<T>): Promise<T> => {
      inflight.current += 1;
      setSyncing(true);
      void client.cancelQueries({ queryKey: qk.review(n) });
      const run = chain.current.then(task);
      const settle = () => {
        inflight.current -= 1;
        if (inflight.current > 0) return;
        void client.invalidateQueries({ queryKey: qk.review(n) }).then(() => {
          if (inflight.current > 0) return;
          setSyncing(false);
          setViewedOverride(new Map());
        });
      };
      chain.current = run.then(settle, settle);
      return run;
    },
    [client, n],
  );

  const reportError = useCallback((err: unknown, prefix: string) => {
    if (isApiError(err) && err.code === "reauth") setNeedsReauth(true);
    setFailure(`${prefix}：${errorMessage(err)}`);
  }, []);

  const send = useCallback(
    (item: OutgoingComment) => {
      enqueue(() => api.addReviewComment(n, { path: item.path, line: item.line, body: item.body })).then(
        (thread) => {
          client.setQueryData<PrReviewState>(qk.review(n), (old) =>
            old === undefined ? old : { ...old, threads: [...old.threads.filter((one) => one.id !== thread.id), thread] },
          );
          setOutgoing((list) => list.filter((one) => one.id !== item.id));
        },
        (err: unknown) => {
          if (isApiError(err) && err.code === "reauth") setNeedsReauth(true);
          setOutgoing((list) => list.map((one) => (one.id === item.id ? { ...one, error: errorMessage(err) } : one)));
        },
      );
    },
    [client, enqueue, n],
  );

  const addComment = useCallback(
    (path: string, line: number, body: string) => {
      sequence.current += 1;
      const item: OutgoingComment = { id: `local-${sequence.current}`, path, line, body, error: null };
      setOutgoing((list) => [...list, item]);
      send(item);
    },
    [send],
  );

  const retryComment = useCallback(
    (id: string) => {
      const item = outgoing.find((one) => one.id === id);
      if (item === undefined) return;
      const next = { ...item, error: null };
      setOutgoing((list) => list.map((one) => (one.id === id ? next : one)));
      send(next);
    },
    [outgoing, send],
  );

  const discardComment = useCallback((id: string) => setOutgoing((list) => list.filter((one) => one.id !== id)), []);

  const deleteComment = useCallback(
    (id: string) => {
      setDeleting((set) => new Set(set).add(id));
      const done = () =>
        setDeleting((set) => {
          const next = new Set(set);
          next.delete(id);
          return next;
        });
      enqueue(() => api.deleteReviewComment(n, id)).then(
        () => {
          client.setQueryData<PrReviewState>(qk.review(n), (old) => (old === undefined ? old : withoutComment(old, id)));
          done();
        },
        (err: unknown) => {
          done();
          reportError(err, "删除评论失败");
        },
      );
    },
    [client, enqueue, n, reportError],
  );

  const patchThread = useCallback(
    (id: string, patch: (thread: ReviewThread) => ReviewThread) => {
      client.setQueryData<PrReviewState>(qk.review(n), (old) =>
        old === undefined
          ? old
          : { ...old, threads: old.threads.map((thread) => (thread.id === id ? patch(thread) : thread)) },
      );
    },
    [client, n],
  );

  const resolveThread = useCallback(
    (id: string, resolved: boolean) => {
      patchThread(id, (thread) => ({ ...thread, resolved }));
      enqueue(() => api.setThreadResolved(n, id, { resolved })).catch((err: unknown) => {
        patchThread(id, (thread) => ({ ...thread, resolved: !resolved }));
        reportError(err, resolved ? "标记已解决失败" : "重新打开失败");
      });
    },
    [enqueue, n, patchThread, reportError],
  );

  const replyToThread = useCallback(
    (id: string, body: string) =>
      enqueue(() => api.addReviewReply(n, id, { body })).then(
        (comment) => {
          patchThread(id, (thread) => ({ ...thread, comments: [...thread.comments, comment] }));
          void client.invalidateQueries({ queryKey: qk.threadHtml(n, id) });
        },
        (err: unknown) => {
          reportError(err, "回复失败");
          throw err;
        },
      ),
    [enqueue, n, patchThread, reportError],
  );

  const setViewed = useCallback(
    (path: string, viewed: boolean) => {
      setViewedOverride((map) => new Map(map).set(path, viewed));
      enqueue(() => api.setFileViewed(n, { path, viewed })).catch((err: unknown) => {
        setViewedOverride((map) => {
          const next = new Map(map);
          next.delete(path);
          return next;
        });
        reportError(err, viewed ? "标记已看失败" : "取消已看失败");
      });
    },
    [enqueue, n, reportError],
  );

  const submit = useCallback(
    (event: ReviewEvent, body: string) =>
      enqueue(() => api.submitReview(n, { event, body })).catch((err: unknown) => {
        if (isApiError(err) && err.code === "reauth") setNeedsReauth(true);
        throw err;
      }),
    [enqueue, n],
  );

  const index = useMemo(() => {
    const byLine = new Map<string, ReviewThread[]>();
    const byPath = new Map<string, ReviewThread[]>();
    for (const thread of state?.threads ?? []) {
      const comments = thread.comments.filter((comment) => !deleting.has(comment.id));
      if (comments.length === 0) continue;
      const shown = comments.length === thread.comments.length ? thread : { ...thread, comments };
      const all = byPath.get(thread.path) ?? [];
      all.push(shown);
      byPath.set(thread.path, all);
      if (thread.line === null) continue;
      const key = spot(thread.path, thread.line);
      const list = byLine.get(key) ?? [];
      list.push(shown);
      byLine.set(key, list);
    }
    return { byLine, byPath };
  }, [state, deleting]);

  const outgoingIndex = useMemo(() => {
    const map = new Map<string, OutgoingComment[]>();
    for (const item of outgoing) {
      const key = spot(item.path, item.line);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, [outgoing]);

  const pendingOnServer = useMemo(() => {
    let count = 0;
    for (const thread of state?.threads ?? []) {
      for (const comment of thread.comments) if (comment.pending && comment.mine && !deleting.has(comment.id)) count += 1;
    }
    return count;
  }, [state, deleting]);

  const user = me.data ?? null;
  const access: ReviewAccess = user === null ? "anonymous" : needsReauth || (state !== undefined && state.viewer === null) ? "reauth" : "ready";

  const value: ReviewApi = {
    n,
    state,
    access,
    syncing,
    failure,
    dismissFailure: () => setFailure(null),
    pendingCount: pendingOnServer + outgoing.filter((item) => item.error === null).length,
    failedCount: outgoing.filter((item) => item.error !== null).length,
    threadsAt: (path, line) => index.byLine.get(spot(path, line)) ?? EMPTY,
    threadsOf: (path) => index.byPath.get(path) ?? EMPTY,
    outgoingAt: (path, line) => outgoingIndex.get(spot(path, line)) ?? EMPTY,
    outgoing,
    deleting,
    viewedOf: (path) => {
      const override = viewedOverride.get(path);
      if (override !== undefined) return override ? "VIEWED" : "UNVIEWED";
      return state?.viewed[path] ?? "UNVIEWED";
    },
    setViewed,
    addComment,
    retryComment,
    discardComment,
    deleteComment,
    resolveThread,
    replyToThread,
    submit,
    isOpen: (path, line) => open.has(spot(path, line)),
    setOpen: (path, line, next) =>
      setOpenSet((set) => {
        const key = spot(path, line);
        if (set.has(key) === next) return set;
        const copy = new Set(set);
        if (next) copy.add(key);
        else copy.delete(key);
        return copy;
      }),
    draftOf: (path, line) => drafts.current.get(spot(path, line)) ?? "",
    setDraft: (path, line, text) => {
      const key = spot(path, line);
      if (text === "") drafts.current.delete(key);
      else drafts.current.set(key, text);
    },
  };

  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewApi {
  const value = useContext(ReviewContext);
  if (value === null) throw new Error("useReview 必须在 ReviewProvider 内使用");
  return value;
}

const EMPTY_HTML: Record<string, string> = {};

export function useThreadHtml(threadId: string, ids: readonly string[], enabled: boolean): Record<string, string> {
  const { n } = useReview();
  const query = useQuery<ReviewHtmlResult>({
    queryKey: qk.threadHtml(n, threadId),
    queryFn: () => api.reviewHtml(n, { ids: [...ids] }),
    enabled: enabled && ids.length > 0,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return query.data?.html ?? EMPTY_HTML;
}
