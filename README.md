# CFPABot
https://github.com/CFPAOrg/Minecraft-Mod-Language-Package 的 *PR 管理*及一些*网页工具*

*此处应有一句感人肺腑的话((*

> 其实代码是一堆 sh\*t 山 我自己都看不懂（

## 命令列表

每一行会当作单独的命令执行，也就是说你可以在同一个 Comment 内执行多条命令。  
所有命令仅维护者和 PR 提交者可用。

- `/mv-recursive [a] [b]` 将 a 移动到 b，文件夹或文件均可，若路径包含空格可使用引号包裹 a 和 b。
- `/update-en [CurseForge项目名] [游戏版本]` 更新指定模组的英文文件。  
  游戏版本可为仓库中的五个值 `1.12.2` `1.16` `1.18` `1.16-fabric` `1.18-fabric`
- `/sort-keys [文件路径]` 重排键序。适用于 MCreator。
- `/add-mapping [slug] [curseForgeProjectID]` 你用不到的。

例如：`/update-en xaeros-world-map 1.12.2`

善用 PR files 内的文件路径复制功能。

## Overview

![Snipaste_2022-05-03_18-36-47](https://user-images.githubusercontent.com/14993992/166440710-e0088f7d-c88a-4984-ab7d-a88161fc83f8.png)

## 自己部署

> 如果有哪一天我似了（） 可以用下面的方法自己部署

- 参照 `build-from-codespace.sh` 构建 docker image
- 修改 `docker-compose.yml` 中的环境变量
- 在 `config/` 放置 `cfpa-bot.pem`，这是 GitHub App 的私钥
- GitHub App Webhook 设置 `https://你的域名/api/WebhookListener`, Webhook Secret 为 `docker-compose.yml` 中的 `GITHUB_WEBHOOK_SECRET`
- project hex 需要放置 Packer: 在主库中 `dotnet publish .\src\Packer\Packer.csproj -o ./ -r linux-x64 -p:PublishSingleFile=true`
- 初始 `config/mappings.json` 的生成方法:

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
- 把代码所有的 `cfpa.cyan.cafe` 换成你的域名 (有 4 个地方要改)
- 如果需要 Azuka, nginx 配置反代时需要配置 WebSocket
- 最后 `docker-compose up -d` 即可