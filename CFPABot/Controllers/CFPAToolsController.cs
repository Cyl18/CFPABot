using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace CFPABot.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class CFPAToolsController : ControllerBase
    {
        [HttpGet("PRRelation")]
        public JsonResult PRRelation([FromQuery] int prid)
        {
            return new JsonResult(null);
        }
    }

    //record PRRelationResult(int pr, string link, )
    record PrSlugLinkPair(int pr, string slug, string link);
}
