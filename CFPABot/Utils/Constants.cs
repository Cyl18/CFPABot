//#define Test
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;


namespace CFPABot.Utils
{
    public static class Constants
    {
#if Test

        public const string BaseRepo = "https://github.com/Cyl18/Test";
        public const string Owner = "Cyl18";
        public const string RepoName = "Test";

        public static string GitHubOAuthToken => Environment.GetEnvironmentVariable("GITHUB_OAUTH_TOKEN");
        public static string GitHubWebhookSecret => Environment.GetEnvironmentVariable("GITHUB_WEBHOOK_SECRET");
#else
        public const string BaseRepo = "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package";
        public const string Owner = "CFPAOrg";
        public const string RepoName = "Minecraft-Mod-Language-Package";
        public const int RepoID = 88008282;

        public const string PRPackerFileName = "pr-packer.yml";

        public const string GitHubOAuthClientId = "20f9e79dfa770f38e95d";
        public static string GitHubOAuthToken => Environment.GetEnvironmentVariable("GITHUB_OAUTH_TOKEN");
        public static string GitHubWebhookSecret => Environment.GetEnvironmentVariable("GITHUB_WEBHOOK_SECRET");
        public static string CurseForgeApiKey => Environment.GetEnvironmentVariable("CURSEFORGE_API_KEY");
#endif
    }
}
