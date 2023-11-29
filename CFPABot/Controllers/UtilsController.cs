using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using CFPABot.Azusa.Pages;
using CFPABot.DiffEngine;
using CFPABot.Utils;
using CurseForge.APIClient.Models.Mods;
using GammaLibrary.Extensions;
using Octokit;
using Octokit.Webhooks.Models.PullRequestEvent;
using System.IO;

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

        [HttpGet("GetAllModFilesInRepo")]
        public async Task<JsonResult> GetAllModFilesInRepo()
        {
            var mods = ModList.ModListConfig.Instance.ModLists.Select(x => new {slug=x.modSlug, cfid= ModIDMappingMetadata.Instance.Mapping.GetValueOrDefault(x.modSlug), versions = x.versions.Select(y => y.version.ToVersionDirectory()) })
                .Where(x => x.cfid != 0);

            return new JsonResult(mods);
        }

        [HttpGet("SendMail")]
        public IActionResult SendMail([FromQuery] string password, [FromQuery] string mail)
        {
            if (password != Constants.GitHubWebhookSecret) return Unauthorized();
            MailUtils.SendNotification(mail, "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/3731");
            return Ok();
        }

        [HttpGet("GetCsv/{prid}")]
        public IActionResult GetCsv(string prid)
        {
            var dir = "/app/caches/csv";
            var path1 = dir + $"/{prid}.csv";

            return File(System.IO.File.ReadAllBytes(path1), "text/csv");
        }     
        [HttpGet("GetDiff/{prid}")]
        public IActionResult GetDiff(string prid)
        {
            var dir = "/app/caches/csv";
            var path1 = dir + $"/{prid}.md";

            return File(System.IO.File.ReadAllBytes(path1), "text/markdown");
        }

        private bool VerifyAccess()
        {
            return HttpContext.Request.Headers["Authorization"].FirstOrDefault() == Constants.GitHubWebhookSecret;
        }
    }
}
