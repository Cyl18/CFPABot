# CFPABot
https://github.com/CFPAOrg/Minecraft-Mod-Language-Package 的 *PR 管理*及一些*网页工具*

***但是这一切真的值得吗((***

https://cfpa.cyan.cafe/Azusa/

> 其实代码是一堆 sh\*t 山 我自己都看不懂（

> 除了 token 以外的内容均开源，直接使用下面的部署指南就可以部署

## 命令列表

每一行会当作单独的命令执行，也就是说你可以在同一个 Comment 内执行多条命令。  
所有命令仅维护者和 PR 提交者可用。

- `/mv [a] [b]` 将 a 移动到 b，文件夹或文件均可，若路径包含空格可使用引号包裹 a 和 b。
- `/update-en [CurseForge项目名] [游戏版本]` 更新指定模组的英文文件。  
  游戏版本可为仓库中的五个值 `1.12.2` `1.16` `1.18` `1.16-fabric` `1.18-fabric`
- `/sort-keys [文件路径]` 重排键序。适用于 MCreator。
- `/add-mapping [slug] [curseForgeProjectID]` 添加 CurseForge slug 到 ID 的映射

例如：`/update-en xaeros-world-map 1.12.2`

善用 PR files 内的文件路径复制功能。

## 更多命令（补充）

| 命令 | 说明 |
|---|---|
| `/rename [a] [b]` | 重命名文件 |
| `/diff` | 展示详细的语言文件差异 |
| `/replace <旧文本> <新文本>` | 在翻译文件中替换文本 |
| `/add-comment <key> <注释>` | 添加 JSON 注释 |
| `/add-co-author <用户>` | 为提交添加 co-author |
| `/revert [hash]` | 回退提交 |

## Overview

![Snipaste_2022-05-03_18-36-47](https://user-images.githubusercontent.com/14993992/166440710-e0088f7d-c88a-4984-ab7d-a88161fc83f8.png)

## 功能特性

### GitHub Bot
- **自动 PR 评论** — 在每个 PR 上发布动态 Bot 评论，包含：
  - **Mod 检测** — 检测 PR 中的模组并链接到 CurseForge/Modrinth
  - **构建产物** — 从 PR 生成的资源包下载链接
  - **自动检查** — 路径验证、大写警告、重复 PR 检测、术语合规检查
  - **文件差异** — 中英文语言文件对比
- **Webhook 事件处理** — 监听 PR 开启/同步/编辑/标签/关闭、Issue 评论和工作流运行事件
- **自动打标签** — 根据 PR 内容自动应用标签

### Web 面板 (Azusa)
位于 `/Azusa/` 的 Blazor Server 管理界面：
- PR 列表、编辑器、创建器
- 交互式双向差异查看器，支持 AI 审查和评论
- LLM 驱动的 PR 审查
- Mod 列表浏览
- CurseForge slug 映射管理
- 语言文件排序工具
- 周报生成器
- GitHub OAuth 登录 + PR Fork 管理

### Project Hex
定期将所有打开的 PR 合并到一个统一分支，运行 Packer 生成资源包 ZIP，提供下载跟踪功能，并将构建状态发布到 issue [#2444](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/issues/2444)。

### LLM 审查 (Christina)
模块化的 LLM 审查系统，支持：
- **Google Gemini**
- **OpenRouter**
- **自定义 OpenAI 兼容接口**

审查结果缓存在 SQLite 中（30 天 TTL，每日清理）。

## 技术栈

- **运行时**: .NET 10.0 (ASP.NET Core)
- **Web UI**: Blazor Server + BlazorStrap (Bootstrap 5)
- **数据库**: SQLite via Entity Framework Core（LLM 审查缓存）
- **GitHub 集成**: Octokit, Octokit.Webhooks, GitHubJwt
- **Mod 平台**: CurseForge API Client, Modrinth.Net
- **LLM**: Gemini API, OpenAI 兼容 API (OpenRouter)
- **其他**: SignalR (实时 UI), DiffPlex/DiffPatch (文件差异), Markdig (Markdown), Serilog (日志)
- **基础设施**: Docker 多阶段构建, docker-compose

## 架构概览

```
CFPABot/
├── Azusa/               # Blazor Server 面板页面和组件
├── Christina/           # LLM 审查系统
├── Checks/              # 自动 PR 标签检查
├── Command/             # 斜杠命令处理
├── Controllers/         # REST API 和 Webhook 控制器
├── DiffEngine/          # 语言文件差异引擎
├── LanguageCore/        # JSON/.lang 文件格式化
├── ProjectHex/          # PR 合并 + 资源包构建
├── Utils/               # 工具类 (GitHub API, CurseForge, Modrinth 等)
├── Models/              # 数据模型
└── Exceptions/          # 自定义异常类型
```

## 自己部署

> 如果有哪一天我似了（） 可以用下面的方法自己部署

### 前置要求
- Docker & docker-compose
- 一个 GitHub App（参见 [GitHub App 创建指南](https://docs.github.com/en/developers/apps/creating-a-github-app)）
- CurseForge API 密钥（可选，用于 `/update-en`）
- LLM API 密钥（可选，用于 Christina）

### 部署步骤

1. **克隆仓库**
   ```bash
   git clone https://github.com/CFPAOrg/CFPABot.git
   cd CFPABot
   ```

2. 参照 `build-from-codespace.sh` 构建 docker image

3. **配置环境变量** — 修改 `docker-compose.yml` 中的环境变量：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `GITHUB_WEBHOOK_SECRET` | 是 | GitHub App webhook 密钥 |
   | `GITHUB_OAUTH_TOKEN` | 是 | 个人访问令牌（用于 gist 上传） |
   | `CURSEFORGE_API_KEY` | 否 | CurseForge API 密钥 |
   | `CFPA_HELPER_GITHUB_OAUTH_CLIENT_SECRET` | 否 | GitHub OAuth 密码（Azusa 登录） |
   | `CHATGPT_API_KEY` | 否 | 旧版 ChatGPT API 密钥 |
   | `GEMINI_API_KEY` | 否 | Google Gemini API 密钥（Christina） |
   | `OPENROUTER_API_KEY` | 否 | OpenRouter API 密钥（Christina） |

4. 在 `config/` 放置 `cfpa-bot.pem`，这是 GitHub App 的私钥

5. GitHub App Webhook 设置 `https://你的域名/api/WebhookListener`, Webhook Secret 为 `docker-compose.yml` 中的 `GITHUB_WEBHOOK_SECRET`

6. project hex 需要放置 Packer: 在主库中 `dotnet publish .\src\Packer\Packer.csproj -o ./ -r linux-x64 -p:PublishSingleFile=true`

7. 初始 `config/mappings.json` 的生成方法:

   ```csharp
   // <PackageReference Include="CurseForge.APIClient" Version="1.3.4" /> 版本更新也行
   // <PackageReference Include="GammaLibrary" Version="3.0.0-pre2" />

   var apiClient = new ApiClient("CURSEFORGE_API_TOKEN", "你的邮箱");
   for (int i = 0; i < 50; i++)
   {
       var addons = await apiClient.GetModsByIdListAsync(new GetModsByIdsListRequestBody() { ModIds = Enumerable.Range(i * 20000 + 1, 20000).Select(x => (uint)x).ToList()});
       List<Mod> addonsData = addons.Data;
       AddMapping(addonsData);
       Console.WriteLine($"初始化 Mapping: {i + 1}/50");
   }
   
   ModIDMappingMetadata.Save();

   static void AddMapping(List<Mod> addons)
   {
       foreach (var addon in addons.Where(s => s.GameId == 432 && s.Links.WebsiteUrl.StartsWith("https://www.curseforge.com/minecraft/mc-mods/")))
           lock (ModIDMappingMetadata.Instance)
           {
               ModIDMappingMetadata.Instance.Mapping[addon.Slug] = (int)addon.Id;
           }
   }

   [ConfigurationPath("mappings.json")]
   public class ModIDMappingMetadata : Configuration<ModIDMappingMetadata>
   {
       public Dictionary<string, int> Mapping { get; set; } = new();
       public DateTime LastUpdate { get; set; }
       [JsonIgnore] public int LastID => Mapping.Values.Max();
   }
   ```

8. 把代码所有的 `cfpa.cyan.cafe` 换成你的域名 (有 4 个地方要改)

9. 如果需要 Azusa, nginx 配置反代时需要配置 WebSocket

10. 最后 `docker-compose up -d` 即可

### 从源码构建

```bash
dotnet build CFPABot.sln
# 或用 Docker:
docker build -f "CFPABot/Dockerfile" -t cfpabot .
```

## 许可

本项目基于 [MIT License](LICENSE) 开源。Token/API 密钥除外——其余内容均按照上述部署指南自由可用。
