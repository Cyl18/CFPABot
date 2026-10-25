export type SizeLabelTone = "ok" | "warn" | "danger";

export interface SizeLabel {
  name: string;
  min: number;
  max: number;
  tone: SizeLabelTone;
}

export const SIZE_LABELS: readonly SizeLabel[] = [
  { name: "1+", min: 0, max: 10, tone: "ok" },
  { name: "10+", min: 10, max: 40, tone: "ok" },
  { name: "40+", min: 40, max: 100, tone: "ok" },
  { name: "100+", min: 100, max: 500, tone: "ok" },
  { name: "500+", min: 500, max: 1000, tone: "warn" },
  { name: "1000+", min: 1000, max: 2000, tone: "warn" },
  { name: "2000+", min: 2000, max: 5000, tone: "danger" },
  { name: "5000+", min: 5000, max: Number.MAX_SAFE_INTEGER, tone: "danger" },
];
