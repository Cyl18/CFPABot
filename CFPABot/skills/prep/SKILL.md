---
name: prep
description: 译前草稿：路径闸门、范围、术语表、风格指南、格式要求。审查 PR 前先读。
---

# 译前

审查前建依据。产出是草稿，译中或译后会直接覆盖。

落点：`local://terms.tsv`、`local://STYLE.md`、`local://format.md`（可选）、`local://prep.json`。

## 步骤

1. **路径闸门**：`read pr://<n>?review=1`。一次拿到 `pr.headSha`、`workspaces`、`checks`、`rows` 计数；行在预算内给全集，超预算给 `plan`。
   - 预审解析 `projects/assets/<slug>/<版本>/<namespace>/lang/` 这 7 段布局；迁移前的 6 段（无版本目录）解析不到。
   - `counts.workspaces === 0`：看 `read pr://<n>/checks` 的 `bad_path`、`bad_path_domain`。有 `/mv` 目标 → 路径问题写进 summary 并停；没有 → 直接读文件审内容，跳过范围与候选。
2. **基线**：简报里有 `workspaces`（`enPath`、`zhPath`、counts）、`checks`、`files`、`specialFiles`、`related`、`discussions`；返回 rows 时每条 changed 行已带 `findings`，只有 plan 时从 `next` 开始逐片读。需要完整预审 pack 摘要再 `read pr://<n>/review`。
3. **范围**：用 key 前缀或正则圈定，规则写进 `prep.json`，保证能重跑。
   - 语言文件先落到 `local://work/`：`read pr://<n>/files/<enPath>?side=head`，再 `write local://work/en_us.json`（zh 同理）；脚本只吃这份副本，不碰 `localRoot`。
   - lang 目录 = `./work`；输出写 `local://`，相对路径就是它。
   ```bash
   python3 "$CFPA_ROOT/skills/prep/scripts/scope.py" ./work ./scope --prefix "item." --pattern '^block\.'
   ```
   `--prefix` 和 `--pattern` 至少给一个，否则工具退出。
4. **术语依据**：先 `read pr://<n>/terms?changed=1`。它给本 PR 同词多译、术语缺失和 glossary 权威译法，按 `misses` 排序；逐行命中在 rows 的 `terms` 字段里。候选只做召回，glossary 仍是权威。
   - 按包的形状判断，不按 changed 行数；`mod prep` 几秒跑完。

   | 判据 | 做法 |
   |---|---|
   | <100 changed 行 | 先看 `pr://<n>/terms?changed=1`，术语表 10–20 行 |
   | changed 行是名字型 | `mod prep` 提候选 |
   | changed 行有整句/长段落 | 加 `mod mine`（纯名字包 `long_only=0`，白跑） |
   | >1000 changed 行 | 先按 key 分片，每片各自判断 |

   ```bash
   python3 "$CFPA_ROOT/skills/prep/scripts/termgen/final.py" mod prep ./scope -o ./prep/<slug>
   python3 "$CFPA_ROOT/skills/prep/scripts/termgen/final.py" mod mine ./scope en --termhood auto -o ./prep/<slug>
   ```
   - 术语表只取 changed 行里出现的词：整表是整包候选，读不完也用不上。
   - 生成表的 `role` 只是分类（`head` 是条目主体段，`mod` 是轴取值），`impact` 是覆盖键数、只用于排优先级；两列都不参与组装。
   - 审查已有中文时优先 `mod review`：读同目录的 `en_us`/`zh_cn`，直接报同一英文的多种译法。
   - 单个词要额外核对时用 `mcp__glossary_query`；成批用 `mcp__glossary_query_batch`，每批 ≤20 个，单条上限 50。能由 `pr://<n>/terms` 回答的不要重复查。
   - 入选以 glossary、原版、本模组既有译法为准。
   - `--termhood auto` 不依赖第三方库；`specificity` 需要 `wordfreq`。
   - 镜像里 `python3`，Windows 上 `python`。
5. **术语表**：每行 `en / zh / type / status / note`。`status` 只有 `draft` 和 `locked`；只锁专名、物品、生物、组织、地名，UI 词保持 `draft`。同形词逐条判，不按词形统一。
6. **风格指南**：一页。命名策略（材质、物种、物品）、语气与称呼、本模组停用词。
7. **格式要求**（可选）：只写 findings 不覆盖的引擎规则；占位符、格式码、换行、标签、键集、JSON 语法由预审负责。
8. **prep.json**：布局、`headSha`、workspace、counts、范围规则、用了哪份术语资源、没解决的问题。
