import type { CompareRow } from "@cfpa/contracts/api";
import type { DiffCell, DiffEntry, DiffLane } from "@cfpa/contracts/diffview";

function cellOf(en: string | undefined, zh: string | undefined): DiffCell | null {
  return en === undefined && zh === undefined ? null : { en: en ?? "", zh: zh ?? null };
}

export function compareLanes(rows: readonly CompareRow[], n: number): DiffLane[] {
  const hasZh = (side: "base" | "head") => rows.some((row) => (side === "base" ? row.baseZh : row.headZh) !== undefined);
  const base = rows.some((row) => row.baseEn !== undefined || row.baseZh !== undefined);
  const head = rows.some((row) => row.headEn !== undefined || row.headZh !== undefined);
  const whole = base === head ? null : head ? ("insert" as const) : ("delete" as const);
  return [
    {
      id: "base",
      label: "main",
      role: "ref",
      zhFile: hasZh("base"),
      title: "main 分支的这份文件",
      absent: !base,
      ...(whole === "delete" ? { whole } : {}),
    },
    {
      id: "head",
      label: "PR",
      role: "real",
      highlight: true,
      zhFile: hasZh("head"),
      title: `PR #${n} 里的这份文件`,
      absent: !head,
      ...(whole === "insert" ? { whole } : {}),
    },
  ];
}

export function compareEntries(rows: readonly CompareRow[]): DiffEntry[] {
  return rows.map((row) => ({
    key: row.key,
    cells: {
      base: cellOf(row.baseEn, row.baseZh),
      head: cellOf(row.headEn, row.headZh),
    },
    status: { en: row.enStatus, zh: row.zhStatus },
  }));
}
