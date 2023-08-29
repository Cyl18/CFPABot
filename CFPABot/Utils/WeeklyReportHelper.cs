using System;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Octokit;

namespace CFPABot.Utils
{
    public class WeeklyReportHelper
    {
        Regex PRTitleRegex = new Regex("\\(#(\\d{4,5})\\)", RegexOptions.Compiled);
        public static async Task<string> GenerateDefault(DateOnly date)
        {
            var dateTime = date.ToDateTime(new TimeOnly(12, 0));
            var commits = await GitHub.Instance.Repository.Commit.GetAll(Constants.RepoID, new CommitRequest(){Since = new DateTimeOffset(dateTime.AddDays(-7), TimeSpan.FromHours(8))});

            throw new NotImplementedException();
        }
    }
}
