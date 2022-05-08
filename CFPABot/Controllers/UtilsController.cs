using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Utils;
using Octokit;

namespace CFPABot.Controllers
{
    [Route("api/[Controller]")]
    [ApiController]
    public class UtilsController : ControllerBase
    {
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
