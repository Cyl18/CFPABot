using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Utils;

namespace CFPABot.Controllers
{
    [Route("compare/[controller]")]
    [ApiController]
    public class CompareController : ControllerBase
    {

        public Task<IActionResult> A([FromRoute] string route)
        {
            throw new Exception();
        }
    }
}
