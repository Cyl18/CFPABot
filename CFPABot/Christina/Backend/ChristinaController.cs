using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;
using CFPABot.Azusa;
using CFPABot.Utils;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Serilog;
using Serilog.Core;

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
