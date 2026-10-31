import type { Severity } from "./api.ts";

export type MqmDimension = "accuracy" | "terminology" | "fluency" | "style" | "locale" | "design" | "source";

export interface MqmDimensionInfo {
  id: MqmDimension;
  label: string;
  scope: string;
}

export interface MqmType {
  /** 草稿 mqm 字段的取值，形如 `<dim>/<type>`。 */
  id: string;
  dim: MqmDimension;
  label: string;
  /** 默认档位；实际档位按后果定，检查器只对低于默认档的条目给提示。 */
  severity: Severity;
  rule: string;
}

export const MQM_DIMENSIONS: readonly MqmDimensionInfo[] = [
  { id: "accuracy", label: "准确", scope: "译文与原文的意思关系" },
  { id: "terminology", label: "术语", scope: "与术语资源、全库用法的一致性" },
  { id: "fluency", label: "流畅", scope: "中文本身读不读得通" },
  { id: "style", label: "风格", scope: "语气、语域与项目体例" },
  { id: "locale", label: "本地化格式", scope: "占位符、格式码、数字单位" },
  { id: "design", label: "呈现", scope: "玩家在界面里看到的后果" },
  { id: "source", label: "原文", scope: "上游文本自身的问题，不计在译者头上" },
];

export const MQM_TYPES = [
  { id: "accuracy/mistranslation", dim: "accuracy", label: "错译", severity: "major", rule: "译文与原意不符" },
  { id: "accuracy/omission", dim: "accuracy", label: "漏译", severity: "major", rule: "原文有信息没落地" },
  { id: "accuracy/addition", dim: "accuracy", label: "擅加", severity: "minor", rule: "译出原文没有的信息" },
  { id: "accuracy/untranslated", dim: "accuracy", label: "应译未译", severity: "major", rule: "正文仍是英文" },
  { id: "accuracy/overly-literal", dim: "accuracy", label: "死译", severity: "minor", rule: "逐词对应，中文不成句" },
  { id: "accuracy/wrong-entry", dim: "accuracy", label: "串条", severity: "major", rule: "译文对不上本条 key" },
  { id: "accuracy/reversed", dim: "accuracy", label: "反义", severity: "critical", rule: "否定、方向或因果被译反" },

  { id: "terminology/wrong-term", dim: "terminology", label: "错术语", severity: "major", rule: "用了别的词指同一个概念" },
  { id: "terminology/inconsistent", dim: "terminology", label: "术语不一致", severity: "major", rule: "同一概念全库多种译法" },
  { id: "terminology/inappropriate", dim: "terminology", label: "术语误用", severity: "major", rule: "术语放进不适用的语境" },
  { id: "terminology/resource", dim: "terminology", label: "违反术语资源", severity: "minor", rule: "与词典、原版或术语表不符" },

  { id: "fluency/punctuation", dim: "fluency", label: "标点", severity: "minor", rule: "中英标点混用、句末标点缺失或叠加" },
  { id: "fluency/spacing", dim: "fluency", label: "空格", severity: "minor", rule: "汉字之间、原子前后的多余空格" },
  { id: "fluency/grammar", dim: "fluency", label: "语法", severity: "minor", rule: "缺成分、搭配不通" },
  { id: "fluency/word-order", dim: "fluency", label: "语序", severity: "minor", rule: "中文语序别扭" },
  { id: "fluency/typo", dim: "fluency", label: "错字", severity: "minor", rule: "错别字、同音字" },
  { id: "fluency/encoding", dim: "fluency", label: "字符编码", severity: "minor", rule: "乱码、替换字符、异体字" },

  { id: "style/awkward", dim: "style", label: "生硬", severity: "minor", rule: "读得通但翻译腔" },
  { id: "style/inconsistent", dim: "style", label: "体例不一", severity: "minor", rule: "同类条目前后风格分裂" },
  { id: "style/house-style", dim: "style", label: "违反项目体例", severity: "minor", rule: "违反 TransRules 或本模组约定" },
  { id: "style/register", dim: "style", label: "语域漂移", severity: "major", rule: "角色声音、敬称、粗俗度偏离原作" },

  { id: "locale/placeholder", dim: "locale", label: "占位符", severity: "critical", rule: "占位符的数量、顺序或签名不符" },
  { id: "locale/format-code", dim: "locale", label: "格式码", severity: "major", rule: "§ 码、换行、标签被改动" },
  { id: "locale/units", dim: "locale", label: "单位", severity: "minor", rule: "计量单位与原文不符" },
  { id: "locale/number", dim: "locale", label: "数字日期", severity: "minor", rule: "数值或日期格式被改写" },
  { id: "locale/fullwidth", dim: "locale", label: "全半角", severity: "minor", rule: "该全角用了半角，或相反" },

  { id: "design/overflow", dim: "design", label: "截断溢出", severity: "major", rule: "按钮、页签、物品名超长" },
  { id: "design/glyph", dim: "design", label: "缺字形", severity: "major", rule: "字符在游戏字体中缺失" },
  { id: "design/markup", dim: "design", label: "标记破坏", severity: "major", rule: "闭合、转义或 JSON 结构被破坏" },

  { id: "source/defect", dim: "source", label: "原文有误", severity: "neutral", rule: "上游英文错误、歧义或占位符不全" },
] as const satisfies readonly MqmType[];

export const MQM_BY_ID: ReadonlyMap<string, MqmType> = new Map(MQM_TYPES.map((type) => [type.id, type]));

export function mqmLabel(id: string): string {
  return MQM_BY_ID.get(id)?.label ?? id;
}

/** 子代理系统提示与草稿 schema 共用这一份，词表只从 MQM_TYPES 来。 */
export function mqmTable(): string {
  return MQM_TYPES.map((type) => `${type.id} ${type.label} ${type.severity} — ${type.rule}`).join("\n");
}
