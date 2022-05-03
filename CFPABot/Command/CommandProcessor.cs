using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Language.Core;
using Octokit;
using Serilog;
using FileMode = System.IO.FileMode;

namespace CFPABot.Command
{
    public record GitHubUser(string Login, long ID);

    public static class CommandProcessor
    {
        public static async Task Run(int prid, string content, int commentID, GitHubUser user)
        {
            bool addedReaction = false;
            var sb = new StringBuilder();
            var pr = await GitHub.GetPullRequest(prid);
            var repo = new Lazy<GitRepoManager>(() => new GitRepoManager());
            try
            {
                foreach (var line in content.Split("\r\n"))
                {
                    if (!line.StartsWith("/")) continue;
                    if (line.StartsWith("/mv "))
                    {
                        if (!await CheckPermission()) continue;
                        var arg = line["/mv ".Length..];
                        var r = GetRepo();
                        var args = GitRepoManager.SplitArguments(arg);
                        Directory.CreateDirectory(Path.Combine(r.WorkingDirectory, Path.GetDirectoryName(args[1])));
                        foreach (var path in args)
                        {
                            var baseDir = Path.GetFullPath(r.WorkingDirectory);
                            if (!Path.GetFullPath(path, baseDir).StartsWith(baseDir))
                            {
                                throw new CommandException("⚠ 安全检查错误：你所操作的目录不在工作目录下。");
                            }
                        }
                        r.Run($"mv -f {arg}");

                        r.AddAllFiles();
                        r.Commit($"mv {(arg.Replace("\"", "\\\""))}", user);
                    }

                    if (line.StartsWith("/update-en "))
                    {
                        if (!await CheckPermission()) continue;
                        var args = line["/update-en ".Length..].Split(" ", StringSplitOptions.RemoveEmptyEntries);
                        var r = GetRepo();
                        var curseForgeID = args[0];
                        var versionString = args[1];
                        var version = args[1].ToMCVersion();
                        var versionFile = version switch
                        {
                            MCVersion.v1122 => "en_us.lang",
                            _ => "en_us.json"
                        };
                        var addon = await CurseManager.GetAddon(curseForgeID);

                        var modID = await CurseManager.GetModID(addon, version, true, false);
                        var (files, downloadFileName) = await CurseManager.GetModEnFile(addon, version, LangType.EN);
                        if (files.Length != 1)
                        {
                            sb.AppendLine("更新失败：找到了多个语言文件。");
                            continue;
                        }

                        sb.AppendLine($"使用 {downloadFileName} 中的语言文件。");
                        var f = files[0];
                        using var sr = new MemoryStream(f.ToUTF8Bytes()).CreateStreamReader(Encoding.UTF8);
                        using var sw = File.Open(
                            Path.Combine(r.WorkingDirectory,
                                $"projects/{versionString}/assets/{curseForgeID}/{modID}/lang/{versionFile}"),
                            FileMode.Create).CreateStreamWriter(new UTF8Encoding(false));

                        switch (version)
                        {
                            case MCVersion.v1122:
                                new LangFormatter(sr, sw).Format();
                                break;
                            default:
                                new JsonFormatter(sr, sw).Format();
                                break;
                        }

                        r.AddAllFiles();
                        r.Commit($"Update en_us file for {(curseForgeID.Replace("\"", "\\\""))}", user);
                    }

                    if (line.StartsWith("/add-mapping "))
                    {
                        var args = line["/add-mapping ".Length..].Split(" ", StringSplitOptions.RemoveEmptyEntries);
                        if (user.Login != "Cyl18")
                        {
                            sb.AppendLine("⚠ 为了防止此命令被错误执行，此命令只有 @Cyl18 才能执行。\n");
                            continue;
                        }
                        var slug = args[0];
                        var curseForgeProjectID = args[1];
                        var addon = await CurseManager.GetAddon(curseForgeProjectID);
                        if (slug != addon.Slug)
                        {
                            sb.AppendLine($"⚠ 添加重定向 {slug} -> {curseForgeProjectID} 失败。提供的 slug 为 {slug} 而 API 返回的为 {addon.Slug}。");

                        }
                        else
                        {
                            ModIDMappingMetadata.Instance.Mapping[slug] = curseForgeProjectID.ToInt();
                            ModIDMappingMetadata.Save();
                            sb.AppendLine($"ℹ 添加重定向 {slug} -> {curseForgeProjectID} 成功。请使用强制刷新来刷新数据。");
                        }
                    }

                    if (line.StartsWith("/sort-keys "))
                    {
                        if (!await CheckPermission()) continue;
                        var args = line["/sort-keys ".Length..].Split(" ", StringSplitOptions.RemoveEmptyEntries);
                        var r = GetRepo();
                        var file = args[0];


                        var filePath = Path.Combine(r.WorkingDirectory, file);
                        if (!File.Exists(filePath))
                        {
                            sb.AppendLine("文件不存在。");
                            continue;
                        }


                        if (file.EndsWith(".json"))
                        {
                            var sourceJson = JsonDocument.Parse(File.ReadAllText(filePath), new JsonDocumentOptions() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
                            var pairs = sourceJson.RootElement.EnumerateObject()
                                .Select(o => new KeyValuePair<string, string>(o.Name, o.Value.GetString())).OrderBy(pair => pair.Key);
                            var buffer = new MemoryStream();
                            var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions()
                            {
                                Indented = true,
                                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
                            });
                            writer.WriteStartObject();
                            foreach (var (key, value) in pairs)
                            {
                                writer.WritePropertyName(key);
                                writer.WriteStringValue(value);
                            }
                            writer.WriteEndObject();
                            writer.Dispose();
                            buffer.Seek(0, SeekOrigin.Begin);
                            File.WriteAllText(filePath, buffer.ToArray().ToUTF8String());

                            r.AddAllFiles();
                            r.Commit($"Reorder file for {(file.Replace("\"", "\\\""))}", user);
                        }
                        else if (file.EndsWith(".lang"))
                        {
                            var lines = File.ReadAllLines(filePath).Where(line => !(line.StartsWith("#") || line.StartsWith("//") || line.IsNullOrWhiteSpace()));
                            File.WriteAllLines(filePath, lines.OrderBy(line => line.Split('=').FirstOrDefault() ?? ""));

                            r.AddAllFiles();
                            r.Commit($"Reorder file for {(file.Replace("\"", "\\\""))}", user);
                        }
                        else
                        {
                            sb.AppendLine("无法识别的文件。");
                        }

                        
                    }
                }

                if (repo.IsValueCreated)
                {
                    var r = GetRepo();
                    r.Push();
                    await AddReaction();
                        r.Dispose();
                }
            }
            catch (Exception e)
            {
                sb.AppendLine($"⚠ 在执行命令时遇到了问题：{e.Message}");
                Log.Warning(e, $"command processor #{prid}");
            }

            var result = sb.ToString();
            if (!result.IsNullOrWhiteSpace())
            {
                await GitHub.Instance.Issue.Comment.Create(Constants.Owner, Constants.RepoName, prid, $"@{user.Login} {result}");
            }

            async Task AddReaction()
            {
                if (addedReaction) return;
                addedReaction = true;
                //await GitHub.Instance.Reaction.CommitComment.Create(Constants.Owner, Constants.RepoName, commentID,
                //    new NewReaction(ReactionType.Rocket));
            }

            async Task<bool> CheckPermission()
            {
                var bypassList = new string[] { };
                var hasPermission =
                    await GitHub.Instance.Repository.Collaborator.IsCollaborator(Constants.Owner, Constants.RepoName, user.Login) 
                    || bypassList.Contains(user.Login)
                    || pr.User.Login == user.Login;
                if (!hasPermission)
                {
                    sb.AppendLine("⚠ 你没有执行此命令的权限。");
                }
                return hasPermission;
            }

            GitRepoManager GetRepo()
            {
                if (!repo.IsValueCreated)
                {
                    if (pr.Head.Repository.Owner.Login == Constants.Owner && pr.Head.Repository.Name == Constants.RepoName && pr.Head.Ref == "main")
                    {
                        throw new CommandException("⚠ 保护 main 分支，命令拒绝执行。");
                    }
                    repo.Value.Clone(pr.Head.Repository.Owner.Login, pr.Head.Repository.Name, pr.Head.Ref);
                }

                return repo.Value;
            }
        }


    }
}
