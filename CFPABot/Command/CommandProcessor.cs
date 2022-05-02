using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;

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
                        await File.WriteAllTextAsync(Path.Combine(r.WorkingDirectory, $"projects/{versionString}/assets/{curseForgeID}/{modID}/lang/{versionFile}"), files[0], new UTF8Encoding(false));

                        r.AddAllFiles();
                        r.Commit($"Update en_us file for {(curseForgeID.Replace("\"", "\\\""))}", user);
                    }
                }

                if (repo.IsValueCreated)
                {
                    var r = GetRepo();
                    r.Push();
                    await AddReaction();
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
                await GitHub.Instance.Issue.Comment.Create(Constants.Owner, Constants.RepoName, prid, $"@{user.Login}\n{result}");
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
                    sb.AppendLine("你没有执行此命令的权限。");
                }
                return hasPermission;
            }

            GitRepoManager GetRepo()
            {
                if (!repo.IsValueCreated)
                {
                    repo.Value.Clone(pr.Head.Repository.Owner.Login, pr.Head.Repository.Name, pr.Head.Ref);
                }

                return repo.Value;
            }
        }


    }
}
