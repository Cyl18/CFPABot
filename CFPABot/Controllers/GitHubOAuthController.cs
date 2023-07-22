﻿using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;
using CFPABot.Azusa;
using CFPABot.Utils;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Octokit;
using Octokit.Internal;
using ProductHeaderValue = Octokit.ProductHeaderValue;

namespace CFPABot.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class GitHubOAuthController : ControllerBase
    {
        static HttpClient hc;

        static GitHubOAuthController()
        {
            hc = new();
        }
        [HttpGet]
        public async Task<IActionResult> OAuth([FromQuery] string code)
        {
            var p = await hc.PostAsync("https://github.com/login/oauth/access_token", new FormUrlEncodedContent(new []
            {
                new KeyValuePair<string, string>("client_id", "20f9e79dfa770f38e95d"),
                new KeyValuePair<string, string>("code", code),
                new KeyValuePair<string, string>("client_secret", Environment.GetEnvironmentVariable("CFPA_HELPER_GITHUB_OAUTH_CLIENT_SECRET")),

            }));
            var clientAccessToken = JsonDocument.Parse(await p.Content.ReadAsStream().ReadToEndAsync1()).RootElement.GetProperty("access_token").GetString();
            try
            {
                var client = LoginManager.GetGitHubClient(clientAccessToken);
                await client.Repository.Get(Constants.RepoID);
            }
            catch (Exception e)
            {
                return Content($"验证错误： {e.Message}");
            }
            HttpContext.Response.Cookies.Append("oauth-token", clientAccessToken, new CookieOptions() {HttpOnly = true});
            return Redirect("/Azusa");
        }
    }
}