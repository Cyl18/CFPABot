using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Utils;
using Microsoft.AspNetCore.Http;
using NETCore.Encrypt;
using Octokit;
using Octokit.Internal;
using Serilog;

namespace CFPABot.Azusa
{
    public class LoginManager
    {

        public static string LoginUrl =>
            $"https://github.com/login/oauth/authorize?client_id={Constants.GitHubOAuthClientId}&scope=user:email%20public_repo%20workflow";

        public static string GetToken(IHttpContextAccessor http)
        {
            http.HttpContext!.Request.Cookies.TryGetValue(Constants.GitHubOAuthTokenCookieName, out var token);
            return EncryptProvider.AESDecrypt(token, File.ReadAllText("config/encrypt_key.txt"), "CACTUS&MAMARUO!!");
        }
        
        public static bool GetLoginStatus(IHttpContextAccessor http)
        {
            return http.HttpContext!.Request.Cookies.TryGetValue(Constants.GitHubOAuthTokenCookieName, out _);
        }
        public static GitHubClient GetGitHubClient(IHttpContextAccessor http)
        {
            
            return GetGitHubClient(GetToken(http));
        }

        public static async Task<string[]> GetEmails(IHttpContextAccessor http)
        {
            var client = GetGitHubClient(http);
            try
            {
                var user = await client.User.Current();
                var aEmail = $"{user.Id}+{user.Login}@users.noreply.github.com";
                try
                {
                    var readOnlyList = await client.User.Email.GetAll();
                    return readOnlyList.Select(x => x.Email).Append(aEmail).Distinct().ToArray();
                }
                catch (Exception e)
                {
                    Log.Error(e, "email");
                    return new[] {aEmail};
                }
            }
            catch (Exception e)
            { 
                Log.Error(e, "email");
                return new []{ "cyl18a+error@gmail.com" };
            }
        }

        public static GitHubClient GetGitHubClient(string accessToken)
        {
            var client = new GitHubClient(new ProductHeaderValue("cfpa-bot"), new InMemoryCredentialStore(new Credentials(accessToken)));
            return client;

        }
    }
}
