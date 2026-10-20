import { cn } from "@/lib/cn.ts";
import { DIFF_MODES, useDiffMode } from "@/lib/diffMode.ts";
import { Popover } from "@/ui/Popover.tsx";

const SIZES = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
  md: "h-9 gap-1.5 rounded-lg px-3 text-sm",
};

export function DiffModePicker({ className, size = "md" }: { className?: string; size?: keyof typeof SIZES }) {
  const [mode, setMode] = useDiffMode();
  const current = DIFF_MODES.find((item) => item.id === mode);

  return (
    <span className={className}>
      <Popover
        label="差分模式"
        trigger={
          <span
            className={cn(
              "inline-flex items-center border border-line bg-surface text-muted transition-colors hover:border-accent/50 hover:text-fg",
              SIZES[size],
            )}
          >
            差分模式
            <span className="font-medium text-accent">{current?.label}</span>
          </span>
        }
      >
        <p className="mb-2 text-xs text-muted">差分模式</p>
        <ul aria-label="差分模式" className="flex flex-col gap-0.5">
          {DIFF_MODES.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-elevated">
                <input
                  type="radio"
                  name="diff-mode"
                  className="accent-accent"
                  checked={item.id === mode}
                  onChange={() => setMode(item.id)}
                />
                <span className={cn(item.id === mode && "font-medium text-accent")}>{item.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </Popover>
    </span>
  );
}
