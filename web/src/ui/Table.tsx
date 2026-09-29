import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";
import { useRef } from "react";
import { cn } from "@/lib/cn.ts";

const CELL = "border-b border-line px-3 py-1.5 align-top";

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  width?: number | string;
  align?: "left" | "right" | "center";
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  ariaLabel: string;
  empty?: ReactNode;
  virtualize?: boolean;
  height?: string;
  rowHeight?: number;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
}

const VIRTUAL_THRESHOLD = 200;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  ariaLabel,
  empty,
  virtualize,
  height = "70vh",
  rowHeight = 34,
  rowClassName,
  className,
}: DataTableProps<T>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtual = virtualize ?? rows.length > VIRTUAL_THRESHOLD;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    enabled: virtual,
    getItemKey: (index) => rowKey(rows[index] as T, index),
  });

  const renderRow = (row: T, index: number, measured: boolean) => (
    <tr
      key={rowKey(row, index)}
      ref={measured ? virtualizer.measureElement : undefined}
      data-index={measured ? index : undefined}
      className={cn("hover:bg-elevated/60", rowClassName?.(row))}
    >
      {columns.map((column) => (
        <td
          key={column.id}
          className={cn(
            CELL,
            column.align === "right" && "text-right tabular-nums",
            column.align === "center" && "text-center",
            column.className,
          )}
        >
          {column.cell(row, index)}
        </td>
      ))}
    </tr>
  );

  const virtualItems = virtual ? virtualizer.getVirtualItems() : [];
  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  const padTop = first ? first.start : 0;
  const padBottom = last ? virtualizer.getTotalSize() - last.end : 0;

  return (
    <div
      ref={scrollRef}
      className={cn("scroll-thin relative overflow-auto rounded-lg border border-line bg-surface", className)}
      style={virtual ? { maxHeight: height } : undefined}
    >
      <table className="w-full border-collapse text-sm" aria-label={ariaLabel}>
        <thead className="sticky top-0 z-10 bg-elevated">
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                style={column.width !== undefined ? { width: column.width } : undefined}
                className={cn(
                  "whitespace-nowrap border-b border-line px-3 py-2 text-left text-xs font-semibold text-muted",
                  column.align === "right" && "text-right",
                  column.align === "center" && "text-center",
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-muted">
                {empty ?? "暂无数据"}
              </td>
            </tr>
          )}
          {padTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: padTop, padding: 0, border: "none" }} />
            </tr>
          )}
          {virtual ? virtualItems.map((item) => renderRow(rows[item.index] as T, item.index, true)) : rows.map((row, index) => renderRow(row, index, false))}
          {padBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: padBottom, padding: 0, border: "none" }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
