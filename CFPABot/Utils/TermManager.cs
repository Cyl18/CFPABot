using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using GammaLibrary.Extensions;

namespace CFPABot.Utils
{
    public class TermManager
    {
        public static async Task Init()
        {
            var file = await Assembly.GetExecutingAssembly().GetManifestResourceStream(Assembly.GetExecutingAssembly().GetManifestResourceNames()
                .Single(str => str.EndsWith("Minecraft-Terms-104816.json"))).ReadToEndAsync1();
            var termsSource = JsonSerializer.Deserialize<TermEntrySource[]>(file);
            var list = new List<TermEntry>();
            foreach (var source in termsSource)
            {
                if (source.English1.NotNullNorWhiteSpace())
                {
                    var entry = new TermEntry()
                    {
                        Comment = source.Comment,
                        Paraphrase = source.Paraphrase,
                        Type = source.Type,
                        Source = source.Source
                    };
                    entry.English = source.English1.ToLower();
                    entry.Chineses = new[] {source.Chinese1.ToLower(), source.Chinese2.ToLower(), source.Chinese3.ToLower() }
                        .Where(l => l.NotNullNorWhiteSpace()).ToArray();
                    list.Add(entry);
                }
                if (source.English2.NotNullNorWhiteSpace())
                {
                    var entry = new TermEntry()
                    {
                        Comment = source.Comment,
                        Paraphrase = source.Paraphrase,
                        Type = source.Type,
                        Source = source.Source
                    };
                    entry.English = source.English2.ToLower();
                    entry.Chineses = new[] { source.Chinese1.ToLower(), source.Chinese2.ToLower(), source.Chinese3.ToLower() }
                        .Where(l => l.NotNullNorWhiteSpace()).ToArray();
                    list.Add(entry);
                }
                if (source.English3.NotNullNorWhiteSpace())
                {
                    var entry = new TermEntry()
                    {
                        Comment = source.Comment,
                        Paraphrase = source.Paraphrase,
                        Type = source.Type,
                        Source = source.Source
                    };
                    entry.English = source.English3.ToLower();
                    entry.Chineses = new[] { source.Chinese1.ToLower(), source.Chinese2.ToLower(), source.Chinese3.ToLower() }
                        .Where(l => l.NotNullNorWhiteSpace()).ToArray();
                    list.Add(entry);
                }
            }

            Terms = list.ToArray();
        }

        public static TermEntry[] Terms { get; private set; }
    }
    public partial class TermEntrySource
    {
        public string Type { get; set; }
        public string English1 { get; set; }
        public string English2 { get; set; }
        public string English3 { get; set; }
        public string Chinese1 { get; set; }
        public string Chinese2 { get; set; }
        public string Chinese3 { get; set; }
        public string Source { get; set; }
        public string Comment { get; set; }
        public string Paraphrase { get; set; }
    }

    public partial class TermEntry
    {
        public string Type { get; set; }
        public string English { get; set; }
        public string[] Chineses { get; set; }
        public string Source { get; set; }
        public string Comment { get; set; }
        public string Paraphrase { get; set; }
    }
}
