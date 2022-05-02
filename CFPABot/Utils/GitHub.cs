using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Models;
using DiffPatch;
using DiffPatch.Data;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;

namespace CFPABot.Utils
{
    public class GitHub
    {
        public static GitHubClient Instance => GetClient();

        public static GitHubClient GetClient()
        {
            // NOTE - the token will expire in 1 hour!

            // Create a new GitHubClient using the installation token as authentication
            var installationClient = new GitHubClient(new ProductHeaderValue("cfpa-bot"))
            {
                Credentials = new Credentials(GetToken())
            };
           
            return installationClient;
        }

        public static string GetToken()
        {
            var generator = new GitHubJwt.GitHubJwtFactory(
                new GitHubJwt.FilePrivateKeySource("/app/config/cfpa-bot.pem"),
                new GitHubJwt.GitHubJwtFactoryOptions
                {
                    AppIntegrationId = 181747, // The GitHub App Id
                    ExpirationSeconds = 300 // 10 minutes is the maximum time allowed
                }
            );

            var jwtToken = generator.CreateEncodedJwtToken();
            var i = new GitHubClient(new ProductHeaderValue("cfpa-bot"));
            i.Credentials = new Credentials(jwtToken, AuthenticationType.Bearer);
            var response = i.GitHubApps.CreateInstallationToken(24218080).Result;

            return response.Token;
        }

        public static Task<PullRequest> PRInfo(int id) 
            => Instance.PullRequest.Get(Constants.Owner, Constants.RepoName, id);

        public static async Task<FileDiff[]> Diff(int id)
            => DiffParserHelper.Parse((await Download.String(Constants.BaseRepo + $"/pull/{id}.diff"))
                // workaround https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/1924
                .Split("\n").Where(line => !line.StartsWith("rename ") && !line.StartsWith("similarity index ")).Connect("\n")
                ).ToArray();

        public static Task<IReadOnlyList<IssueComment>> GetPRComments(int id)
            => Instance.Issue.Comment.GetAllForIssue(Constants.Owner, Constants.RepoName, id);
        
        public static async Task<PullRequest> GetPRFromHeadSha(string headSha)
        {
            try
            {
                var list = await Instance.PullRequest.GetAllForRepository(Constants.Owner, Constants.RepoName, new PullRequestRequest() { Head = headSha });
                return list.First();
            }
            catch (Exception e)
            {
                Log.Error(e, "GetPRFromHeadSha failed.");
                throw new CheckException($"从仓库的头安全散列演算法256获取拉取请求失败. {e.Message}");
            }
        }

        public static async Task<CheckRun> FindWorkflowFromHeadSha(string headSha)
        {
            try
            {
                var checkRuns = (await Instance.Check.Run.GetAllForReference(Constants.Owner, Constants.RepoName, headSha)).CheckRuns
                    .OrderByDescending(r => r.StartedAt);
                return checkRuns.FirstOrDefault();
            }
            catch (Exception e)
            {
                Log.Error(e, "FindWorkflowFromHeadSha failed.");
                throw new CheckException($"从仓库的头安全散列演算法256获取工作流失败. {e.Message}");
            }
        }

        public static Task<PullRequest> GetPullRequest(int id)
            => Instance.PullRequest.Get(Constants.Owner, Constants.RepoName, id);

        public static async Task<ArtifactsModel> GetArtifactsFromWorkflowRunID(string workflowRunID)
        {
            return (await Download.String(
                $"https://api.github.com/repos/{Constants.Owner}/{Constants.RepoName}/actions/runs/{workflowRunID}/artifacts")).JsonDeserialize<ArtifactsModel>();
        }
    }
}
