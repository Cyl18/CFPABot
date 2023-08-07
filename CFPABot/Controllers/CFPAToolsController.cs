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
        [HttpGet("PRRelation/{prid}")]
        public JsonResult PRRelation(int prid)
        {
            var mods = new List<Mod>();
            var emods = PRDataManager.Relation
                .Where(x => 
                    x.Value.Any(y => y.prid == prid)).ToArray();
            foreach (var (key, value) in emods)
            {
                foreach (var tuple in value)
                {
                    var modId = PRDataManager.GetModID(prid, tuple.modVersion, key);
                    if (modId == null) continue;
                    
                    var gameVersion = tuple.modVersion.ToVersionDirectory();
                    var link = PRDataManager.GetPath(prid, tuple.modVersion, key);
                    var otherPrs = new List<OtherPrs>();
                    foreach (var (s, hashSet) in PRDataManager.Relation
                                 .Where(x => 
                                      x.Key == key))
                    {
                        foreach (var (subPrid, modVersion) in hashSet)
                        {
                            if (subPrid == prid) continue;
                            
                            var subLink = PRDataManager.GetPath(subPrid, modVersion, key);
                            otherPrs.Add(new OtherPrs(subPrid, subLink.en, subLink.cn, modVersion.ToVersionDirectory()));
                            
                        }

                    }
                    mods.Add(new Mod("curseforge", key, modId, link.en, link.cn, 
                        gameVersion, otherPrs));
                }
            }
            //var res = new PRRelationResult(prid,);
            return new JsonResult(new PRRelationResult(prid, mods));
        }
    }

    record PRRelationResult(int number, List<Mod> mod_list);

    record Mod(string type, string id, string modid, string enlink, string zhlink, string version, List<OtherPrs> other);

    record OtherPrs(int number, string enlink, string zhlink, string version);
}
