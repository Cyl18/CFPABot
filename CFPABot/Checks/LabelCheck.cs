using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Octokit;

namespace CFPABot.Checks
{
    public class LabelCheck
    {
        private int prid;

        public LabelCheck(int prid)
        {
            this.prid = prid;
        }

        public async Task Run()
        {
            var labels = await GitHub.Instance.Issue.Labels.GetAllForIssue(Constants.Owner, Constants.RepoName, prid);
            var deniedLabels = new string[] {"NO-MERGE", "needs author action", "changes required", "ready to reject", "即将被搁置" };
            var result = labels.Any(label => deniedLabels.Contains(label.Name));
            var pr = await GitHub.GetPullRequest(this.prid);

            await GitHub.Instance.Check.Run.Create(Constants.Owner, Constants.RepoName,
                new NewCheckRun("标签检查器", pr.Head.Sha)
                {
                    Conclusion = new StringEnum<CheckConclusion>(result ? CheckConclusion.Failure : CheckConclusion.Success),
                    Status = new StringEnum<CheckStatus>(CheckStatus.Completed),
                    Output = new NewCheckRunOutput(result ? $"检测到不能被 Merge 的标签：{labels.Where(label => deniedLabels.Contains(label.Name)).Select(label => label.Name).Connect()}。" : "标签检查通过。", ""),
                    CompletedAt = DateTimeOffset.Now
                });

        }
    }
}
