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
        public static GitHubClient Instance { get; set; }

        public static void Init()
        {
            Instance = new GitHubClient(new ProductHeaderValue("Cyl18-Bot"));
            Instance.Credentials = new Credentials(Constants.GitHubOAuthToken);
        }

        public static Task<PullRequest> PRInfo(int id) 
            => Instance.PullRequest.Get(Constants.Owner, Constants.RepoName, id);

        public static async Task<FileDiff[]> Diff(int id)
            => DiffParserHelper.Parse(await Download.String(Constants.BaseRepo + $"/pull/{id}.diff")).ToArray();

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
                checkRuns.Select(c => c.Id).Print();
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
