export type SizeLabelTone = "ok" | "warn" | "danger";

export interface SizeLabel {
  /** 打出去的 GitHub 标签名，也是排序与着色的键。 */
  name: string;
  min: number;
  tone: SizeLabelTone;
}

export const SIZE_LABELS: readonly SizeLabel[] = [
  { name: "1+", min: 0, tone: "ok" },
  { name: "10+", min: 10, tone: "ok" },
  { name: "40+", min: 40, tone: "ok" },
  { name: "100+", min: 100, tone: "ok" },
  { name: "500+", min: 500, tone: "warn" },
  { name: "1000+", min: 1000, tone: "warn" },
  { name: "2000+", min: 2000, tone: "danger" },
  { name: "5000+", min: 5000, tone: "danger" },
];
