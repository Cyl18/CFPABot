#define MOCK

using CFPABot.Azusa;
using CFPABot.Utils;
using CFPABot.Utils.LLMs;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Serilog;
using Serilog.Core;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;

// For more information on enabling Web API for empty projects, visit https://go.microsoft.com/fwlink/?LinkID=397860
namespace CFPABot.Christina.Backend
{
    [Route("api/[controller]")]
    [ApiController]
    public class ChristinaController : ControllerBase
    {
        static HttpClient hc = new HttpClient();

        // GET: api/Christina
        // [HttpGet("GetApiLimit")]
        // public async Task<JsonResult> GetApiLimit()
        // {
        //
        //
        // }

        record PRModsResult(string[] Mods);
        [HttpGet("PRMods")]
        public async Task<JsonResult> PRMods([FromQuery] int pr)
        {
#if MOCK
            return new JsonResult(new PRModsResult(new[] { "create-1.20", "create-1.21", "gregtech-26.1.0" }));
#else
            throw new NotImplementedException();
#endif
        }

        [HttpGet("PRLLMReviewResult")]
        public async Task<JsonResult> PRLLMReviewResult([FromQuery] int pr, [FromQuery] string mod)
        {
            var mockReviewData = new ReviewFrontendDisplay
            {
                FrontendDisplayItems = new List<ReviewFrontendDisplayItem>
            {
    new ReviewFrontendDisplayItem
    {
        Key = "block.stone.name",
        Source = "Stone",
        Target = "石头"
    },
    new ReviewFrontendDisplayItem
    {
        Key = "item.diamond_sword.name",
        Source = "Diamond Sword",
        Target = "钻石剑"
    },
    new ReviewFrontendDisplayItem
    {
        Key = "subtitles.entity.creeper.hiss",
        Source = "Creeper hisses",
        Target = "爬行者发出嘶嘶声"
    },
    new ReviewFrontendDisplayItem
    {
        Key = "gui.difficulty.lock.question",
        Source = "Are you sure you want to lock the difficulty?",
        Target = "你确定要锁定难度吗？"
    },
    new ReviewFrontendDisplayItem
    {
        Key = "tooltip.enchantment.protection",
        Source = "Reduces most types of damage",
        Target = "减少大多数类型的伤害"
    },
    new ReviewFrontendDisplayItem
    {
        Key = "advancements.story.root.title",
        Source = "Minecraft",
        Target = "我的世界"
    }
},

                LLMOutputItems = new List<LlmItemOutput>
    {
        new LlmItemOutput
        {
            Id = 1,
            Status = "pass",
            Issues = new List<LlmIssue>(),
            SuggestedTarget = ""
        },
        new LlmItemOutput
        {
            Id = 2,
            Status = "minor",
            Issues = new List<LlmIssue>
        {
            new LlmIssue
            {
                Severity = "minor",
                Type = "style",
                Message = "物品名可更简洁",
                Suggestion = "钻石剑",
                Reason = "符合物品名简洁风格"
            }
        },
        SuggestedTarget = "钻石剑"
    },
    new LlmItemOutput
    {
        Id = 3,
        Status = "pass",
        Issues = new List<LlmIssue>(),
        SuggestedTarget = ""
    },
    new LlmItemOutput
    {
        Id = 4,
        Status = "needs_fix",
        Issues = new List<LlmIssue>
        {
            new LlmIssue
            {
                Severity = "major",
                Type = "fluency",
                Message = "句子不够通顺",
                Suggestion = "确定要锁定游戏难度吗？",
                Reason = "UI文本需要更明确流畅"
            }
        },
        SuggestedTarget = "确定要锁定游戏难度吗？"
    },
    new LlmItemOutput
    {
        Id = 5,
        Status = "minor",
        Issues = new List<LlmIssue>
        {
            new LlmIssue
            {
                Severity = "minor",
                Type = "terminology",
                Message = "术语不一致",
                Suggestion = "降低大多数类型的伤害",
                Reason = "与游戏内其他保护附魔描述一致"
            }
        },
        SuggestedTarget = "降低大多数类型的伤害"
    },
    new LlmItemOutput
    {
        Id = 6,
        Status = "needs_context",
        Issues = new List<LlmIssue>
        {
            new LlmIssue
            {
                Severity = "blocker",
                Type = "meaning",
                Message = "需要确认标题翻译风格",
                Suggestion = "",
                Reason = "不确定此处应使用'我的世界'还是保留'Minecraft'"
            }
        },
        SuggestedTarget = ""
    }
},

                GlobalNotes = new List<string>
{
    "建议统一'protection'相关术语翻译为'防护'",
    "注意检查所有GUI文本的标点符号使用",
    "物品名称翻译需保持简洁风格"
}
            };

            return new JsonResult(mockReviewData);
        }


        record UserStatusResult(bool IsError, string UserName, string AvatarUrl, bool? IsAdmin);
        // GET api/Christina
        [HttpGet("UserStatus")]
        public async Task<JsonResult> UserStatus()
        {
            try
            {
                var client = LoginManager.GetGitHubClient(new HttpContextAccessor() { HttpContext = HttpContext });
                var user = await client.User.Current();
                var username = user.Login;
                var avatarUrl = user.AvatarUrl;
                var isAdmin = await LoginManager.IsAdmin(user);
                return new JsonResult(new UserStatusResult(false, username, avatarUrl, isAdmin));
            }
            catch (Exception e)
            {
                Log.Error(e, "UserStatus");
                return new JsonResult(new UserStatusResult(true, null, null, null));
            }
        }
        //
        // // GET api/Christina/5
        // [HttpGet("{id}")]
        // public string Get(int id)
        // {
        //     return "value";
        // }
        //
        // // POST api/Christina
        // [HttpPost]
        // public void Post([FromBody] string value)
        // {
        // }
        //
        // // PUT api/Christina/5
        // [HttpPut("{id}")]
        // public void Put(int id, [FromBody] string value)
        // {
        // }
        //
        // // DELETE api/Christina/5
        // [HttpDelete("{id}")]
        // public void Delete(int id)
        // {
        // }
    }
}
