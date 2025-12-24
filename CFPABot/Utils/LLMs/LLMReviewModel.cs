using System.Collections.Generic;

namespace CFPABot.Utils.LLMs
{
    enum ImportanceLevel { Low, Medium, High }

    // 条目类型（本地分类，不让 LLM 猜）
    enum EntryKind { Block, Item, Entity, Subtitle, Tooltip, Ui, Advancement, Config, Command, Misc }

    // 本地预检查结果（确定性）
    sealed class PrecheckResult
    {
        public bool JsonValid;
        public bool PlaceholdersMatch;
        public bool FormattingTokensMatch;
        public bool HasSuspiciousWhitespace;
        public List<string> Errors;   // 例如：缺少 %s、§ 颜色码不一致
        public List<string> Warnings; // 例如：首尾空格、全角半角混用
    }

    sealed class ReviewEntry
    {
        public int Id;                // batch 内唯一
        public string Key;            // 只给本条 key
        public EntryKind Kind;        // 本地推断
        public string Source;         // en_us
        public string Target;         // zh_cn
        public string FilePath;       // 例如 `mods/<siteId>/<modid>/lang/zh_cn.json` 或 DSL 路径
        public PrecheckResult Precheck;

        // 省 token：只放命中的术语/相邻参考
        public Dictionary<string, string> GlossaryHits; // term -> preferred zh
        public List<(string Key, string Target)> Neighbors; // 最多 3 条
        public string ContextHint; // 可为空：一句话用途摘要
    }

    sealed class ReviewBatchInput
    {
        public string ModId;
        public string ModName;
        public ImportanceLevel Importance;
        public string McVersionRange; // 可为空
        public List<ReviewEntry> Entries;

        public Dictionary<string, string> GlobalGlossary; // 可选：仅放本批会用到的
        public List<string> StyleRules; // 短规则列表
    }

    sealed class ReviewFrontendDisplay
    {
        public List<ReviewFrontendDisplayItem> FrontendDisplayItems;
        public List<LlmItemOutput> LLMOutputItems;
        public List<string> GlobalNotes;
    }

    sealed class ReviewFrontendDisplayItem
    {
        public string Key;
        public string Source; // en
        public string Target; // cn
        
    }

    // LLM 输出结构（与 prompt 中 JSON 对应）
    sealed class LlmBatchOutput
    {
        // public BatchSummary BatchSummary;
        public List<LlmItemOutput> Items;
        public List<string> GlobalNotes;
    }

    sealed class LlmItemOutput
    {
        public int Id;
        public string Status; // pass/minor/needs_fix/needs_context
        public List<LlmIssue> Issues;
        public string SuggestedTarget;
    }

    sealed class LlmIssue
    {
        public string Severity; // blocker/major/minor
        public string Type;     // meaning/terminology/...
        public string Message;
        public string Suggestion;
        public string Reason;
    }
}
