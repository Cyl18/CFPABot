using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using CFPABot.Utils;
using GammaLibrary.Extensions;

namespace CFPABot.DiffEngine
{

    public class LangFile
    {
        public Dictionary<string, string> Content = new Dictionary<string, string>();

        private LangFile()
        {
        }

        public static LangFile FromString(string content, LangFileType langFileType)
        {
            var result = new LangFile();
            switch (langFileType)
            {
                case LangFileType.Lang:
                    result.LoadLang(content);    
                    break;
                case LangFileType.Json:
                    result.LoadJson(content);
                    break;
            }
            return result;
        }

        void LoadJson(string content)
        {
            var document = JsonDocument.Parse(content, new() { CommentHandling = JsonCommentHandling.Skip });
            if (!document.RootElement.EnumerateObject().Any()) return;
            Content = document.RootElement
                .EnumerateObject()
                .Where(k => !k.Name.StartsWith("_"))
                .Select(o => new KeyValuePair<string, string>(o.Name, o.Value.GetString()))
                .DistinctBy(o => o.Key) // workaround https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/2070
                .ToDictionary(o => o.Key, o => o.Value);
        }

        void LoadLang(string content)
        {
            Content = content.Split("\n")
                .Select(line => line.Trim()) // Trim
                .Where(line => !line.IsNullOrWhiteSpace()) // 移除空行
                .Where(line => !line.StartsWith("#")) // 移除注释
                .Where(line => line.Contains("=")) // 保证有等号
                .Select(line =>
                {
                    var s = line.Split("=", 2);
                    return new KeyValuePair<string, string>(s[0], s[1]);
                }).ToDictionary(o => o.Key, o => o.Value); // 提取 Key
        }
    }
}
