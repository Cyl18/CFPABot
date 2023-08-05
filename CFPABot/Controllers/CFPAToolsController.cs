using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.DiffEngine;
using CFPABot.PRData;
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
            var mods = new List<Mod>();
            var emods = PRDataManager.Relation.Where(x => x.Value.Any(y => y.prid == prid)).ToArray();
            foreach (var (key, value) in emods)
            {
                foreach (var tuple in value)
                {
                    var modId = PRDataManager.GetModID(prid, tuple.modVersion, key);
                    var gameVersion = ModPath.GetVersionDirectory(tuple.modVersion.MinecraftVersion, tuple.modVersion.ModLoader);
                    //mods.Add(new Mod("curseforge", key, modId, 
                      //  $"https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/tree/{PRDataManager.GetHeadSha(prid)}/projects/{gameVersion}/assets/{key}/{modId}/lang", gameVersion, new OtherPrs()));
                }
            }
            //var res = new PRRelationResult(prid,);
            return new JsonResult(null);
        }
    }

    record PRRelationResult(int number, Mod[] mod_list);

    record Mod(string type, string id, string modid, string enlink, string zhlink, string version, OtherPrs[] other);

    record OtherPrs(int number, string enlink, string zhlink);
}
