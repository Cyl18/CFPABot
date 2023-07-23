using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using CFPABot.Azusa.Pages;
using CFPABot.Utils;
using Octokit;

namespace CFPABot.Azusa
{
    public class PRCreatorModule
    {
        GitHubClient _gitHubClient;
        readonly PRCreator.FileCache _enCache;
        readonly PRCreator.FileCache _cnCache;
        readonly string _email;
        readonly string _slug;
        readonly string _versionString;
        readonly string _prTitle;
        readonly Action<string> _updateAction;
        bool forkCreated = false;
        string _token;
        string _domain;

        public PRCreatorModule(GitHubClient gitHubClient, PRCreator.FileCache enCache, PRCreator.FileCache cnCache, string email, string slug, string versionString, string prTitle, Action<string> updateAction, string githubOauthToken, string modDomain)
        {
            _gitHubClient = gitHubClient;
            _enCache = enCache;
            _cnCache = cnCache;
            _email = email;
            _slug = slug;
            _versionString = versionString;
            _prTitle = prTitle;
            _updateAction = updateAction;
            _token = githubOauthToken;
            _domain = modDomain;
        }

        public Repository repo { get; private set; }
        public User user { get; private set; }
        public string branchName { get; private set; }

        public async Task Run()
        {
            user = await _gitHubClient.User.Current();

            try
            {
                _updateAction("尝试直接获取 fork 库..");
                repo = await _gitHubClient.Repository.Get(user.Login, "Minecraft-Mod-Language-Package");
                goto start;
            }
            catch (NotFoundException e)
            {
                _updateAction("获取失败，正在查找所有 fork 库..可能较慢..");
            }

            var forks = await _gitHubClient.Repository.Forks.GetAll(Constants.RepoID);
            if (forks.FirstOrDefault(x => x.Owner.Login == user.Login) is {} fork)
            {
                repo = fork;
            }
            else
            {
                _updateAction("当前你没有 Fork, 正在创建一个新的 Fork");
                repo = await _gitHubClient.Repository.Forks.Create(Constants.RepoID, new NewRepositoryFork());
                _updateAction("已经提交创建 Fork 请求，等待可用...");
                await Task.Delay(8000);
            }
            start:

            var localRepo = new ForkRepoManager(_token);
            _updateAction("Cloning Repo...");

            localRepo.Clone(user.Login, repo.Name, user.Login, _email);
            localRepo.Run("remote add upstream https://github.com/CFPAOrg/Minecraft-Mod-Language-Package.git");
            branchName = "CFPA-Helper-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            _updateAction("Fetching upstream...");

            localRepo.Run("fetch upstream main");
            _updateAction("Creating branch...");
            localRepo.Run($"switch -c {branchName} upstream/main");
            var baseLocation = $"{localRepo.WorkingDirectory}/projects/{_versionString}/assets/{_slug}/{_domain}/lang";
            _updateAction("Placing files...");
            Directory.CreateDirectory(baseLocation);
            File.WriteAllText(baseLocation+$"/{_enCache.FileName}", File.ReadAllText(_enCache.FilePath), new UTF8Encoding(false));
            File.WriteAllText(baseLocation+$"/{_cnCache.FileName}", File.ReadAllText(_cnCache.FilePath), new UTF8Encoding(false));
            localRepo.Run($"add -A");
            localRepo.Commit(_prTitle + "\n\n提交自 CFPA-Helper");
            _updateAction("Pushing to origin...");
            localRepo.Run($"push origin {branchName}");

        }

        public async Task<PullRequest> CreatePR()
        {
            return await _gitHubClient.PullRequest.Create(Constants.RepoID,
                new NewPullRequest(_prTitle, $"{user.Login}:{branchName}", "main") { Body = "由 CFPA-Helper 提交." });
        }

    }
}
