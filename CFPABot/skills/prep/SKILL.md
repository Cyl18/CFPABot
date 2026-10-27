---
name: prep
description: 译前草稿：路径闸门、范围、术语表、风格指南、格式要求。审查 PR 前先读。
---

# 译前

审查前建依据。产出是草稿，译中或译后会直接覆盖。

落点：`pr://<n>/terms`（冻结术语表，审查唯一权威）、`local://terms.tsv`（译中工作副本）、`STYLE.md`、`format.md`（可选）、`prep.json`。

## 步骤

1. **路径闸门**：`read pr://<n>?review=1`。一次拿到 `pr.headSha`、`workspaces`、`checks`、`rows` 计数；行在预算内给全集，超预算给 `plan`。
   - 预审解析 `projects/assets/<slug>/<版本>/<namespace>/lang/` 这 7 段布局；迁移前的 6 段（无版本目录）解析不到。
   - `counts.workspaces === 0`：看 `read pr://<n>/checks` 的 `bad_path`、`bad_path_domain`。有 `/mv` 目标 → 路径问题写进 summary 并停；没有 → 直接读文件审内容，跳过范围与候选。
2. **基线**：简报里有 `workspaces`（`enPath`、`zhPath`、counts）、`checks`、`files`、`specialFiles`、`related`、`discussions`；返回 rows 时每条 changed 行已带 `findings`，只有 plan 时不逐片读行；要派单走 `write pr://<n>/pack {}`，分片只用于抽查。需要完整预审 pack 摘要再 `read pr://<n>/review`。
3. **范围**：用 key 前缀或正则圈定，规则写进 `prep.json`，保证能重跑。
   - 语言文件先落到 `local://work/`：`read pr://<n>/files/<enPath>?side=head`，再 `write local://work/en_us.json`（zh 同理）；脚本只吃这份副本，不碰 `localRoot`。
   - lang 目录 = `./work`；输出写 `local://`，相对路径就是它。
   ```bash
   python3 "$CFPA_ROOT/skills/prep/scripts/scope.py" ./work ./scope --prefix "item." --pattern '^block\.'
   ```
   `--prefix` 和 `--pattern` 至少给一个，否则工具退出。
   - `<100` changed 行的轻量包可以整段跳过本步与 `local://work/` 副本：直接走第 4 步的 `terms?candidates=1`，`prep.json.scope` 写全量。
4. **术语候选**：`read pr://<n>/terms?candidates=1`。它给机械候选（注册名 + 重复词）、本 PR 已有各译法、全文双侧上下文、原版术语命中，以及当前冻结表。
   - 候选只从 changed 行抽，上下文含未改动的行；判断现译对不对看上下文，不看词形。
   - `suggest` 只是建议：`lock`=原版唯一命中；`pending`=多候选，必须查语料；`new`=无权威命中。
   - 查证只用 glossary：先 `zh_cn_cfpa`（本仓库语料，定档只看它），`zh_cn`（模组 jar）只作旁证。英文正向 `mcp__glossary_query`，中文候选加 `inverse`，成批 `mcp__glossary_query_batch`（≤20，单条上限 50）。只有 `source` 与词全等（不分大小写）才算命中，模糊结果不算；带 `^…$` 锚点的正则查询会报空匹配，别用。
   - `termgen` 只挖 PR 内分歧，不产出定译：
   ```bash
   python3 "$CFPA_ROOT/skills/prep/scripts/termgen/final.py" mod review ./scope -o ./review/<slug>
   ```
   - 名字型包可能漏掉整句里的专名；漏了手工补进表。`--termhood auto` 不依赖第三方库；`specificity` 需要 `wordfreq`。
5. **术语表（冻结）**：`write pr://<n>/terms {terms:[{en,zh,bucket,source,note}]}`。
   - `bucket`：`lock` 照用；`new` 本 PR 新建；`discard` 明确不是术语，必须写 `note`。
   - `source` 必填且可核（`zh_cn_cfpa: 12 例`、`原版术语`、`本模组既有译法: <key>`）；同形词逐条判，不按词形统一。
   - 按 head 冻结，换 head 重裁。审查阶段子代理只读表，不再查词。
   - `local://terms.tsv` 只是译中的工作副本，不是权威。
6. **风格指南**：一页。命名策略（材质、物种、物品）、语气与称呼、本模组停用词。
7. **格式要求**（可选）：只写 findings 不覆盖的引擎规则；占位符、格式码、换行、标签、键集、JSON 语法由预审负责。
8. **prep.json**：布局、`headSha`、workspace、counts、范围规则、用了哪份术语资源、没解决的问题。
9. **打包**（进 `post` 前）：`write pr://<n>/pack {}`，命令与派单规则见「流水线」。切片地址在 `slices[].doc`；`dir` 是 workspace 相对路径，拼本地路径时自己补 `local://`。片边界由服务端按 key 组与字节预算切，不用自己切；`manifest.excluded` 非 0 时回路径闸门查。
