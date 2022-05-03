# CFPABot
https://github.com/CFPAOrg/Minecraft-Mod-Language-Package 的 PR 管理

*此处应有一句感人肺腑的话((*

## 命令列表

每一行会当作单独的命令执行，也就是说你可以在同一个 Comment 内执行多条命令。  
所有命令仅维护者和 PR 提交者可用。

- `/mv [a] [b]` 将 a 移动到 b，文件夹或文件均可，若路径包含空格可使用引号包裹 a 和 b。
- `/update-en [CurseForge项目名] [游戏版本]` 更新指定模组的英文文件。  
  游戏版本可为仓库中的五个值 `1.12.2` `1.16` `1.18` `1.16-fabric` `1.18-fabric`
- `/sort-keys [文件路径]` 重排键序。适用于 MCreator。
- `/add-mapping [slug] [curseForgeProjectID]` 你用不到的。

善用 PR files 内的文件路径复制功能。