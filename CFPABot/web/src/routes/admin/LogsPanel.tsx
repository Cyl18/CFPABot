import type { LogLevel } from "@cfpa/contracts/api";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { formatJson } from "@/lib/format.ts";
import { useLogs } from "@/lib/queries.ts";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Checkbox } from "@/ui/Input.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const LEVELS: readonly { value: LogLevel | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "error", label: "Error" },
  { value: "warn", label: "Warn" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
];

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: "text-danger",
  warn: "text-warn",
  info: "text-info",
  debug: "text-muted",
};

export function LogsPanel() {
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logs = useLogs(level, autoRefresh);

  return (
    <Card>
      <CardHeader
        title="事件日志"
        description={`${logs.data?.length ?? 0} 条`}
        actions={
          <>
            <div role="group" aria-label="日志级别筛选" className="flex flex-wrap gap-1">
              {LEVELS.map((option) => (
                <ToggleChip key={option.value} pressed={level === option.value} onClick={() => setLevel(option.value)}>
                  {option.label}
                </ToggleChip>
              ))}
            </div>
            <Checkbox label="自动刷新" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <Button size="sm" icon={<RefreshCw aria-hidden="true" className="size-3.5" />} onClick={() => void logs.refetch()}>
              刷新
            </Button>
          </>
        }
      />
      <CardBody>
        {logs.error !== null ? (
          <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
        ) : logs.isPending ? (
          <SkeletonText lines={10} />
        ) : (logs.data?.length ?? 0) === 0 ? (
          <EmptyState title="暂无日志" compact />
        ) : (
          <ul className="rounded-md border border-line bg-elevated/40 p-2 font-mono text-xs">
            {logs.data?.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="border-b border-line/60 py-1 last:border-b-0">
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-2">
                    {entry.data !== undefined && Object.keys(entry.data).length > 0 && (
                      <ChevronRight aria-hidden="true" className="size-3 text-muted transition-transform group-open:rotate-90" />
                    )}
                    <span className="text-muted">{entry.at.slice(11, 19)}</span>
                    <span className={cn("font-semibold uppercase", LEVEL_COLOR[entry.level])}>{entry.level}</span>
                    <span className="text-muted">[{entry.scope}]</span>
                    <span className="break-all">{entry.message}</span>
                  </summary>
                  {entry.data !== undefined && Object.keys(entry.data).length > 0 && (
                    <pre className="scroll-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface p-2">
                      {formatJson(entry.data)}
                    </pre>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
