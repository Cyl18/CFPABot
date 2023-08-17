using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using CFPABot.Utils;

namespace CFPABot.IDK
{
    public partial class TranslationRequestUpdater
    {
        [GeneratedRegex("\\|(.*?)\\|(.*?)\\|(.*?)\\|(.*?)\\|(.*?)\\|")]
        private static partial Regex r();

        public static async Task Run()
        {
            var original = await GitHub.Instance.Issue.Get(Constants.RepoID, 2702);
            
        }

        private static string Normalize(string s)
        {
            if (s == null) return s;

            var l = s.ToLowerInvariant().ToCharArray().ToList();
            l.RemoveAll(x => x == ' ' || !char.IsLetterOrDigit(x));
            return new string(l.ToArray());
        }
    }
}
