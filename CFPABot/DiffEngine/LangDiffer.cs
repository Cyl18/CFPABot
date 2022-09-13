using System.Collections.Generic;
using System.Linq;

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

            var g = list.ToArray();
            var g1 = g.Where(l => l.CurrentEn != l.CurrentCn);
            var g2 = g.Where(l => l.CurrentEn == l.CurrentCn);
            return g1.Concat(g2).ToList();
        }

        private static string PostProcess(this string str)
        {
            if (str.Contains("$"))
            {
                return $"`{str.Replace("\n", "[换行符]")}`";
            }
            else
            {
                return str.Replace("\n", "<br>").Replace("*", "\\*").Replace("|", "\\|");
            }
        }
    }
}
