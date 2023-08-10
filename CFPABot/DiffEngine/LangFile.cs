using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary.Extensions;

namespace CFPABot.DiffEngine
{
    public class LangFileWrapper
    {
        private string url { get; set; }
        private string content { get; set; }
        private bool isWeb { get; set; } = false;
        private bool isLangFile { get; set; } = false;
        private LangFileType type { get; set; }
        private LangFile langFile { get; set; }

        public static LangFileWrapper FromWebUrl(string url)
        {
            return new LangFileWrapper() { url = url, isWeb = true };
        }
        public static LangFileWrapper FromContent(string content)
        {
            return new LangFileWrapper() { content = content, isWeb = false };
        }
        
        public static LangFileWrapper FromLangFile(LangFile content)
        {
            return new LangFileWrapper() { langFile = content, isLangFile = true };
        }

        public static LangFileType GuessType(string content)
        {
            // 我觉得不会有作者写成一行的 /**/ { 吧????
            if (content.Split('\n').Any(x => x.TrimStart().StartsWith('{')))
                return LangFileType.Json;
            return LangFileType.Lang;
        }

        public async ValueTask<LangFile> Get()
        {
            if (isWeb)
            {
                var s = await Download.String(url);
                return LangFile.FromString(s, GuessType(s));
            }
            if (isLangFile)
            {
                return langFile;
            }
            return LangFile.FromString(content, GuessType(content));

        }
    }

    public class LangFile
    {
        public Dictionary<string, string> Content { get; private set; }= new Dictionary<string, string>();
        public static LangFile Empty { get; } = new LangFile() { Content = new Dictionary<string, string>() };
        public string OriginalFile { get; private set; }
        private LangFile()
        {
        }

        public static LangFile FromString(string content, LangFileType langFileType)
        {
            var result = new LangFile();
            result.OriginalFile = content;
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
                })
                .DistinctBy(o => o.Key)  // workaround https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/2198
                .ToDictionary(o => o.Key, o => o.Value); // 提取 Key
        }
    }
}
