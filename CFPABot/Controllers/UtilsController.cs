using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Octokit;
using Octokit.Webhooks.Models.PullRequestEvent;

namespace CFPABot.Controllers
{
    [Route("api/[Controller]")]
    [ApiController]
    public class UtilsController : ControllerBase
    {
        [HttpGet("PathValidation")]
        public async Task<string> PathValidation([FromQuery] string pr)
        {
            var fileDiff = await GitHub.Diff(pr.ToInt());
            var sb = new StringBuilder();
            foreach (var diff1 in fileDiff.Where(diff => !diff.To.ToCharArray().All(x => char.IsDigit(x) || char.IsLower(x) || x is '_' or '-' or '.' or '/') && diff.To.Contains("lang")))
            {
                sb.AppendLine($"{diff1.To}");
            }

            return sb.ToString();
        }


        [HttpGet("GitHubToken")]
        public IActionResult GitHubToken()
        {
            if (!VerifyAccess()) return Unauthorized();
            return Content(GitHub.GetToken());
        }

        [HttpGet("ModID")]
        public async Task<string> ModID([FromQuery]string slug, [FromQuery] string versionString)
        {
            return await CurseManager.GetModID(await CurseManager.GetAddon(slug), versionString.ToMCVersion(), true, false);
        }

        private bool VerifyAccess()
        {
            return HttpContext.Request.Headers["Authorization"].FirstOrDefault() == Constants.GitHubWebhookSecret;
        }
    }
}
