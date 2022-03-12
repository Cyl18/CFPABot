using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using DiffPatch.Data;
using ForgedCurse.Json;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;

namespace CFPABot.Utils
{
    public class CommentContext
    {
        public int ID { get; set; }
        public string ModLinkSegment { get; set; } = "";
        public string BuildArtifactsSegment { get; set; } = "";
        public string CheckSegment { get; set; } = "";
        public string UpdateSegment { get; set; } = "";
    }
    public sealed class CommentBuilder
    {
        public CommentBuilder(int pullRequestID)
        {
            PullRequestID = pullRequestID;
            Context = !File.Exists(ContextFilePath) ? new CommentContext() {ID = pullRequestID} : JsonSerializer.Deserialize<CommentContext>(File.ReadAllText(ContextFilePath));
        }

        public int PullRequestID { get; }
        string ContextFilePath => $"config/pr_context/{PullRequestID}.json";
        public CommentContext Context { get; private set; }
        void SaveContext() => File.WriteAllText(ContextFilePath, JsonSerializer.Serialize(Context));
        volatile int UpdatingCount = 0;
        public async Task Update(Func<Task> updateCallback)
        {
            // using var l = AcquireLock(nameof(Update));
            var fileDiff = await GitHub.Diff(PullRequestID);
            if (Context.BuildArtifactsSegment.IsNullOrEmpty() && fileDiff.All(d => !d.To.StartsWith("projects/"))) return;
            
            var comments = await GitHub.GetPRComments(PullRequestID);
            IssueComment comment;
            using (await AcquireLock("UpdateLock"))
            {
                comment = comments.FirstOrDefault(c => c.User.Login == "Cyl18-Bot" && c.Body.StartsWith("<!--CYBOT-->")) ?? await CreateComment();
            }

            var sb2 = new StringBuilder();
            sb2.AppendLine(Context.ModLinkSegment);
            sb2.AppendLine("---");
            sb2.AppendLine(Context.BuildArtifactsSegment);
            if (!Context.CheckSegment.IsNullOrEmpty())
            {
                sb2.AppendLine("---");
                sb2.AppendLine(Context.CheckSegment);
            }

            Interlocked.Increment(ref UpdatingCount);
            if (UpdatingCount > 0)
            {
                sb2.AppendLine("---");
                sb2.AppendLine("**⚠ 正在更新内容..**");
            }
            using (await AcquireLock("UpdateLock"))
            {
                await GitHub.Instance.Issue.Comment.Update(Constants.Owner, Constants.RepoName, comment.Id, "<!--CYBOT-->\n" + sb2.ToString());
            }

            try
            {
                await updateCallback();
                await UpdateCheckSegment(fileDiff);
            }
            catch (Exception e)
            {
                Console.WriteLine(e);
            }

            Interlocked.Decrement(ref UpdatingCount);
            var sb = new StringBuilder();
            sb.AppendLine(Context.ModLinkSegment);
            sb.AppendLine("---");
            sb.AppendLine(Context.BuildArtifactsSegment);
            if (!Context.CheckSegment.IsNullOrEmpty())
            {
                sb.AppendLine("---");
                sb.AppendLine(Context.CheckSegment);
            }

            if (UpdatingCount > 0)
            {
                sb.AppendLine("---");
                sb.AppendLine("**⚠ 正在更新内容..**");
            }
            using (await AcquireLock("UpdateLock"))
            {
                await GitHub.Instance.Issue.Comment.Update(Constants.Owner, Constants.RepoName, comment.Id, "<!--CYBOT-->\n" + sb.ToString());
            }
            SaveContext();
        }
        

        Task<IssueComment> CreateComment()
        {
            return GitHub.Instance.Issue.Comment.Create(Constants.Owner, Constants.RepoName, PullRequestID, "<!--CYBOT-->\n" + "正在更新数据...");
        }

        public async Task UpdateModLinkSegment(FileDiff[] diffs)
        {
            using var l = await AcquireLock(nameof(UpdateModLinkSegment));
            var sb = new StringBuilder();
            try
            {
                var modInfos = PRAnalyzer.Run(diffs);
                var modids = modInfos.Select(m => m.CurseForgeID).Distinct();
                var addons = new List<Addon>();
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

                if (addons.Count > 20)
                {
                    sb.AppendLine("模组数量过多, 将不显示模组链接.");
                    return;
                }

                sb.AppendLine("| | 模组名 | 🆔 ModID | :hammer: CurseForge | :art: 最新模组文件 | :mag: 源代码 |");
                sb.AppendLine("| --- | --- | --- | :-: | --- | :-: |");

                //sb.AppendLine("| 模组名 | CurseForge | 最新模组文件 | 源代码 |");
                //sb.AppendLine("|  --- | --- | --- | --- |");
                foreach (var addon in addons)
                {
                    try
                    {
                        var versions = modInfos.Where(i => i.CurseForgeID == addon.Slug).Select(i => i.Version).ToArray();
                        sb.AppendLine($"| " +
                                      $"{await CurseManager.GetThumbnailText(addon)} |" +
                                      $" **{addon.Name}** |" +
                                      $" {await CurseManager.GetModID(addon, versions.FirstOrDefault())} |" +
                                      $" [链接]({addon.Website}) |" +
                                      $" {CurseManager.GetDownloadsText(addon, versions)} |" +
                                      $" {await CurseManager.GetRepoText(addon)} |");
                    }
                    catch (Exception e)
                    {
                        sb.AppendLine($"| | [链接]({addon.Website}) | {e.Message} | |");
                        Log.Error(e, "UpdateModLinkSegment");
                    }
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "更新 mod 列表出错");
                sb.AppendLine($"⚠ 更新 mod 列表出错: {e.Message}");
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
                var checkRun = await GitHub.FindWorkflowFromHeadSha(pr.Head.Sha);
                if (checkRun == null)
                {
                    sb.AppendLine($"⚠ 暂时没有检测到 workflow.");
                    return;
                }

                switch (checkRun.Status.Value)
                {
                    case CheckStatus.Queued:
                        sb.AppendLine($"⚠ 正在等待打包器执行.");
                        break;
                    case CheckStatus.InProgress:
                        sb.AppendLine($":milky_way: 打包器正在执行, 请耐心等待.");
                        break;
                    case CheckStatus.Completed:
                        sb.AppendLine($":floppy_disk: 基于此 PR 所打包的完整汉化资源包 ({checkRun.HeadSha}/{DateTimeOffset.UtcNow.AddHours(8):s} UTC+8):");
                        // 修不好了
                        /*
                        try
                        {
                            var artifactsFromWorkflowRunID = await GitHub.GetArtifactsFromWorkflowRunID(checkRun.Id.ToString());
                            if (artifactsFromWorkflowRunID.TotalCount == 0) sb.Append("没有。");

                            foreach (var ar in artifactsFromWorkflowRunID.Artifacts)
                            {
                                sb.Append($"{ar.Name.Split("-").Last()} ");
                            }
                        }
                        catch (Exception e)
                        {

                        }
                        */
                        sb.AppendLine($"    在 [链接]({Constants.BaseRepo}/pull/{PullRequestID}/checks) 处点击 Artifacts 下载。");
                        break;
                }


            }
            catch (Exception e)
            {
                Log.Error(e, "更新编译 artifacts 出错");
                sb.AppendLine($"⚠ 更新编译 artifacts 出错: {e.Message}");
            }
            finally
            {
                Context.BuildArtifactsSegment = sb.ToString();
            }
        }

        public async Task UpdateCheckSegment(FileDiff[] diffs)
        {
            if (IsMoreThanTwoWaiting(nameof(UpdateCheckSegment))) return;
            using var l = await AcquireLock(nameof(UpdateCheckSegment));
            var sb = new StringBuilder();
            var reportSb = new StringBuilder();
            try
            {
                var pr = await GitHub.GetPullRequest(PullRequestID);

                var fileName = $"{pr.Number}-{pr.Head.Sha.Substring(0, 7)}";
                var filePath = "wwwroot/" + fileName;
                var webPath = $"https://cfpa.cyan.cafe/static/{fileName}";
                if (File.Exists(filePath)) return;

                // 检查大小写
                var reportedCap = false;
                var reportedID = false;
                foreach (var diff in diffs)
                {
                    var names = diff.To.Split('/');
                    if (names.Length < 7) continue; // 超级硬编码
                    if (names[0] != "projects") continue;

                    if (names.Any(s => s.ToLower() != s))
                    {
                        reportSb.AppendLine($"检测到大写字母：{diff.To}");
                        if (!reportedCap)
                        {
                            sb.AppendLine($"⚠ 警告：文件路径中含有大写字母。如 `{diff.To}`。");
                            reportedCap = true;
                        }
                    }
                }
                // 检查中英文 key


                if (reportedCap)
                {
                    File.WriteAllText(filePath, reportSb.ToString());
                    sb.AppendLine($"更多报告可以在 [这里]({webPath}) 查看.");
                }

                // 检查 ModID
            }
            catch (Exception e)
            {
                Log.Error(e, "检查出错");
                sb.AppendLine($"⚠ 检查出错: {e.Message}");
            }
            finally
            {
                Context.CheckSegment = sb.ToString();
            }
        }

        Dictionary<string, CommentBuilderLock> locks = new();
        async Task<CommentBuilderLock> AcquireLock(string lockName)
        {
            CommentBuilderLock l;
            lock (this)
            {
                if (!locks.ContainsKey(lockName)) locks[lockName] = new CommentBuilderLock();
                l = locks[lockName];
            }
            await l.WaitAsync();
            return l;
        }

        public bool IsLockAcquired(string lockName)
        {
            lock (this)
            {
                if (!locks.ContainsKey(lockName)) return false;
                return locks[lockName].CurrentCount == 0;
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

    public class CommentBuilderLock : IDisposable
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
