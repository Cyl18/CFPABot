using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using CFPABot.Command;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Octokit;

namespace CFPABot.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class WebhookListenerController : ControllerBase
    {
        public IActionResult Get([FromQuery] string password, [FromQuery] string pr)
        {
            if (password != Constants.GitHubWebhookSecret) return Unauthorized();

            var prid = pr.ToInt();
            var builder = GetOrCreateCommentBuilder(prid);
            _ = builder.Update(async () =>
            {
                await builder.UpdateBuildArtifactsSegment();
                await builder.UpdateModLinkSegment(await GitHub.Diff(prid));
            });

            return Ok();
        }

        [HttpPost]
        public async Task<IActionResult> Post()
        {
            var eventName = Request.Headers["X-GitHub-Event"];
            var signature = Request.Headers["X-Hub-Signature-256"];

            var body = await Request.Body.ReadToEndAsync1();

            if (!IsGithubPushAllowed(body, eventName, signature))
                return Unauthorized();

            var data = JsonDocument.Parse(body).RootElement;
            if (eventName == "installation" && data.GetProperty("action").GetString() == "created")
            {
                await System.IO.File.WriteAllTextAsync($"config/installations/{Guid.NewGuid():N}.json", body);
                return Ok();
            }
            if (data.GetProperty("repository").GetProperty("id").GetInt32() != 88008282) return Unauthorized();
            switch (eventName)
            {
                case "workflow_run":
                    WorkflowRun(data);
                    break;
                case "pull_request":
                    PR(data);
                    break;
                case "issue_comment":
                    IssueComment(data);
                    break;
            }

            return Ok();
        }

        async ValueTask<bool> CheckCommentCount(IssueComment[] comments)
        {
            if (comments.Length > 1)
            {
                foreach (var comment in comments)
                {
                    await GitHub.Instance.Issue.Comment.Update(Constants.Owner, Constants.RepoName, comment.Id,
                        "<!--CYBOT-->❌ CRITICAL_FAILURE：找到了多个 Bot Comment。 请删除到只保留一个。删除后请点击强制刷新.\n\n---\n\n- [ ] 🔄 勾选这个复选框来强制刷新");
                }
                return true;
            }

            return false;
        }

        async void IssueComment(JsonElement jsonElement)
        {

            if (jsonElement.GetProperty("issue").GetProperty("html_url").GetString().Contains("pull"))
            {
                var prid = jsonElement.GetProperty("issue").GetProperty("number").GetInt32();

                if (jsonElement.GetProperty("action").GetString() == "created")
                {
                    var commandComment = jsonElement.GetProperty("comment");
                    _ = Task.Run(async () =>
                    {
                        await CommandProcessor.Run(prid, commandComment.GetProperty("body").GetString(),
                                commandComment.GetProperty("id").GetInt32(),
                            new GitHubUser(
                                commandComment.GetProperty("user").GetProperty("login").GetString(),
                                commandComment.GetProperty("user").GetProperty("id").GetInt64()
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

        internal static Dictionary<int, CommentBuilder> commentBuilders = new();

        static CommentBuilder GetOrCreateCommentBuilder(int id)
        {
            // 每次都要写一遍这种东西（（
            lock (typeof(WebhookListenerController))
            {
                if (!commentBuilders.ContainsKey(id)) commentBuilders[id] = new CommentBuilder(id);
                return commentBuilders[id];
            }
        }

        void PR(JsonElement data)
        {
            var action = data.GetProperty("action").GetString();
            if (action is "opened" or "synchronize")
            {
                try
                {
                    var prid = data.GetProperty("number").GetInt32();
                    var builder = GetOrCreateCommentBuilder(prid);
                    _ = builder.Update(async () =>
                      {
                          await builder.UpdateModLinkSegment(await GitHub.Diff(prid));
                          if (action is "synchronize")
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
        }

        void WorkflowRun(JsonElement data)
        {
            var action = data.GetProperty("workflow").GetProperty("name").GetString();
            if (action is "PR Packer")
            {
                var run = data.GetProperty("workflow_run");

                var user = run.GetProperty("head_repository").GetProperty("owner").GetProperty("login").GetString();
                var branch = run.GetProperty("head_branch").GetString();
                if (run.GetProperty("event").GetString() != "pull_request") return;
                
                Task.Run(async () =>
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

        }


        private const string Sha1Prefix = "sha256=";
        private bool IsGithubPushAllowed(string payload, string eventName, string signatureWithPrefix)
        {
            if (signatureWithPrefix.StartsWith(Sha1Prefix, StringComparison.OrdinalIgnoreCase))
            {
                var signature = signatureWithPrefix.Substring(Sha1Prefix.Length);
                var secret = Encoding.ASCII.GetBytes(Constants.GitHubWebhookSecret);
                var payloadBytes = Encoding.UTF8.GetBytes(payload);

                using (var hmSha1 = new HMACSHA256(secret))
                {
                    var hash = hmSha1.ComputeHash(payloadBytes);

                    var hashString = ToHexString(hash);

                    if (hashString.Equals(signature))
                    {
                        return true;
                    }
                }
            }

            return false;
        }


        public static string ToHexString(byte[] bytes)
        {
            var builder = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes)
            {
                builder.AppendFormat("{0:x2}", b);
            }

            return builder.ToString();
        }

        [Route("/robots.txt")]
        public ContentResult RobotsTxt()
        {
            var sb = new StringBuilder();
            sb.AppendLine("User-agent: *")
                .AppendLine("Disallow:");

            return this.Content(sb.ToString(), "text/plain", Encoding.UTF8);
        }
    }
}

