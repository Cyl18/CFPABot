using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using CFPABot.DiffEngine;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace CFPABot.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class BMCLController : ControllerBase
    {
        [HttpGet("ModList")]
        public string ModList()
        {
            var list = new List<ModListModel>();
            var config = Azusa.Pages.ModList.ModListConfig.Instance;
            foreach (var (modSlug, modName, modDomain, curseForgeLink, versions) in config.ModLists)
            {
                var list1 = new List<(string version, string loader, string repoLink)>();
                foreach (var (version, repoLink) in versions)
                {
                    list1.Add((ModPath.GetVersionDirectory(version.MinecraftVersion, ModLoader.Forge), version.ModLoader.ToString(), repoLink));
                }
                
                list.Add(new ModListModel(modSlug, modName, modDomain, curseForgeLink, list1));
            }

            var options = new JsonSerializerOptions
            {
                WriteIndented = false,
            };
            
            
            return JsonSerializer.Serialize(new BMCLModListModel(list, config.LastTime), options);
        }
        
    }

    public record BMCLModListModel(List<ModListModel> modlist, DateTime lastUpdate);
    public record ModListModel(string modSlug, string modName, string modDomain, string curseForgeLink, List<(string version, string loader, string repoLink)> versions);


}
