using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Octokit;

namespace CFPABot.Checks
{
    public class Labeler
    {
        private int prid;
        public Labeler(int prid)
        {
            this.prid = prid;
        }
        
        public async Task Run()
        {
            var labelManager = GitHub.Instance.Issue.Labels;
            var currentLabels = (await labelManager.GetAllForIssue(Constants.RepoID, prid)).Select(x => x.Name).ToHashSet();
            var resultLabels = currentLabels.ToHashSet();

            List<(string name, int min, int max)> lineLabels = new()
            {
                ("1+", 0, 10),
                ("10+", 10, 40),
                ("40+", 40, 100),
                ("100+", 100, 500),
                ("500+", 500, 1000),
                ("1000+", 1000, 2000),
                ("2000+", 2000, 5000),
                ("5000+", 5000, int.MaxValue),
            };

            List<(string name, string pathPrefix)> pathLabels = new()
            {
                ("config", "config"),
                ("source", "src"),
            };

            resultLabels.RemoveWhere(x => lineLabels.Any(l => l.name == x) || pathLabels.Any(l => l.name == x));

            var pr = await GitHub.Instance.PullRequest.Files(Constants.RepoID, prid);
            var lines = pr.Sum(x => x.Changes);
            string lineTag = null;
            foreach (var (name, min, max) in lineLabels)
            {
                if (min <= lines && lines < max)
                {
                    lineTag = name;
                    break;
                }
            }
            if (lineTag == null) throw new ArgumentOutOfRangeException();
            resultLabels.Add(lineTag);

            foreach (var (name, pathPrefix) in pathLabels)
            {
                if (pr.Any(x => x.FileName.StartsWith(pathPrefix)))
                {
                    resultLabels.Add(name);
                }
            }

            currentLabels.SymmetricExceptWith(resultLabels);
            if (currentLabels.Count != 0)
            {
                await labelManager.ReplaceAllForIssue(Constants.RepoID, prid, resultLabels.ToArray());
            }
        }
    }
}
