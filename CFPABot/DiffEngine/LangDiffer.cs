using System.Collections.Generic;

namespace CFPABot.DiffEngine
{
    public record LangDiffLine(string Key, string SourceEn, string CurrentEn, string SourceCn, string CurrentCn);
    public static class LangDiffer
    {
        public static List<LangDiffLine> Run(LangFilePair lang)
        {
            var list = new List<LangDiffLine>();
            foreach (var (key, currentCnValue) in lang.ToCNFile.Content)
            {
                var fromEnValue = lang.FromENFile?.Content.GetValueOrDefault(key);
                var fromCnValue = lang.FromCNFile?.Content.GetValueOrDefault(key);
                var currentEnValue = lang.ToEnFile?.Content.GetValueOrDefault(key);
                list.Add(new LangDiffLine(key?.PostProcess(),
                    fromEnValue?.PostProcess(), 
                    currentEnValue?.PostProcess(), 
                    fromCnValue?.PostProcess(), 
                    currentCnValue?.PostProcess()));
            }

            return list;
        }

        private static string PostProcess(this string str)
        {
            return str.Replace("|", "\\|").Replace("\n", "<br>");
        }
    }
}
