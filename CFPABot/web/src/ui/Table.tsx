import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn.ts";

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  width?: number;
  align?: "left" | "right" | "center";
  hideBelow?: "md" | "lg" | "xl";
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
  rowHeight?: number;
  valign?: "top" | "middle";
  framed?: boolean;
  rowClassName?: (row: T) => string | undefined;
}

const VIRTUAL_THRESHOLD = 200;
const FLEX_MIN_WIDTH = 240;

const BREAKPOINT_RANK = { md: 1, lg: 2, xl: 3 } as const satisfies Record<NonNullable<Column<unknown>["hideBelow"]>, number>;

function subscribeResize(callback: () => void): () => void {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

function viewportRank(): number {
  if (window.innerWidth >= 1280) return 3;
  if (window.innerWidth >= 1024) return 2;
  if (window.innerWidth >= 768) return 1;
  return 0;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  ariaLabel,
  empty,
  virtualize,
  rowHeight = 37,
  valign = "top",
  framed = true,
  rowClassName,
}: DataTableProps<T>) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtual = virtualize ?? rows.length > VIRTUAL_THRESHOLD;

  useLayoutEffect(() => {
    if (!virtual) return;
    const top = (tableRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
    if (Math.abs(top - scrollMargin) > 1) setScrollMargin(top);
  });

  const shared = {
    count: rows.length,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (index: number) => rowKey(rows[index] as T, index),
  };
  const virtualizer = useWindowVirtualizer<HTMLTableRowElement>({
    ...shared,
    scrollMargin,
    enabled: virtual,
  });

  const rank = useSyncExternalStore(subscribeResize, viewportRank);
  const visible = columns.filter((column) => column.hideBelow === undefined || rank >= BREAKPOINT_RANK[column.hideBelow]);
  const minWidth = visible.reduce((sum, column) => sum + (column.width ?? FLEX_MIN_WIDTH), 0);
  const columnClasses = visible.map((column) => cn(column.align === "right" && "text-right tabular-nums", column.align === "center" && "text-center"));

  const renderRow = (row: T, index: number, measured: boolean) => (
    <tr
      key={rowKey(row, index)}
      ref={measured ? virtualizer.measureElement : undefined}
      data-index={measured ? index : undefined}
      className={cn("group/row transition-colors hover:bg-elevated/60", rowClassName?.(row))}
    >
      {visible.map((column, columnIndex) => (
        <td
          key={column.id}
          className={cn(
            "border-b border-line px-3 py-2 group-last/row:border-b-0",
            valign === "middle" ? "align-middle" : "align-top",
            columnClasses[columnIndex],
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
  const padTop = first ? first.start - scrollMargin : 0;
  const padBottom = last ? virtualizer.getTotalSize() - (last.end - scrollMargin) : 0;

  return (
    <div className={cn("scroll-thin relative bg-surface max-md:overflow-x-auto", framed && "rounded-lg border border-line")}>
      <table
        ref={tableRef}
        className="w-full table-fixed border-separate border-spacing-0 text-sm"
        style={{ minWidth }}
        aria-label={ariaLabel}
      >
        <thead className="sticky z-10 top-0 max-lg:top-14 max-md:top-0">
          <tr>
            {visible.map((column, columnIndex) => (
              <th
                key={column.id}
                scope="col"
                style={column.width !== undefined ? { width: column.width } : undefined}
                className={cn(
                  "h-9 whitespace-nowrap border-b border-line bg-elevated px-3 text-left align-middle text-xs font-medium text-muted",
                  framed && "first:rounded-tl-lg last:rounded-tr-lg",
                  columnClasses[columnIndex],
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
              <td colSpan={visible.length} className="px-3 py-10 text-center text-sm text-muted">
                {empty ?? "暂无数据"}
              </td>
            </tr>
          )}
          {padTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={visible.length} style={{ height: padTop, padding: 0, border: "none" }} />
            </tr>
          )}
          {virtual ? virtualItems.map((item) => renderRow(rows[item.index] as T, item.index, true)) : rows.map((row, index) => renderRow(row, index, false))}
          {padBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={visible.length} style={{ height: padBottom, padding: 0, border: "none" }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
