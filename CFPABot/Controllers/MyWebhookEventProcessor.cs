using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using CFPABot.Checks;
using CFPABot.Command;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Microsoft.Extensions.Primitives;
using Octokit.Webhooks;
using Octokit.Webhooks.Events;
using Octokit.Webhooks.Events.Installation;
using Octokit.Webhooks.Events.IssueComment;
using Octokit.Webhooks.Events.Label;
using Octokit.Webhooks.Events.PullRequest;
using Octokit.Webhooks.Events.WorkflowRun;
using Octokit.Webhooks.Models;
using Serilog;
using IssueComment = Octokit.IssueComment;

namespace CFPABot.Controllers
{
    public class MyWebhookEventProcessor : WebhookEventProcessor
    {
        public override Task ProcessWebhookAsync(IDictionary<string, StringValues> headers, string body)
        {
            if (headers["X-GitHub-Event"] == "workflow_job")
            {
                return Task.CompletedTask;
            }

            return base.ProcessWebhookAsync(headers, body);
        }

        public override Task ProcessWebhookAsync(WebhookHeaders headers, WebhookEvent webhookEvent)
        {
            // workaround
            // 本来更新到 1.0 就可以解决的
            // 但是 1.0 得 .NET 6
            // .NET 6 得 vs2022
            // vs2022 + R# 特别卡
            

            if (!(headers.Event == "installation" && webhookEvent.Action == "created") && webhookEvent.Repository.Id != Constants.RepoID ||
                Program.ShuttingDown)
            {
                throw new WebhookException("error");
            }
            return base.ProcessWebhookAsync(headers, webhookEvent);
        }

        protected override async Task ProcessPullRequestWebhookAsync(WebhookHeaders headers, PullRequestEvent pullRequestEvent,
            PullRequestAction action)
        {
            var prid = (int)pullRequestEvent.Number;
            if (action == PullRequestAction.Opened || action == PullRequestAction.Synchronize)
            {
                try
                {
                    Log.Debug($"接收到 PR 事件 #{prid} {action}");
                    var builder = GetOrCreateCommentBuilder(prid);
                    _ = builder.Update(async () =>
                    {
                        await builder.UpdateModLinkSegment(await GitHub.Diff(prid));
                        if (action == PullRequestAction.Synchronize)
                        {
                            await builder.UpdateBuildArtifactsSegment();
                        }
                    });
                }
                catch (Exception e)
                {
                    Console.WriteLine(e);
                }
            }

            if (action == PullRequestAction.Opened || action == PullRequestAction.Synchronize || action == PullRequestAction.Edited || action == PullRequestAction.Labeled || action == PullRequestAction.Unlabeled)
            {
                _ = new LabelCheck(prid).Run();
            }
        }

        protected override async Task ProcessInstallationWebhookAsync(WebhookHeaders headers, InstallationEvent installationEvent,
            InstallationAction action)
        {
            await System.IO.File.WriteAllTextAsync($"config/installations/{Guid.NewGuid():N}.json", $"{headers.ToJsonString()}\n\n{installationEvent.ToJsonString()}");
        }

        async ValueTask<bool> CheckCommentCount(IssueComment[] comments)
        {
            if (comments.Length > 1)
            {
                foreach (var comment in comments)
                {
                    await GitHub.Instance.Issue.Comment.Update(Constants.Owner, Constants.RepoName, (int)comment.Id,
                        "<!--CYBOT-->❌ CRITICAL_FAILURE：找到了多个 Bot Comment。 请删除到只保留一个。删除后请点击强制刷新.\n\n---\n\n- [ ] 🔄 勾选这个复选框来强制刷新");
                }
                return true;
            }

            return false;
        }

        protected override async Task ProcessIssueCommentWebhookAsync(WebhookHeaders headers, IssueCommentEvent issueCommentEvent,
            IssueCommentAction action)
        {
            if (issueCommentEvent.Issue.HtmlUrl.Contains("pull"))
            {
                var prid = (int)issueCommentEvent.Issue.Number;
                Log.Debug($"接收到 IssueComment 事件：{issueCommentEvent.Sender?.Login} {issueCommentEvent.Action} #{prid}/{issueCommentEvent.Comment.Id}");


                if (action == IssueCommentAction.Created)
                {
                    var commandComment = issueCommentEvent.Comment;
                    _ = Task.Run(async () =>
                    {
                        await CommandProcessor.Run(prid, commandComment.Body,
                                (int)commandComment.Id,
                            new GitHubUser(
                                commandComment.User.Login,
                                commandComment.User.Id
                            ));
                    });
                }

                var comments = await GitHub.GetPRComments(prid);
                var botComments = comments.Where(c => (c.User.Login == "Cyl18-Bot" || c.User.Login.Equals("cfpa-bot[bot]", StringComparison.OrdinalIgnoreCase)) && c.Body.StartsWith("<!--CYBOT-->")).ToArray();
                if (await CheckCommentCount(botComments))
                {
                    return;
                }

                var refreshComments = botComments.Where(c => (c.Body.Contains("- [x] 🔃") || c.Body.Contains("- [x] 🔄")));

                if (refreshComments.Any())
                {
                    Log.Debug($"接收到强制更新事件 #{prid}");
                    var pr = await GitHub.GetPullRequest(prid);
                    var fileName = $"{pr.Number}-{pr.Head.Sha.Substring(0, 7)}.txt";
                    var filePath = "wwwroot/" + fileName;
                    if (System.IO.File.Exists(filePath)) System.IO.File.Delete(filePath);

                    var builder = GetOrCreateCommentBuilder(prid);
                    _ = builder.Update(async () =>
                    {
                        await builder.UpdateBuildArtifactsSegment();
                        await builder.UpdateModLinkSegment(await GitHub.Diff(prid));
                    });
                }
            }
        }

        protected override async Task ProcessWorkflowRunWebhookAsync(WebhookHeaders headers, WorkflowRunEvent workflowRunEvent,
            WorkflowRunAction action)
        {
            var name = workflowRunEvent.Workflow.Name;
            var fromEvent = workflowRunEvent.WorkflowRun.Event;
            if (name != "PR Packer" || fromEvent != "pull_request") return;

            var user = workflowRunEvent.WorkflowRun.HeadRepository.Owner.Login;
            var branch = workflowRunEvent.WorkflowRun.HeadBranch;
            
            _ = Task.Run(async () =>
            {
                try
                {
                    var pr = await GitHub.GetPRFromHeadRef($"{user}:{branch}");
                    var builder = GetOrCreateCommentBuilder(pr.Number);
                    _ = builder.Update(async () =>
                    {
                        await builder.UpdateBuildArtifactsSegment();
                    });
                }
                catch (Exception e)
                {
                    Console.WriteLine(e);
                }
            });
            
        }



        internal static Dictionary<int, CommentBuilder> commentBuilders = new();

        internal static CommentBuilder GetOrCreateCommentBuilder(int id)
        {
            // 每次都要写一遍这种东西（（
            lock (typeof(WebhookListenerController))
            {
                if (!commentBuilders.ContainsKey(id)) commentBuilders[id] = new CommentBuilder(id);
                return commentBuilders[id];
            }
        }
    }
}
