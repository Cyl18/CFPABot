using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;
using CFPABot.Azusa;
using CFPABot.Utils;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

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

        // GET api/Christina
        [HttpGet("IsAdmin")]
        public async Task<bool> IsAdmin()
        {
            return await LoginManager.IsAdmin(new HttpContextAccessor() { HttpContext = HttpContext });
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
