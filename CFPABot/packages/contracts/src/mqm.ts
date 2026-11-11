export interface MqmDimensionInfo {
  id: string;
  label: string;
  scope: string;
}

export const MQM_DIMENSIONS = [
  { id: "accuracy", label: "准确", scope: "只判命题内容、言外之意与术语，不判句子顺不顺" },
  { id: "fluency", label: "通顺", scope: "只判句子是否成立、自然、可读，不判意思对不对" },
  { id: "fit", label: "得体", scope: "只判这话放在这个位置、这个场景合不合适，不判意思对不对" },
  { id: "design", label: "排版", scope: "只判占位符、格式码、格式约定和长度，不判措辞" },
  { id: "neutral", label: "中性", scope: "不判译文过错，不作扣分；仅用于记录上游缺陷或发起问询" },
] as const satisfies readonly MqmDimensionInfo[];

export type MqmDimension = (typeof MQM_DIMENSIONS)[number]["id"];

export interface MqmType {
  /** 草稿 mqm 字段的取值，形如 `<dim>/<type>`。 */
  id: string;
  dim: MqmDimension;
  label: string;
  rule: string;
}

export const MQM_TYPES = [
  { id: "accuracy/mistranslation", dim: "accuracy", label: "错译", rule: "译文把原文的否定、指称、数量、关系或反义译错了" },
  { id: "accuracy/omission", dim: "accuracy", label: "漏译", rule: "译文丢了原文的整句、从句、限定成分或条件，甚至整条输出为空" },
  { id: "accuracy/addition", dim: "accuracy", label: "增译", rule: "译文多出原文没有的解释、额外推测或私货，擅自破坏信息差、叙事留白；必要的语法显化、或为满足控件功能所作的改写增补（参见 `fit/function`）不算增译" },
  { id: "accuracy/untranslated", dim: "accuracy", label: "未译", rule: "该译的内容仍是英文；品牌名、模组名、代码变量和刻意保留的部分不算未译" },
  { id: "accuracy/do-not-translate", dim: "accuracy", label: "应留原文", rule: "译文译出了保留清单里明确要求保留原样的内容" },
  { id: "accuracy/terminology", dim: "accuracy", label: "术语不符", rule: "译名与给出的参考术语表、社区常用译法不符；译文在同词多义时选错了义项" },

  { id: "fluency/grammar", dim: "fluency", label: "语法", rule: "译文句子成分残缺、语序颠倒、主谓/动宾搭配不当" },
  { id: "fluency/awkward", dim: "fluency", label: "生硬", rule: "译文句子语法成立，但读来有浓重翻译腔，显得冗余、生硬或拗口；常见于机械直译导致的冗余堆砌，如“对敌人进行攻击”（应直接为“攻击敌人”）、“当被右击时”（过度被动）、“点击它以将其激活”（代词赘余）、或长定语层层套“的”" },
  { id: "fluency/punctuation", dim: "fluency", label: "标点", rule: "译文标点误用，引号或括号不配对，句末标点缺失，断句读错" },
  { id: "fluency/typo", dim: "fluency", label: "错别字", rule: "译文出现错字、别字、拼音同音误选或形近字误用" },

  { id: "fit/function", dim: "fit", label: "功能不符", rule: "译文没有履行该场景下的职责；`Yes / No`：对话里可译作“好/不”“好的/不要”，按钮上应译作“是/否”；`Keep Off the Grass`：按字面是“远离草地”，立在草地上作为告示语则应表达为“请勿践踏草坪”；导航控件的 `Back` 应译作“返回”，而非“后方”" },
  { id: "fit/register", dim: "fit", label: "语域不符", rule: "译文的文白程度与称谓层级不合文本类型或既有口吻，休闲文案用了书面语，你/您混用" },
  { id: "fit/tone", dim: "fit", label: "语气不符", rule: "译文没译出原文的讽刺、紧急、玩笑、亲昵、威严或傲慢语气" },
  { id: "fit/culture", dim: "fit", label: "文化错位", rule: "译文意象与虚构设定或目标文化冲突；中世纪奇幻里出现了现代网络用语，西幻里出现了中式典故" },
  { id: "fit/convention", dim: "fit", label: "体例不符", rule: "译文违反了项目风格指南（STYLE.md）约定的构词规范、句式体例或交互文本标准；构词法不合规范（如物品/实体命名未遵从统一构词，动名词与动宾短语混用）；同类交互文本句式模板不一（如 Tooltip、按键引导在祈使句、短语和完整句之间混杂）；常见系统提示或操作引导未采用项目约定的统一样板句式，被随意自由发挥" },

  { id: "design/markup", dim: "design", label: "标记错误", rule: "译文里的占位符、格式码或标签有缺失、错位或语义错误；如 `%s`, `{0}`, `\\n`, `§a`, `<color>`" },
  { id: "design/format", dim: "design", label: "格式不符", rule: "全半角、中英混排空格或大小写与项目约定不符" },
  { id: "design/length", dim: "design", label: "长度超限", rule: "译文超出按钮、提示框、物品名或界面的可用显示物理长度，导致截断或遮挡" },

  { id: "neutral/source", dim: "neutral", label: "原文问题", rule: "原文本身有错误、歧义、占位符不全或不适宜内容" },
  { id: "neutral/query", dim: "neutral", label: "存疑", rule: "校对端无法单方面结案、需提示人工介入的事项；译文处理反常需核实译者意图、缺失上下文无法断定、或存在多种合理译法需人工拍板定夺；凡依据已有规则或上下文足以确诊的，必须直接归入对应错误类型，不得滥用存疑" },
] as const satisfies readonly MqmType[];

export const MQM_BY_ID: ReadonlyMap<string, MqmType> = new Map(MQM_TYPES.map((type) => [type.id, type]));

export function mqmLabel(id: string): string {
  return MQM_BY_ID.get(id)?.label ?? id;
}

/** 子代理系统提示与草稿 schema 共用这一份，词表只从 MQM_TYPES 来。 */
export function mqmTable(): string {
  return MQM_TYPES.map((type) => `${type.id} ${type.label} — ${type.rule}`).join("\n");
}
