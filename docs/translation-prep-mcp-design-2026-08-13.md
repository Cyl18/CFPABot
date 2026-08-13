# translation-prep MCP server — 调查与设计（2026-08-13）

> **状态：方案暂缓（2026-08-13 拍板）**。MCP 化砍掉——无第二消费者、YAGNI。实际方向：使用现有非 CAT compare 页面，打磨对齐（review-align）与 agent 审查后上线。本文档保留为探索记录。

## 背景

CFPABot 翻译审查 Agent 的译前准备业务（术语提取/清洗/匹配、TM 查询、原版术语注入、格式检查）计划抽成**可独立发布**的 MCP server，以解耦并灵活维护。驱动因素：

- Agent 工具职责过于特化（`src/agent/tools/` 十个审查工具），业务与 Agent 会话深度耦合
- 业务无法独立发布——依赖主仓库的 `flows/_shared/terminology/` 纯函数、`config/vanilla-terms.json`、`runtime/cache/tm/{slug}.json` 索引、会话 ctx
- 术语/TM 数据资产（社区词典 91.8 万行、vanilla 术语、知识记忆）散落在其他仓库（mctk/MTPA），主仓库 `dict_lookup` 还是 P2 stub

**当前阶段：设计讨论完成，未开始实现。**

## 一、参考仓库调查结论

### lara-mcp（https://github.com/translated/lara-mcp，MIT）

Translated 公司 Lara Translate 平台官方 MCP client，npm 包 `@translated/lara-mcp` v1.0.6。TypeScript + `@modelcontextprotocol/sdk` ^1.27.1 + zod v4。

- **架构完全无状态**：不落任何本地数据、无会话/缓存；TM/术语表是 Lara 云资源按 ID（`mem_*`/`gls_*`）引用
- 大对象全部内联在工具参数中跨进程传递（imports ≤5MB，HTTP body ≤30MB）；耗时导入用 async job + 轮询（`import_id` → `check_*_import_status`）
- 双传输：`TRANSPORT=stdio`（默认，凭据走环境变量）或 `http`（Express 5 + StreamableHTTPServerTransport，无状态，每请求新建 server 实例，凭据走 `x-lara-access-key-*` 请求头）
- 21 工具：1 translate + 1 语言检测 + 1 语言列表 + 8 TM + 10 术语表；另有 3 个只读 MCP Resources
- 发布：npm（`bin: lara-mcp`）+ Docker 镜像 + Claude/Cursor 插件清单 + GitHub Actions 自动发布
- 值得借鉴：双传输共享 `getMcpServer` 工厂、每工具一文件（schema+handler）、zod→JSON Schema 声明 input/outputSchema、structuredContent+文本双输出、错误映射（ZodError 只回字段名、SDK 错误泛化）、大导入异步 job 轮询
- 明显缺陷：大对象全内联导致 5MB 上限偏小且无 chunking/引用协议、list_memories 按名查是 O(n) 客户端过滤、HTTP 模式无 OAuth

**关键结论**：单次调用 KB~MB 级无状态内联传参完全够用；跨工具共享大文档才需要"上传→引用 ID"机制；TM/术语表这类有状态数据应放 server 侧后端存储按 ID 引用，而非在 MCP 进程内保存会话态。

### Minecraft-Translate-Proofread-Agent（MTPA，前身，半成品）

CFPA 审查 bot 的半成品前身：Python 3.11+ 的 6 阶段流水线 CLI（对齐→术语→格式→模糊 TM→LLM 审校→LLM 过滤→报告），另有面向 agent 集成的原子 CLI 子命令（`mtpa` 入口）。

- 核心算法资产已被 CFPABot 继承为 `terms-extract`/`terms-distill`/`review-prep`/`review-moa` 及 `config/vanilla-terms.json`（source 标注 'mtpa vanilla_terms.db (curated)'）：
  - n-gram 术语提取 + inflection 词形归并 + 术语表共识构建
  - 10 项确定性格式检查（`FormatChecker`，零 LLM 成本）
  - FTS5 + Levenshtein 模糊搜索
  - VanillaTermsStore（带 scope/label 原版术语）、ExternalDictStore（SQLite 社区词典，`minecraft_dict.py` 死代码未接线）
- `translation-reviewer.agent.md`：历史存档的 agent 提示词（已被 AGENTS.md 取代）；`terms-clean.md`：术语库回写/多义术语治理规范片段
- 缺陷（新实现要避免）：asyncio.run 同步包异步反模式、全局单例 config、PipelineContext 26 字段 god-object、stdout 污染靠 monkeypatch、`rmtree` 清空输出目录的破坏性重跑、O(n²) 术语表构建、硬编码 gh CLI 与默认仓库

**结论**：原子 CLI 子命令是 tool 形状的现成范本；format_checker/术语管线/VanillaTermsStore/ExternalDictStore 是最值得迁移的资产；对齐（review-align）由用户确认留主仓库内部。

### Minecraft-Translate-Kit（mctk，做了一半，带记忆）

为 LLM agent 设计的 Minecraft 翻译审校 CLI 工具集（Python ≥3.11，仅依赖 inflection+pyyaml）。

- **"记忆" = 三层翻译知识记忆**：`entries.yaml`（确定性好/坏译法，verdict=good/bad/question）+ `drafts.yaml`（草稿）+ `wiki/`（LLM 抽象层）；读写路径 `MCTK_KNOWLEDGE_DIR` 环境变量优先
- **两大翻译记忆库**：`Dict-Sqlite.db` 91.8 万行社区历史（`dict` 表：ID/ORIGIN_NAME/TRANS_NAME/MODID/KEY/VERSION/CURSEFORGE + FTS5，161MB，gitignore 不入库）；`vanilla_terms.db` 1101 行（`terms` 表 + `terms_fts`，scope 为 JSON 正则）
- 18 个工具全部注册（key-alignment/fuzzy-search/term-extract/lang-parse/code-detect/version-cmp/format-check/term-check/term-lookup/dict-lookup/key-diff/review-guide/quick-scan/compose-check/knowledge/pr-review/pr-align/manual-diff），2 处确定接线缺陷（pr_review 的 `report["sections"]` KeyError；knowledge suggest/match 与 quick-scan 输出契约错位）
- `AGENTS.md`（13.2KB）即未来 MCP 工具描述与使用指南的雏形
- 缺陷：tests/ 为空、数据未打包（editable 安装 + 硬编码路径）、wiki 仅 1 张实体页

**结论**：社区词典 + vanilla_terms.db + 三层知识记忆是**最大数据资产**，正好填补 CFPABot 的 `dict_lookup` P2 stub 与占位数据缺口（注：占位数据缺口已过时，见下文事实修正）。

### weblate（开源 CAT 平台，规范实现）

Django 实现的完整 CAT 平台。聚焦 glossary/memory/checks/machinery 提取规范：

- **TM 模型极简**（`weblate/memory/models.py`）：`Memory(source, target, source_language, target_language, origin, context, status)` + `MemoryScope` 多对多可见性行（PROJECT/WORKSPACE/SHARED/USER）——**一条记忆挂多个 scope 行管理可见性，而非复制文本**
- **双轨索引**：等值走 MD5 文本索引，模糊走 PostgreSQL trigram（GIN 全串 + GiST 前缀 2048）；阈值→相似度 log 映射 + 长度 boost + 短串保护；**检索候选与质量打分分离**（`get_scored_fuzzy_candidates` + 外部 scorer 回调）
- **批量 lookup API 形状**（`POST /api/memory/lookup/`）：`strings[]` ≤100 条、每条 ≤2000 字符，响应 `[{query, match:{id,source,target,origin,exact,quality}|null}]`
- **术语 = Unit**（无独立 Term 模型）：`is_glossary=True` 的 Component + flags 表达语义（`forbidden` 禁译词 / `read-only` 源术语 / `terminology`）；匹配用 **Aho-Corasick 自动机**（`ahocorasick_rs`，词边界感知，按项目缓存）
- **checks 注册机制**：类路径字符串 + `ClassLoader`（settings 驱动插件化）；`BaseCheck` 声明 check_id/name/target/source/glossary 维度；check_id 自动派生 `enable/ignore` flag 名；`Highlight{kind,role,translatable}` 打通"检查→编辑高亮→LLM 占位符保护"一条链
- **LLM 翻译协议**（`weblate/machinery/llm.py`）：JSON 结构化输入（glossary + failing_checks 注入 + parts 分片）；**`@@PH{n}@@` 占位符不变量**（字节级保留）；输出 JSON 容错修复器（代码围栏解包/占位符修复/长度校验）；few-shot ≤4
- **MT 后端统一抽象**：`BatchMachineTranslation`（max_score/rank_boost/settings_form/批量下载/30 天缓存）；**"TM 即 MT 后端"** 模式（`WeblateMemory` 同时是 machinery 后端）
- 审计：一切操作写 `unit.change_set` 事件表，天然可追溯

### weblate-mcp（https://github.com/mmntm/weblate-mcp，MIT）

Weblate 平台的 MCP 适配层（非我们调查的 weblate 主仓库）。NestJS + TS + MCP SDK + Axios，v1.3.1。

- **纯 API 转发，零业务逻辑**：工具全是 CRUD/查询（listProjects/listComponents/searchUnitsWithFilters/writeTranslation/bulkWriteTranslations/统计/变更追踪），server 内不落任何数据
- **硬依赖运行中的 weblate 实例**：`WEBLATE_API_URL` + `WEBLATE_API_TOKEN` 环境变量，全部请求转发到 REST API
- 三传输（HTTP/SSE、Streamable HTTP、STDIO）、npx 发布、changesets 发布流程

**结论**：证实"weblate 作为 MCP 后端 = 必须运行 weblate 实例"（docker + PostgreSQL + Celery + Redis）——**决策：排除**（用户拍板：太重、无需鉴权）。无可迁移资产（无业务逻辑，仅 API 转发脚手架）。

## 二、核心约束

1. **大对象不进 LLM 上下文**：`terms_extract`/`review_prep` 是 `Type.Object({})` 批处理工具，aligned 表（对齐条目，含多版本）刻意从会话 ctx 读、不进 LLM 上下文。改成 LLM 直接调用的 MCP 工具后，LLM 手里没有 ctx.aligned 可作参数——**无状态参数化契约不成立**
2. **无状态 server**：lara-mcp 验证——MCP 进程内不保存会话态，有状态数据放 server 侧后端存储
3. **独立发布**：不依赖主仓库的 `runtime/` 路径、`config/` 资产、git 克隆、会话 ctx

## 三、架构决策：无状态双消费面

```
┌─ CFPABot 主仓库 ─────────────────────────────┐
│  Agent (LLM)                                 │
│    │  查询类工具（小对象，LLM 直接调）          │
│    ▼                                          │
│  pi-mcp-adapter ──────┐                      │
│                       │ MCP (stdio)          │
│  薄壳工具              │                      │
│  (terms_extract/      │  MCP client SDK      │
│   review_prep 壳) ────┼──────┐               │
│   │ 从 ctx 读 aligned   │      │              │
│   ▼ 写回 ctx/回摘要      │      │              │
│  ctx(会话状态)          │      ▼              │
└────────────────────────┼─────────────────────┘
                         │
              ┌──────────▼──────────┐
              │  translation-prep   │  独立发布
              │  MCP server         │  无状态纯函数 + 自持数据资产
              │  (TS+Bun 单二进制)   │  SQLite/YAML/JSON 自管存储
              └─────────────────────┘
```

- **查询类工具**（LLM 直接调，小对象内联，lara 模式）：`tm_lookup`/`term_lookup`/`glossary_match`/`check_run`——LLM 手里有词条/短语，参数构造得出，返回走 LLM 上下文安全
- **批处理工具**（LLM 只看到主仓库薄壳，接口不变）：薄壳从 ctx 取 aligned 全表，**程序化**经 MCP client SDK 内联传 server（薄壳是程序不是 LLM，参数构造得出；本地 stdio 传几百 KB~MB 级 JSON 毫秒级），回写 ctx、回摘要——aligned 全程不进 LLM 上下文
- **server 无状态**：不存会话态、不持 aligned 引用。大对象只有"薄壳→server"一条传输路径，无脏数据/过期/重启恢复问题
- **不接 lara 平台**（数据主权 + Minecraft 定制缺失 + 工作流冲突），**借鉴其架构模式**（MIT）：双传输共享工厂、每工具一文件、zod/TypeBox→JSON Schema、错误映射、async job 轮询

## 四、边界表

### 进 MCP server（业务资产，可独立发布）

|资产|内容|格式|
|---|---|---|
|算法|n-gram 术语提取、词形归并、清洗裁决校验、术语匹配（hash 短语 + regex scope）、BM25+fuzzy、10 项格式检查、check_id 注册表|代码（自 `flows/_shared/terminology/` 迁入）|
|TM 存储|索引构建 + 检索，自建自持|SQLite FTS5（见格式决策）|
|术语库|vanilla（静态资源随版本发布）+ internal 清洗产物/glossary CRUD|vanilla: JSON；可写术语: SQLite|
|社区词典|91.8 万行 Dict-Sqlite.db|SQLite（现成，直接作为数据源）|
|知识记忆|mctk entries.yaml/drafts.yaml/wiki|YAML（现成，人维护/LLM 友好）|

### 留主仓库（会话/编排/仓库绑定）

|资产|理由|格式|
|---|---|---|
|会话 ctx（aligned/dict/审查表）|跨进程不可共享的会话状态|JSON（现 FileStore，不变）|
|业务状态（评论发布/PR 索引/info-comments/modlist）|与 GitHub/仓库绑定|JSON（现状，不变）|
|执行记录/幂等/transcript|运维记录|JSON/NDJSON（现状，不变）|
|**语料收集**（从 runtime/repo 浅克隆配对 (en,zh)）|依赖 git 克隆 + PR 上下文（prNumber/headSha/ref），仓库绑定逻辑|—|

### 关键边界点：tm_build 拆分

`tm_build` 拆两半——**语料收集留主仓库**（读 runtime/repo，server 独立发布后不该碰 git），产出极简契约 `TmEntry[]`（en/zh/path/key）传给 server 的 `tm_import`；**索引构建与存储归 server**（`tm.ts` 纯函数迁入 server，自建 FTS5）。传输量一个 slug 几 MB 级，按 namespace 分批 + lara 式 async job 轮询。server 与主仓库的契约面只有一个 `TmEntry`，版本化容易。

## 五、数据模型与格式决策

按**数据角色**选格式：

|角色|格式|为什么|
|---|---|---|
|语言文件（输入）|JSON|Minecraft 生态标准，不可选|
|TM 索引（server 内）|SQLite FTS5|BM25 全文检索性能；社区词典同库统一（161MB 只可能 SQLite）；`bun:sqlite` 原生零依赖|
|术语库（server 内）|vanilla: JSON 静态资源；internal/glossary: SQLite|只读资产 JSON（git 友好、随版本 diff）；可写资产 SQLite|
|知识记忆|YAML|人维护、LLM 直接读写、git 友好——mctk 现成格式不换|
|会话/业务状态（主仓库）|JSON（现状）|无查询需求、原子写、人可读，FileStore 已够|
|互操作层（v2 可选）|TMX 导出（TM）/ TBX、CSV（术语）|仅当与 weblate/其他 CAT 互通；lara 已示范 TMX/CSV 导入模式|
|PO|不用|Minecraft 非 gettext 生态，无位置|

**数据模型**（照 weblate 语义，落 SQLite）：
- `Memory(source, target, source_language, target_language, origin, context, status)` + FTS5 索引；等值用精确匹配、模糊用 BM25+Levenshtein（本地 SQLite 无 pg_trgm）
- `Term(term, translation, scope, labels[], flags[], version?, source)`——合并 vanilla + internal，flags 表达禁译/只读/术语（weblate Unit 语义）
- 检索与打分解耦（weblate scorer 回调模式）：`get_candidates`（检索）→ `score`（QRatio/BM25 质量分 0-100）

**事实修正**：`config/vanilla-terms.json` 已是 10471 行 curated 真实数据（`source: "mtpa vanilla_terms.db (curated)"`，en 多值数组 + zh 多值数组 + labels）——AGENTS.md 的"占位数据"说法已过时；迁移清单中"换真实数据"作废，改为"原样迁入 server"。

## 六、工具契约

### 查询类（LLM + 薄壳共用）——API 形状照 weblate `memory/lookup`

|工具|输入 → 输出|数据源|
|---|---|---|
|`tm_lookup`|`{strings[] ≤100, slugs[], mode: exact\|fuzzy\|both} → [{query, match:{source,target,origin,quality,exact}\|null}]`|TM 索引（社区词典 + CFPA 仓库历史）|
|`term_lookup`|`{term} → [{en, zh, modids[], quality}]`|社区词典（填 dict_lookup P2 stub 缺口）|
|`glossary_match`|`{source_text[], scope} → 词边界命中列表`|vanilla_terms + internal 清洗术语（Aho-Corasick 词边界匹配）|
|`glossary_crud`|`add/update/delete`（Unit 语义 + forbidden/read-only/terminology flags）|server 术语库（terms_distill 产物回写）|
|`check_run`|`{check_ids[], source, target, context} → [{check_id, pass, detail}]`|10 项格式检查 + 术语一致性（check_id 注册表）|
|`vanilla_terms`|`{scope?} → 术语资源`|vanilla_terms 资产|

### 批处理类（薄壳程序化调）

`terms_extract({aligned, version?, n?})`、`terms_distill({dict, audit, rulings})`、`prep_compute({aligned, dict})`（内部组合 tm_lookup + glossary_match，输出 prep 行）。

### Resources

`terms://vanilla`、`knowledge://entries`（三层知识记忆，v2）、`languages://`。

## 七、依赖消除清单

1. `src/flows/_shared/terminology/`（tm.ts 的 BM25/fuzzy、term-match.ts、ngram.ts、check-terms.ts、rules.ts）→ 迁入 server 作为纯函数库
2. `config/vanilla-terms.json` → 迁入 server 作为静态资源（随版本发布）
3. `runtime/cache/tm/{slug}.json` 索引产物 → 由 server 自建自持（SQLite），主仓库 `tm_build` 拆分为"语料收集 → tm_import"
4. `dict_lookup` P2 stub → 用社区词典（Dict-Sqlite.db 迁入 server）填补为 `term_lookup`
5. 会话 ctx 依赖 → 批处理工具薄壳化，参数经 MCP 内联传 server

## 八、发布形态

- **独立 workspace**（`packages/translation-prep-mcp/`，稳定后拆独立 repo）；TS + Bun（与主仓库一致，`bun build --compile` 单二进制，无 Node 依赖——照 glossary 模式）
- **双传输**：stdio（默认，agent 消费）+ http（Express，给前端/CI 消费者，lara 模式）
- Dockerfile runtime 阶段下载二进制；`.mcp.json` 注册（`lifecycle: lazy`）
- 主仓库改造：`agent/tools/` 四个工具变薄壳（签名不变）、`tm_build` cron 拆分、`config/vanilla-terms.json` 移入 server

## 九、主仓库保留不动

`review-align`（依赖仓库读取）、`review-moa`/`review-aggregate`/`review-finalize`（LLM 编排 + 会话表转换）、`dict_lookup` 会话状态（ctx.dict 积累，经薄壳参数传入 server）。

## 十、待拍板项

1. **TM 索引落 SQLite FTS5（推荐）还是保留 JSON 索引格式**——前者统一存储层、FTS5 bm25() 现成、为社区词典查询铺路（迁移成本低）；后者改动最小但检索能力不变
2. **server 位置**：先同仓 workspace（演进快、共享 TS 类型/CI，推荐）还是直接独立 repo
3. **社区词典 v1 是否迁入**（推荐迁入，顺手填 dict_lookup P2 stub 缺口）
4. **护栏**：当前只调查不写码，实现待解除护栏后开工

## 十一、决策记录速查

- 无状态双消费面（路径 1：主仓库薄壳 + 程序化调 server）——concern 论证后唯一可行
- 不接 lara 平台，借鉴其架构模式（MIT）
- **weblate 不当运行时后端**（太重：docker + PostgreSQL + Celery + Redis；无需鉴权；多译法单 match 语义冲突）——仅作 v2 互通目标（TMX/TBX 导出）与数据模型/API 形状参考
- **不手写轮子**：所需算法均已存在且生产在用（`tm.ts` BM25/fuzzy、`term-match.ts`、`check-terms`/`rules` 格式检查、`packtrans-glossary` 术语 MCP、`Dict-Sqlite.db` + ExternalDictStore 社区词典）——重构是"搬"不是"造"
- 存储自管：SQLite 为主 + JSON 只读资产 + YAML 知识记忆；harness/write tool 不参与 server 存储
- PO 不用，TMX/TBX 留 v2 互通
- 对齐（review-align）留主仓库内部
