using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary.Extensions;

namespace CFPABot.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class WebhookListenerController : ControllerBase
    {
        public async Task<IActionResult> Get([FromQuery] string password, [FromQuery] string pr)
        {
            if (password != Constants.GitHubWebhookSecret) return Unauthorized();

            var prid = pr.ToInt();
            var builder = GetOrCreateCommentBuilder(prid);
            builder.Update(async () =>
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

            var body = await Request.Body.ReadToEndAsync();

            if (!IsGithubPushAllowed(body, eventName, signature))
                return Unauthorized();

            var data = JsonDocument.Parse(body).RootElement;
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

        async void IssueComment(JsonElement jsonElement)
        {
            if (jsonElement.GetProperty("issue").GetProperty("html_url").GetString().Contains("pull"))
            {
                var prid = jsonElement.GetProperty("issue").GetProperty("number").GetInt32();
                var comments = await GitHub.GetPRComments(prid);
                if (comments.Any(c => c.User.Login == "Cyl18-Bot" && c.Body.StartsWith("<!--CYBOT-->") && c.Body.Contains("- [x] 🔃")))
                {
                    var pr = await GitHub.GetPullRequest(prid);
                    var fileName = $"{pr.Number}-{pr.Head.Sha.Substring(0, 7)}.txt";
                    var filePath = "wwwroot/" + fileName;
                    if (System.IO.File.Exists(filePath)) System.IO.File.Delete(filePath);
                    
                    var builder = GetOrCreateCommentBuilder(prid);
                    builder.Update(async () =>
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
            if (!commentBuilders.ContainsKey(id)) commentBuilders[id] = new CommentBuilder(id);
            return commentBuilders[id];
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
                    builder.Update(async () =>
                    {
                        await builder.UpdateModLinkSegment(await GitHub.Diff(prid));
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
                var s = data.GetProperty("workflow_run").GetProperty("head_sha").GetString();
                if (data.GetProperty("workflow_run").GetProperty("event").GetString() != "pull_request") return;
                
                Task.Run(async () =>
                {
                    try
                    {
                        var pr = await GitHub.GetPRFromHeadSha(s);
                        var builder = GetOrCreateCommentBuilder(pr.Number);
                        builder.Update(async () =>
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
    }
}

