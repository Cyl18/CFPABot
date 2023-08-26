using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using CFPABot.Command;
using CFPABot.DiffEngine;
using CFPABot.Exceptions;
using CFPABot.PRData;
using CFPABot.Resources;
using CurseForge.APIClient.Models.Files;
using CurseForge.APIClient.Models.Mods;
using DiffPatch.Data;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;
using Serilog.Core;
using Serilog.Core.Enrichers;
using File = System.IO.File;

namespace CFPABot.Utils
{
    public class CommentContext
    {
        public int ID { get; set; }
        public string ModLinkSegment { get; set; } = "";
        public string BuildArtifactsSegment { get; set; } = "";
        public string CheckSegment { get; set; } = "";
        public string UpdateSegment { get; set; } = "";
        public string DiffSegment { get; set; } = "";
        public string ReloadSegment { get; set; } = "- [ ] 🔄 勾选这个复选框来强制刷新";
    }
    public sealed class CommentBuilder
    {
        public CommentBuilder(int pullRequestID)
        {
            PullRequestID = pullRequestID;
            try
            {
                Context = !File.Exists(ContextFilePath) ? new CommentContext() { ID = pullRequestID } : JsonSerializer.Deserialize<CommentContext>(File.ReadAllText(ContextFilePath));

            }
            catch (Exception e)
            {
                Log.Error(e, "new CommentBuilder 失败");
                Context = new CommentContext() {ID = pullRequestID};
            }
        }

        public int PullRequestID { get; }
        string ContextFilePath => $"config/pr_context/{PullRequestID}.json";
        public CommentContext Context { get; private set; }
        void SaveContext()
        {
            lock (this)
            {
                File.WriteAllText(ContextFilePath, JsonSerializer.Serialize(Context));
            }
        }
        
        volatile int UpdatingCount = 0;

        public async Task Update(Func<Task> updateCallback)
        {
            try
            {
                Log.Debug($"开始更新 #{PullRequestID}。");
                await UpdateInternal(updateCallback);
                Log.Debug($"结束更新 #{PullRequestID}。");
            }
            catch (Exception e)
            {
                Log.Error(e, "Update issue comment error");
            }
        }

        ILogger logger => Log.Logger.ForContext(new PropertyEnricher("PR", PullRequestID));
        public async Task UpdateInternal(Func<Task> updateCallback)
        {
            // using var l = AcquireLock(nameof(Update));
            logger.Debug("获取 Diff...");
            var fileDiff = await GitHub.Diff(PullRequestID);
            if (Context.BuildArtifactsSegment.IsNullOrEmpty() && fileDiff.All(d => !d.To.StartsWith("projects/"))) return;
            
            IssueComment comment;
            using (await AcquireLock("UpdateLock"))
            {
                logger.Debug("获取 PR Comment...");
                var comments = await GitHub.GetPRComments(PullRequestID);
                comment = comments.FirstOrDefault(c => (c.User.Login == "Cyl18-Bot" || c.User.Login.Equals("cfpa-bot[bot]", StringComparison.OrdinalIgnoreCase)) && c.Body.StartsWith("<!--CYBOT-->"))
                          ?? await CreateComment();
            }

            logger.Debug("构建内容...");
            var sb2 = new StringBuilder();
            sb2.AppendLine(Context.ModLinkSegment);
            sb2.AppendLine("---");
            sb2.AppendLine(Context.BuildArtifactsSegment);
            if (!Context.CheckSegment.IsNullOrEmpty())
            {
                sb2.AppendLine("---");
                sb2.AppendLine(Context.CheckSegment);
            }
            sb2.AppendLine("---");
            sb2.AppendLine(Context.DiffSegment);
            sb2.AppendLine("---");
            sb2.AppendLine(Context.ReloadSegment);

            Interlocked.Increment(ref UpdatingCount);
            if (UpdatingCount > 0)
            {
                sb2.AppendLine("---");
                sb2.AppendLine("**:construction: 正在更新内容...**");
            }
            
            logger.Debug("第一次更新内容...");
            using (await AcquireLock("UpdateLock"))
            {
                await GitHub.Instance.Issue.Comment.Update(Constants.Owner, Constants.RepoName, comment.Id, "<!--CYBOT-->\n" + sb2.ToString());
            }

            try
            {
                await updateCallback();
                await UpdateCheckSegment(fileDiff);
                await UpdateDiffSegment();
            }
            catch (Exception e)
            {
                Console.WriteLine(e);
            }
            logger.Debug("内容构建完成...");

            Interlocked.Decrement(ref UpdatingCount);
            var sb = new StringBuilder();
            sb.AppendLine(Context.ModLinkSegment);
            sb.AppendLine("---");
            sb.AppendLine(Context.BuildArtifactsSegment);
            sb.AppendLine("---");
            sb.AppendLine(Context.CheckSegment);

            sb.AppendLine("---");
            sb.AppendLine(Context.DiffSegment);

            sb.AppendLine("---");
            sb.AppendLine(Context.ReloadSegment);

            if (UpdatingCount > 0)
            {
                sb.AppendLine("---");
                sb.AppendLine("**:construction: 正在更新内容...**");
            }
            using (await AcquireLock("UpdateLock"))
            {
                logger.Debug("第二次更新内容...");
                await GitHub.Instance.Issue.Comment.Update(Constants.Owner, Constants.RepoName, comment.Id, "<!--CYBOT-->\n" + sb.ToString());
            }
            SaveContext();
        }

        Task<IssueComment> CreateComment()
        {
            logger.Debug("新建 Comment...");
            return GitHub.Instance.Issue.Comment.Create(Constants.Owner, Constants.RepoName, PullRequestID, "<!--CYBOT-->\n" + "正在更新数据...");
        }

        public async Task UpdateModLinkSegment(FileDiff[] diffs)
        {
            using var l = await AcquireLock(nameof(UpdateModLinkSegment));
            var sb = new StringBuilder();
            var sb1 = new StringBuilder();

            try
            {
                var modInfos = PRAnalyzer.Run(diffs);
                var modids = modInfos.Select(m => m.CurseForgeID).Distinct().ToArray();
                if (modids.Length > 20)
                {
                    sb.AppendLine(Locale.ModLink_TooManyMods);
                    return;
                }

                var addons = new List<Mod>();
                foreach (var modid in modids)
                {
                    try
                    {
                        addons.Add(await CurseManager.GetAddon(modid));
                    }
                    catch (CheckException e)
                    {
                        sb.AppendLine(e.Message);
                    }
                }

                if (addons.Count == 0)
                {
                    sb.AppendLine("ℹ 此 PR 没有检测到 CurseForge 模组修改。");
                    return;
                }

                // todo 重构一个 escape markdown
                sb1.AppendLine("|     | 模组 | 🔗 链接 | :art: 相关文件 |");
                sb1.AppendLine("| --- | --- | --- | --- |");
                int modCount = 0;
                foreach (var addon in addons)
                {
                    modCount++;
                    try
                    {
                        var infos = modInfos.Where(i => i.CurseForgeID == addon.Slug).ToArray();
                        var versions = infos.Select(i => i.Version).ToArray();
                        sb1.AppendLine($"| " +
                        /* Thumbnail*/ $"{await CurseManager.GetThumbnailText(addon)} |" +
                        /* Mod Name */ $" [**{addon.Name.Trim().Replace("[","\\[").Replace("]", "\\]").Replace("|", "\\|")}**]({addon.Links.WebsiteUrl}) |" +
                        // /* Mod ID   */ $" {await CurseManager.GetModID(addon, versions.FirstOrDefault(), enforcedLang: true)} |" + // 这里应该enforce吗？
                        /* Source   */ $" {CurseManager.GetRepoText(addon)} \\|" +
                        /* Mcmod    */ $" [🟩 MCMOD](https://cn.bing.com/search?q=site:mcmod.cn%20{HttpUtility.UrlEncode(addon.Name)}) \\|" +
                        /* Compare  */ $" [:file_folder: 对比(新！)](https://cfpa.cyan.cafe/Azusa/Diff/{PullRequestID}/{addon.Slug}) |" +
                        /* Mod DL   */ $" {CurseManager.GetDownloadsText(addon, versions)}{await CurseManager.GetModRepoLinkText(addon, infos)} |" +
                        ""
                        );

                        try
                        {
                            var addonModel = await CurseManager.GetAddon(addon.Id);
                            var deps = addonModel.LatestFiles.OrderByDescending(a => a.FileDate).FirstOrDefault(a => a.Dependencies.Any())?.Dependencies;
                            var distinctSet = new HashSet<int>();
                            if (deps != null)
                            {
                                foreach (var dep in deps)
                                {
                                    if (dep.RelationType != FileRelationType.RequiredDependency) continue;
                                    // 2 都是附属
                                    // 3 是需要的
                                    // 还没遇到 1
                                    if (distinctSet.Contains(dep.ModId)) continue;
                                    var depAddon = await CurseManager.GetAddon(dep.ModId);
                                    distinctSet.Add(dep.ModId);
                                    modCount++;

                                    sb1.AppendLine($"| " +
                                        /* Thumbnail*/ $" {await CurseManager.GetThumbnailText(depAddon)} |" +
                                        /* Mod Name */ $" 依赖-[*{depAddon.Name.Replace("[", "\\[").Replace("]", "\\]")}*]({depAddon.Links.WebsiteUrl}) |" +
                                        // /* Mod ID   */ $" \\* |" +
                                        /* Source   */ $" {CurseManager.GetRepoText(addonModel)} \\|" +
                                        /* Mcmod    */ $" [🟩 MCMOD](https://cn.bing.com/search?q=site:mcmod.cn%20{HttpUtility.UrlEncode(depAddon.Name)}) \\|" +
                                        /* Compare  */ $" &nbsp;&nbsp;* |" +
                                        /* Mod DL   */ $" {CurseManager.GetDownloadsText(depAddon, versions)} |" +
                                        ""
                                    );
                                }
                            }
                        }
                        catch (Exception e)
                        {
                            Log.Error(e, "获取依赖失败");
                        }
                        
                    }               
                    catch (Exception e)
                    {
                        sb1.AppendLine($"| | [链接]({addon.Links.WebsiteUrl}) | {e.Message} | |");
                        Log.Error(e, "UpdateModLinkSegment");
                    }
                }

                if (modCount > 8)
                {
                    sb.AppendLine($"<details> <summary>模组列表</summary> \n\n{sb1.ToString()}\n\n</details>");
                }
                else
                {
                    sb.AppendLine(sb1.ToString());
                }

            }
            catch (Exception e)
            {
                Log.Error(e, "更新 mod 列表出错");
                sb.AppendLine(sb1.ToString());
                sb.AppendLine();
                sb.AppendLine(string.Format(Locale.ModLink_Error, e.Message));
            }
            finally
            {
                Context.ModLinkSegment = sb.ToString();
            }

        }

        public async Task UpdateBuildArtifactsSegment()
        {
            if (IsMoreThanTwoWaiting(nameof(UpdateBuildArtifactsSegment))) return;
            using var l = await AcquireLock(nameof(UpdateBuildArtifactsSegment));
            var sb = new StringBuilder();
            try
            {
                var pr = await GitHub.GetPullRequest(PullRequestID);

                if (pr.Base.Ref != "main")
                {
                    sb.AppendLine(Locale.Artifacts_BranchNotMain);
                    sb.AppendLine();
                    sb.AppendLine("---");
                    sb.AppendLine();
                }

                if (pr.MaintainerCanModify == false && pr.Head.Repository.Owner.Login != Constants.Owner && pr.State.Value == ItemState.Open)
                {
                    sb.AppendLine(Locale.Artifacts_PREditDisabledWarning);
                    sb.AppendLine($"![1](https://docs.github.com/assets/cb-44583/images/help/pull_requests/allow-maintainers-to-make-edits-sidebar-checkbox.png)");
                    sb.AppendLine();
                    sb.AppendLine("---");
                    sb.AppendLine();
                }




                var checkSuites = await GitHub.Instance.Check.Suite.GetAllForReference(Constants.Owner, Constants.RepoName,
                    pr.Head.Sha);
                var tasks = checkSuites.CheckSuites
                    .Where(suite => suite.App.Name == "GitHub Actions")
                    .Select(suite => GitHub.GetPackerWorkflowRunFromCheckSuiteID(suite.Id)).ToArray();
                await Task.WhenAll(tasks);
                var workflowRun = tasks.FirstOrDefault(task => task.Result != null)?.Result;
                if (workflowRun == null)
                {
                    sb.AppendLine(pr.State.Value switch
                    {
                        ItemState.Open => Locale.Artifacts_NoWorkflowYet,
                        ItemState.Closed => ":milky_way: PR 已经关闭。",
                        _ => throw new ArgumentOutOfRangeException()
                    });
                    return;
                }

                if (workflowRun.Conclusion == "action_required")
                {
                    var diff = await GitHub.Diff(pr.Number);
                    var blacklist = new[] {".github", "src"};
                    if (diff.Any(f => blacklist.Any(black => f.To.StartsWith(black) || f.From.StartsWith(black))))
                    {
                        sb.AppendLine("ℹ 由于修改了源代码，不能自动批准执行 PR Packer。");
                        return;
                    }

                    await GitHub.ApproveWorkflowRun(workflowRun.Id);
                    sb.AppendLine("ℹ 已经自动批准打包器执行，可能需要等待一段时间。");
                    return;
                }

                if (workflowRun.Status is "queued" or "in_progress")
                {
                    sb.AppendLine(pr.State.Value switch
                    {
                        ItemState.Open => ":milky_way: 打包器正在执行, 请耐心等待。",
                        ItemState.Closed => ":milky_way: PR 已经关闭。",
                        _ => throw new ArgumentOutOfRangeException()
                    });
                    return;
                }

                var artifacts = await GitHub.GetArtifactFromWorkflowRun(workflowRun);

                if (artifacts.TotalCount == 0)
                {
                    sb.AppendLine("ℹ 此 PR 没有更改语言文件或者 PR-Packer 出现了问题。");
                    return;
                }

                sb.AppendLine(":floppy_disk: 基于此 PR 所打包的资源包：");
                foreach (var artifact in artifacts.Artifacts)
                {
                    sb.AppendLine($"- [{artifact.Name}.zip]({artifact.ArchiveDownloadUrl.Replace("/zip", ".zip").Replace("api.github.com/repos", "nightly.link")})");
                }

                // v2
                // sb.AppendLine(string.Format(Locale.Artifacts_Hint, Constants.BaseRepo, PullRequestID));

                // v1
                //                 switch (checkRun.Status.Value)
                //                 {
                //                     case CheckStatus.Queued:
                //                         sb.AppendLine($"⚠ 正在等待打包器执行.");
                //                         break;
                //                     case CheckStatus.InProgress:
                //                         sb.AppendLine($":milky_way: 打包器正在执行, 请耐心等待.");
                //                         break;
                //                     case CheckStatus.Completed:
                //                         sb.AppendLine($":floppy_disk: 基于此 PR 所打包的完整汉化资源包 ({checkRun.HeadSha}/{DateTimeOffset.UtcNow.AddHours(8):s} UTC+8):");
                //                         // 修不好了
                //                         /*
                //                         try
                //                         {
                //                             var artifactsFromWorkflowRunID = await GitHub.GetArtifactsFromWorkflowRunID(checkRun.Id.ToString());
                //                             if (artifactsFromWorkflowRunID.TotalCount == 0) sb.Append("没有。");
                //
                //                             foreach (var ar in artifactsFromWorkflowRunID.Artifacts)
                //                             {
                //                                 sb.Append($"{ar.Name.Split("-").Last()} ");
                //                             }
                //                         }
                //                         catch (Exception e)
                //                         {
                //
                //                         }
                //                         */
                //                         sb.AppendLine($"    在 [链接]({Constants.BaseRepo}/pull/{PullRequestID}/checks) 处点击 Artifacts 下载。");
                //                         break;
                //                 }


            }
            catch (Exception e)
            {
                Log.Error(e, "更新编译 artifacts 出错");
                sb.AppendLine(string.Format(Locale.Artifacts_Error, e.Message));
            }
            finally
            {
                Context.BuildArtifactsSegment = sb.ToString();
            }
        }

        public async Task UpdateDiffSegment()
        {
            if (IsMoreThanTwoWaiting(nameof(UpdateDiffSegment))) return;
            using var l = await AcquireLock(nameof(UpdateDiffSegment));
            string result = null;
            try
            {

                var sb = new StringBuilder();
                var exceptionList = new List<Exception>();
                var list = await LangFileFetcher.FromPR(PullRequestID, exceptionList);
                sb.AppendLine();
                sb.AppendLine("🔛 Diff： ");
                sb.AppendLine();

                void AddLine(string sourceEn, string currentEn, StringBuilder stringBuilder, string sourceCn,
                    string currentCn)
                {
                    if (sourceEn.IsNullOrWhiteSpace())
                    {
                        if (currentEn.IsNullOrWhiteSpace())
                        {
                            stringBuilder.Append("⛔");
                        }
                        else
                        {
                            stringBuilder.Append($"{currentEn}");
                        }
                    }
                    else
                    {
                        if (sourceEn.Trim() == currentEn.Trim())
                        {
                            stringBuilder.Append($"{currentEn}");
                        }
                        else
                        {
                            stringBuilder.Append($"{sourceEn}<br>🔽<br>{currentEn}");
                        }
                    }

                    stringBuilder.Append(" | ");

                    if (sourceCn.IsNullOrWhiteSpace())
                    {
                        if (currentCn.IsNullOrWhiteSpace())
                        {
                            stringBuilder.Append("⛔");
                        }
                        else
                        {
                            stringBuilder.Append($"{currentCn}");
                        }
                    }
                    else
                    {
                        stringBuilder.Append($"{sourceCn}<br>🔽<br>{currentCn}");
                    }
                }

                foreach (var o in list)
                {
                    var diffLines = LangDiffer.Run(o);

                    sb.AppendLine($"<details><summary>{o.ModPath}</summary>\n");
                    sb.AppendLine("| 英文 | 中文 |");
                    sb.AppendLine("| --: | :------------- |");
                    foreach (var (key, sourceEn, currentEn, sourceCn, currentCn) in diffLines)
                    {
                        if (sourceCn == currentCn || currentEn.IsNullOrWhiteSpace() && currentCn.IsNullOrWhiteSpace())
                            continue;
                        sb.Append("| ");
                        AddLine(sourceEn, currentEn, sb, sourceCn, currentCn);

                        sb.AppendLine(" |");
                    }

                    sb.AppendLine("\n</details>\n\n");


                    sb.AppendLine($"<details><summary>{o.ModPath}-keys</summary>\n");
                    sb.AppendLine("| Key | 英文 | 中文 |");
                    sb.AppendLine("| - | --: | :------------- |");
                    foreach (var (key, sourceEn, currentEn, sourceCn, currentCn) in diffLines)
                    {
                        if (sourceCn == currentCn || currentEn.IsNullOrWhiteSpace() && currentCn.IsNullOrWhiteSpace())
                            continue;

                        sb.Append("| ");
                        sb.Append($" `{key}` |");
                        AddLine(sourceEn, currentEn, sb, sourceCn, currentCn);

                        sb.AppendLine(" |");
                    }

                    sb.AppendLine("\n</details>\n");


                    sb.AppendLine($"<details><summary>{o.ModPath}-术语检查</summary>\n");
                    sb.AppendLine("| Key | 英文 | 中文 | 检查结果 |");
                    sb.AppendLine("| - | --: | :------------- | - |");
                    foreach (var (key, sourceEn, currentEn, sourceCn, currentCn) in diffLines)
                    {
                        if (sourceCn == currentCn || currentEn.IsNullOrWhiteSpace() && currentCn.IsNullOrWhiteSpace())
                            continue;

                        string termTextResult = "中文或英文为空";
                        var termResult = currentEn != null && currentCn != null &&
                                         CommandProcessor.CheckTerms(currentEn.ToLower(), currentCn.ToLower(),
                                             out termTextResult);
                        if (!termResult) continue;

                        sb.Append("| ");
                        sb.Append($" `{key}` |");
                        AddLine(sourceEn, currentEn, sb, sourceCn, currentCn);
                        sb.Append($" | {termTextResult.Replace("\n", "<br>")} | ");
                        sb.AppendLine(" |");
                    }

                    sb.AppendLine("\n</details>\n");

                }

                if (exceptionList.Any())
                {
                    sb.AppendLine($"异常：\n```\n{exceptionList.Select(e => e.ToString()).Connect("\n\n")}\n```");
                }

                result = sb.ToString() + "\n";
                if (result.Length > 20000)
                {
                    try
                    {
                        result = $"PR: <https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/{PullRequestID}>\n\n" + result; // 来自 mamaruo 的请求
                        var gist = await GitHub.InstancePersonal.Gist.Create(new NewGist()
                        {
                            Description = $"pr-{PullRequestID}-diff", Files = {{$"pr-{PullRequestID}-diff.md", result}},
                            Public = false
                        });
                        result = $"🔛 Diff 内容过长，已经上传至 <{gist.HtmlUrl}>。\n";
                    }
                    catch (Exception e)
                    {
                        Log.Error(e, "Upload Gist");
                    }
                }

            }
            catch (Exception e)
            {
                Context.DiffSegment = $"{e}\n";
            }
            finally
            {
                Context.DiffSegment = result;
            }
        }

        public async Task UpdateCheckSegment(FileDiff[] diffs)
        {
            if (IsMoreThanTwoWaiting(nameof(UpdateCheckSegment))) return;
            using var l = await AcquireLock(nameof(UpdateCheckSegment));
            var sb = new StringBuilder();
            var reportSb = new StringBuilder();
            
            // 如果能用 就不要动屎山 写这一行的时候下面有299行代码
            // 现在有391行 哈哈
            try
            {
                var pr = await GitHub.GetPullRequest(PullRequestID);
                
                var fileName = $"{pr.Number}-{pr.Head.Sha.Substring(0, 7)}.txt";
                var filePath = "wwwroot/" + fileName;
                var webPath = $"https://cfpa.cyan.cafe/static/{fileName}";
                if (File.Exists(filePath) && Context.CheckSegment != "") { return; }
                
                if (diffs.Length > 1000)
                {
                    sb.AppendLine(Locale.Check_General_ToManyFiles);
                    return;
                }


                var modSlugs = new HashSet<string>();

                // pr 关系检查
                foreach (var diff in diffs.Where(x => x.To.StartsWith("projects") && x.To.Count(c => c == '/') > 5))
                {
                    try
                    {
                        var modPath = new ModPath(diff.To);
                        modSlugs.Add(modPath.CurseForgeSlug);
                    }
                    catch (Exception e)
                    {
                        Log.Information(e.ToString());
                    }
                }

                var relFlag = false;
                if (modSlugs.Count > 10)
                {
                    if (modSlugs.Any(x => PRDataManager.Relation.TryGetValue(x, out _)))
                    {
                        relFlag = true;
                        sb.Append($"ℹ 有很多模组在 ");
                        var hs = new HashSet<int>();
                        foreach (var modSlug in modSlugs)
                        {
                            if (PRDataManager.Relation.TryGetValue(modSlug, out var x) && x.Any(y => y.prid != PullRequestID))
                            {
                                var relPrids = x.Where(y => y.prid != PullRequestID).Select(y => y.prid).Distinct();
                                foreach (var relPrid in relPrids)
                                {
                                    if (!hs.Add(relPrid))
                                    {
                                        sb.Append($"#{relPrid} ");
                                    }
                                }
                            }
                        }

                        sb.Append("中有提交");

                    }
                }
                else
                {
                    foreach (var modSlug in modSlugs)
                    {
                        if (PRDataManager.Relation.TryGetValue(modSlug, out var x) && x.Any(y => y.prid != PullRequestID))
                        {
                            relFlag = true;
                            sb.AppendLine($"ℹ {modSlug} 在其它 PR 中有提交：");
                            var relPrids = x.Where(y => y.prid != PullRequestID).Select(y => y.prid).Distinct();
                            foreach (var relPrid in relPrids)
                            {
                                sb.AppendLine($"  - #{relPrid} 中包含此模组的 {x.Where(y => y.prid == relPrid).Select(y => ModPath.GetVersionDirectory(y.modVersion.MinecraftVersion, y.modVersion.ModLoader)).Distinct().Connect()} 版本");
                            }

                            sb.AppendLine();
                        }
                    }
                }
                
                if (relFlag)
                {
                    sb.AppendLine("");
                    sb.AppendLine("---");
                    sb.AppendLine("");
                }


                if (diffs.Any(diff => diff.To.Split('/').Any(s => s == "patchouli_book")))
                {
                    sb.AppendLine("⚠ 检测到了一个名为 patchouli_book 的文件夹。你可能想说的是 patchouli_books？");
                }

                // if (diffs.Any(diff => diff.To.Split('/').Any(s => s.Contains(" "))))
                // {
                //     sb.AppendLine($"⚠ 检测到了含有空格的路径。例如： `{(diffs.Any(diff => diff.To.Split('/').Any(s => s.Contains(" "))))}`");
                // }

                if (diffs.Any(diff => !diff.To.ToCharArray().All(x => char.IsDigit(x) || char.IsLower(x) || x is '_' or '-' or '.' or '/') && diff.To.Contains("lang")))
                {
                    sb.AppendLine($"⚠⚠⚠ **检测到了可能不合规的路径。**");
                    sb.AppendLine($"⚠⚠⚠ **检测到了可能不合规的路径。**");
                    sb.AppendLine($"⚠⚠⚠ **检测到了可能不合规的路径。**");
                    sb.AppendLine($"⚠⚠⚠ 例如： `{diffs.First(diff => !diff.To.ToCharArray().All(x => char.IsDigit(x) || char.IsLower(x) || x is '_' or '-' or '.' or '/') && diff.To.Contains("lang")).To}`");
                    sb.AppendLine($"⚠⚠⚠ 转到 <a href=\"https://cfpa.cyan.cafe/api/Utils/PathValidation?pr={PullRequestID}\" rel=\"nofollow\">这里</a> 来查看所有不合规的路径。");
                    sb.AppendLine();
                }

                

                #region 检查常见的路径提交错误

                foreach (var diff in diffs.Where(d => d.To.ToLower().Contains("zh_cn")).Where(d => d.To.Split('/').Length < 7).Take(5))
                {
                    var names = diff.To.Split('/');
                    using var iter = names.AsEnumerable().GetEnumerator();
                    if (names.Length == 1)
                    {
                        sb.AppendLine($"⚠ 检测到了一个语言文件，但是提交的路径不正常。请检查你的提交路径：`{diff.To}`");
                        continue;
                    }

                    if (names.FirstOrDefault() != "projects") continue;

                    if (names.Length < 5)
                    {
                        sb.AppendLine($"⚠ 检测到了一个语言文件，但是提交的路径不正常。请检查你的提交路径：`{diff.To}`");
                        continue;
                    }
                    // projects/{version}/assets/{curseSlug}/{modDomain}/lang/zh_cn.{}
                    try
                    {
                        if (names.Length == 5)
                        {
                            // projects/{version}/assets/{curseSlug}/{modDomain}/lang/zh_cn.{}
                            if (names[2] != "assets" || names[3] == "lang") goto fail;
                            sb.AppendLine($"⚠ 检测到了一个语言文件，但是提交的路径不正常。缺少了 {{modDomain}} 和 lang 文件夹。请检查你的提交路径：`{diff.To}`；");
                            try
                            {
                                var addon = await CurseManager.GetAddon(names[3]);
                                var modDomain =
                                    await CurseManager.GetModID(addon, names[1].ToMCStandardVersion(), true, false);
                                var rdir = $"projects/{names[1]}/assets/{names[3]}/{modDomain}/lang/";
                                sb.AppendLine($"  自动找到了该模组的 Mod Domain 为 `{modDomain}`，可能的正确文件夹为 `{rdir}`。你可以使用命令 `/mv-recursive \"{names.Take(4).Connect("/")}/\" \"{rdir}\"` 来移动路径。");
                                sb.AppendLine();
                            }
                            catch (Exception)
                            {
                                sb.AppendLine($"  无法找到该模组的 Mod Domain。");
                                sb.AppendLine();

                                // mod addon 找不到
                            }
                        }
                        
                        if (names.Length == 6)
                        {
                            if (names[2] != "assets" || names[3] == "lang") goto fail;

                            if (names[4] == "lang")
                            {
                                // projects/{version}/assets/{curseSlug}/lang/zh_cn.{}
                                sb.AppendLine($"⚠ 检测到了一个语言文件，但是提交的路径不正常。缺少了 {{ModDomain}} 或 {{CurseForge 项目名}} 文件夹。请检查你的提交路径：`{diff.To}`；");
                                try
                                {
                                    var addon = await CurseManager.GetAddon(names[3]);
                                    var modDomain =
                                        await CurseManager.GetModID(addon, names[1].ToMCStandardVersion(), true, false);
                                    var rdir = $"projects/{names[1]}/assets/{names[3]}/{modDomain}/lang/";
                                    sb.AppendLine($"  自动找到了该模组的 Mod Domain 为 `{modDomain}`，可能的正确文件夹为 `{rdir}`。 你可以使用命令 `/mv-recursive \"{names.Take(5).Connect("/")}/\" \"{rdir}\"` 来移动路径。");
                                    sb.AppendLine();
                                }
                                catch (Exception)
                                {
                                    sb.AppendLine($"  无法找到该模组的 Mod Domain。");
                                    sb.AppendLine();

                                    // mod addon 找不到
                                }
                            }
                            else
                            {
                                // projects/{version}/assets/{curseSlug}/{modDomain}/zh_cn.{}
                                sb.AppendLine($"⚠ 检测到了一个语言文件，但是提交的路径不正常。缺少了 lang 文件夹。请检查你的提交路径：`{diff.To}`；");
                                sb.AppendLine();
                            }
                        }

                        continue;
                        fail:
                        sb.AppendLine($"⚠ 检测到了一个语言文件，但是提交的路径不正常。请检查你的提交路径：`{diff.To}`");
                        sb.AppendLine();
                    }
                    catch (Exception e)
                    {
                        Log.Warning(e, "Report invalid dir");
                        sb.AppendLine($"⚠ 检测到了一个语言文件，但是提交的路径不正常。请检查你的提交路径：`{diff.To}`");
                        sb.AppendLine();
                    }
                }

                #endregion

                // 检查大小写
                var reportedCap = false;
                var reportedKey = false;

                foreach (var diff in diffs)
                {
                    var names = diff.To.Split('/');
                    if (names.Length < 7) continue; // 超级硬编码
                    if (names[0] != "projects") continue;
                    if (names[5] != "lang") continue; // 只检查语言文件
                    
                    if (names.Any(s => s.ToLower() != s && s != "1UNKNOWN"))
                    {
                        reportSb.AppendLine($"检测到大写字母：{diff.To}");
                        if (!reportedCap)
                        {
                            sb.AppendLine(string.Format(Locale.Check_UpperCaseWarning, diff.To));
                            reportedCap = true;
                        }
                    }
                }
                var flagMCreator = true;

                // 检查中英文 key 是否对应
                // 检查 ModID
                var checkedSet = new HashSet<(string version, string curseID)>();
                foreach (var diff in diffs)
                {
                    var names = diff.To.Split('/');
                    if (names.Length < 7) continue; // 超级硬编码
                    if (names[0] != "projects") continue;
                    if (names[5] != "lang") continue;

                    var versionString = names[1];
                    var curseID = names[3];
                    var modid = names[4];
                    var check = (versionString, curseID);
                    var mcVersion = versionString.ToMCVersion();
                    
                    if (checkedSet.Contains(check)) continue;
                    checkedSet.Add(check);
                    Mod addon = null;
                    try
                    {
                        if (curseID != "1UNKNOWN")
                            addon = await CurseManager.GetAddon(curseID);
                    }
                    catch (Exception)
                    {
                        sb.AppendLine(string.Format(Locale.Check_ModID_ModNotFound, curseID, versionString));
                    }
                    if (addon != null)
                        try
                        {
                            var filemodid = await CurseManager.GetModIDForCheck(addon, mcVersion);
                            if (filemodid == null || filemodid.Length == 0)
                            {
                                if (addon.AllowModDistribution == false)
                                {
                                    sb.AppendLine($"ℹ {modid} 的作者不允许此模组自动下载，Bot 无法自动获取 Mod Domain。");
                                }
                                else
                                {
                                    sb.AppendLine(string.Format(Locale.Check_ModID_ModIDNotFound, modid));
                                }

                            }
                            if (filemodid.Any(id => id == modid))
                            {
                                sb.AppendLine(string.Format(Locale.Check_ModID_Success, modid));
                            }
                            else
                            {
                                sb.AppendLine(string.Format(Locale.Check_ModID_Failed_1, filemodid.Connect("/"), modid));
                                sb.AppendLine(string.Format(Locale.Check_ModID_Failed_2, versionString, curseID, modid, versionString, curseID, (filemodid.Length != 1 ? "{MOD_DOMAIN}" : filemodid[0])));
                            
                                //continue;
                            }
                        }
                        catch (Exception e)
                        {
                            sb.AppendLine(string.Format(Locale.Check_ModID_Error, e.Message));
                        }

                    if (addon?.Categories.Any(x => x.Id == 4906/*MCreator*/) == true && flagMCreator)
                    {
                        try
                        {
                            flagMCreator = false;
                            GitHub.Instance.Issue.Labels.AddToIssue(Constants.RepoID, PullRequestID, new []{"MCreator"});
                        }
                        catch (Exception e)
                        {
                            logger.Error(e, "add mcreator label");
                        }
                    }

                    // 检查文件
                    reportSb.AppendLine($"开始检查 {modid} {versionString}");
                    var headSha = pr.Head.Sha;
                    var enlink = $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/{headSha}/projects/{versionString}/assets/{curseID}/{modid}/lang/{mcVersion.ToENLangFile()}";
                    var cnlink = $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/{headSha}/projects/{versionString}/assets/{curseID}/{modid}/lang/{mcVersion.ToCNLangFile()}";
                    
                    string cnfile = null, enfile = null;
                    string[] modENFile = null;
                    string downloadModName = null;

                    try
                    {
                        cnfile = await Download.String(cnlink);
                    }
                    catch (Exception)
                    {
                        try
                        {
                            cnfile = await Download.String(cnlink.Replace("zh_cn", "zh_CN"));
                        }
                        catch (Exception)
                        {
                            sb.AppendLine(string.Format(Locale.Check_FileKey_FailedToDownloadCn, modid, versionString));
                        }
                    }

                    try
                    {
                        enfile = await Download.String(enlink);
                    }
                    catch (Exception)
                    {
                        try
                        {
                            enfile = await Download.String(enlink.Replace("en_us", "en_US"));
                        }
                        catch (Exception)
                        {
                            sb.AppendLine(string.Format(Locale.Check_FileKey_FailedToDownloadEn, modid, versionString, curseID, versionString));
                        }
                    }

                    try
                    {
                        if (addon != null && names[3] != "1UNKNOWN")
                        {
                            (modENFile, downloadModName) = await CurseManager.GetModEnFile(addon, mcVersion, LangType.EN);
                        }
                    }
                    catch (Exception e)
                    {
                        sb.AppendFormat(Locale.Check_FileKey_FailedToDownloadMod, modid);
                        Console.WriteLine(e);
                    }

                    // 检查 PR 提供的中英文 Key
                    bool keyResult = false;
                    if (cnfile != null && enfile != null)
                        keyResult = KeyAnalyzer.Analyze(modid, enfile, cnfile, mcVersion, sb, reportSb);
                    var modKeyResult = false;
                    // 检查英文Key和Mod内英文Key
                    do
                    {
                        if (modENFile != null && enfile != null)
                        {
                            if (modENFile.Length == 0)
                            {
                                sb.AppendLine(string.Format(Locale.Check_FileKey_ModEnFile_NotFound, modid, versionString));
                                break;
                            }
                            if (modENFile.Length > 1)
                            {
                                sb.AppendLine(string.Format(Locale.Check_FileKey_ModEnFile_Multiple, modid, versionString));
                                //Log.Information($"[pr/{PullRequestID}] 找到了多个语言文件 {modid}-{versionString} [{modENFile.Connect()}]");
                                break;
                            }

                            if (addon == null) break;
                            
                            modKeyResult = ModKeyAnalyzer.Analyze(new ModInfoForCheck(modid, mcVersion, downloadModName, curseID), enfile, modENFile[0], sb, reportSb);
                        }
                    } while (false);
                    


                    if (keyResult || modKeyResult)
                    {
                        reportedKey = true;
                    }

                    sb.AppendLine();
                }

                // typo check
                var typoResult = false;

                (string checkname, string message, Predicate<(LineDiff diff, MCVersion version)> customCheck)[] warnings = {
                    ("萤石", "请注意区分`荧石`（下界的一种发光方块）与`萤石`（氟化钙）", null),
                    ("凋零", "请注意区分`凋零`（药水效果）与`凋灵`（敌对生物）", null),
                    ("下届", "可能是`下界`", null),
                    ("合成台", "可能是`工作台`", null),
                    ("岩浆", "可能是`熔岩`，具体请**参考英文原文**（`magma`/`lava`）", t => !t.diff.Content.Contains("岩浆块") && !t.diff.Content.Contains("岩浆怪") && !t.diff.Content.Contains("岩浆膏")),
                    ("粉色", "原版译名采用`粉红色`，**如果上下文中有原版的 16 色才需要更改**", t => !t.diff.Content.Contains("浅粉色") && !t.diff.Content.Contains("艳粉色") && !t.diff.Content.Contains("亮粉色")),
                    ("地狱", "`地狱`在 1.16 后更名为`下界`", tuple => tuple.version != MCVersion.v1122),
                    ("漂浮", "请注意区分`漂浮`和`飘浮`", null),
                    ("錾制", "在 1.19.2 后更名为`雕纹`，**如果原文为 Chiseled 则需要更改**", x => x.version >= MCVersion.v119),
                    ("菌丝", "在 1.19.2 后更名为`菌丝体`", x => x.version >= MCVersion.v119),
                    ("速度", "请注意区分 1.19.4 后的`速度`（属性）与`迅捷`（状态效果）", x => x.version >= MCVersion.v119),
                    ("迅捷", "请注意区分 1.19.4 后的`速度`（属性）与`迅捷`（状态效果）", x => x.version >= MCVersion.v119),
                    ("防火", "在 1.19.4 后更名为`抗火`", x => x.version >= MCVersion.v119),
                    ("末影", "可能是`末地`，具体请**参考英文原文**（`Ender/End`）", x => x.version >= MCVersion.v119),
                    ("潜声", "你想说的可能是`幽匿（Sculk）`？", x => x.version >= MCVersion.v119),
                    ("粘土", "在 1.16.5 后更名为 `黏土`", x => x.version != MCVersion.v1122),
                    ("粘液", "在 1.16.5 后更名为 `黏液`", x => x.version != MCVersion.v1122),
                    ("猪人", "你想说的可能是`猪灵（Piglin）？`", x => x.version != MCVersion.v1122),
                };
                (string checkname, string message, Predicate<(LineDiff diff, MCVersion version)> customCheck)[] errors = {
                    ("爬行者", "`爬行者`在 1.15 后更名为`苦力怕`", tuple => tuple.version != MCVersion.v1122),
                    ("刷怪箱", "`刷怪箱`在 1.16 后更名为`刷怪笼`", tuple => tuple.version != MCVersion.v1122),
                    ("浅灰色", "原版译名采用`淡灰色`", null),
                    ("迷之炖菜", "在 1.19.2 后更名为`谜之炖菜`", x => x.version >= MCVersion.v119 && x.diff.Content.Contains("迷之炖菜")),
                    ("摔落保护", "在 1.19.4 后更名为`摔落缓冲`", x => x.version >= MCVersion.v119)
                };
                // 俺的服务器只有1个U 就不写多线程力
                var diffCheckedSet = new HashSet<string>();
                foreach (var diff in diffs)
                {
                    var names = diff.To.Split('/');
                    if (names.Length < 7) continue; // 超级硬编码
                    if (names[0] != "projects") continue;
                    if (!names[6].Contains("zh")) continue; // 只检查中文文件
                    foreach (var chunk in diff.Chunks)
                    {
                        foreach (var lineDiff in chunk.Changes.Where(line => line.Type != LineChangeType.Delete)) // fix https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/1946
                        {
                            var content = lineDiff.Content;
                            
                            var mcVersion = names[1].ToMCVersion();
                            foreach (var (checkname, message, customCheck) in warnings)
                            {
                                if (content.Contains(checkname) && (customCheck == null || customCheck((lineDiff, mcVersion))))
                                {
                                    // 进行一个警告的给
                                    if (!diffCheckedSet.Contains(checkname))
                                    {
                                        typoResult = true;
                                        diffCheckedSet.Add(checkname);
                                        // {lineDiff.NewIndex}-
                                        sb.AppendLine(
                                            string.Format(Locale.Check_Translate_PossibleControversial, checkname, message, ShortenLine(lineDiff.Content.Replace("`", "\\`"), checkname, mcVersion)));
                                    }

                                    reportSb.AppendLine(
                                        $"检测到争议译名：{checkname} {diff.To}-{lineDiff.NewIndex}: {lineDiff.Content}");
                                }
                            }

                            foreach (var (checkname, message, customCheck) in errors)
                            {
                                if (content.Contains(checkname) && (customCheck == null || customCheck((lineDiff, mcVersion))))
                                {
                                    // 进行一个错误的给
                                    if (!diffCheckedSet.Contains(checkname))
                                    {
                                        typoResult = true;
                                        diffCheckedSet.Add(checkname);
                                        // todo 显示哪一行
                                        // {lineDiff.NewIndex}-
                                        sb.AppendLine(
                                            string.Format(Locale.Check_Translate_PossibleWrong, checkname, message, ShortenLine(lineDiff.Content.Replace("`", "\\`"), checkname, mcVersion)));
                                    }

                                    reportSb.AppendLine(
                                        $"检测到错误译名：{checkname} {diff.To}-{lineDiff.NewIndex}: {lineDiff.Content}");
                                }
                            }
                        }
                    }
                    
                    
                }

                if (reportedCap || reportedKey || typoResult)
                {
                    var report = reportSb.ToString();
                    await File.WriteAllTextAsync(filePath, report);
                    if (report.Length > 30000) // GitHub issues 字数链接理论65536
                    {
                        sb.AppendLine();
                        if (typoResult)
                        {
                            sb.AppendLine(Locale.Check_Translate_Hint);
                        }
                        sb.AppendLine(string.Format(Locale.Check_Result, webPath));
                    }
                    else
                    {
                        sb.Append($"\n<details> <summary>详细检查报告</summary> \n");
                        sb.Append(report.Replace("\n", "<br>").Replace(" ", "&nbsp;"));
                        sb.Append($"</details>\n\n");
                        if (typoResult)
                        {
                            sb.AppendLine(Locale.Check_Translate_Hint);
                        }
                        sb.AppendLine(string.Format(Locale.Check_Result1, webPath));
                        
                    }
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "检查出错");
                sb.AppendLine(string.Format(Locale.Check_Error, e.Message));
            }
            finally
            {
                var c = sb.ToString();
                if (!c.IsNullOrWhiteSpace())
                {
                    Context.CheckSegment = c;
                }
            }
        }

        string ShortenLine(string line, string checkname, MCVersion version)
        {
            try
            {
                int index = version switch
                {
                    MCVersion.v1122 => line.IndexOf('='),
                    _ => line.IndexOf(':')
                };
                if (index == -1) return line;

                var key = line[..(index + 1)];
                var value = line[(index + 1)..];
                if (value.Length > 28)
                {
                    var nameIndex = value.IndexOf(checkname, StringComparison.Ordinal);
                    var from = Math.Max(0, nameIndex - 12);
                    var to = Math.Min(value.Length, nameIndex + checkname.Length + 12);
                    var sb = new StringBuilder();
                    if (from == 0 && to == value.Length) return line;
                    
                    if (from != 0) sb.Append("...");
                    sb.Append(value[from..to]);
                    if (from != value.Length) sb.Append("...");
                    value = sb.ToString();
                }

                return key + value;
            }
            catch (ArgumentOutOfRangeException e)
            {
                Log.Error(e, "shorten line");
                return line;
            }

        }

        Dictionary<string, SuperUniversalExtremeAwesomeGodlikeSmartLock> locks = new();
        async ValueTask<SuperUniversalExtremeAwesomeGodlikeSmartLock> AcquireLock(string lockName)
        {
            logger.Debug($"正在获取锁 {lockName}...");
            SuperUniversalExtremeAwesomeGodlikeSmartLock l;
            lock (locks)
            {
                if (!locks.ContainsKey(lockName)) locks[lockName] = new SuperUniversalExtremeAwesomeGodlikeSmartLock();
                l = locks[lockName];
            }
            await l.WaitAsync();
            return l;
        }

        public bool IsAnyLockAcquired()
        {
            lock (this)
            {
                return locks.Any(l => l.Value.CurrentCount == 0);
            }
        }
        public bool IsMoreThanTwoWaiting(string lockName)
        {
            lock (this)
            {
                if (!locks.ContainsKey(lockName)) return false;
                return locks[lockName].WaitCount > 2;
            }
        }
    }

    public sealed class SuperUniversalExtremeAwesomeGodlikeSmartLock : IDisposable
    {
        SemaphoreSlim semaphore = new(1);
        public volatile int WaitCount = 0;

        public int CurrentCount
            => semaphore.CurrentCount;
        
        public Task WaitAsync()
        {
            Interlocked.Increment(ref WaitCount);
            return semaphore.WaitAsync();
        }

        public void Dispose()
        {
            Interlocked.Decrement(ref WaitCount);
            semaphore.Release();
        }
    }
}
