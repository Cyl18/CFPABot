using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using GammaLibrary.Extensions;

namespace CFPABot.CFPALLM
{
    record LangDataNormalizerData(List<KeyValuePair<string, string>> EnOriginalData, List<KeyValuePair<string, string>> CnOriginalData, List<KeyValuePair<string, string>> NormalizedEnData, List<KeyValuePair<string, string>> NormalizedCnData);

    internal class LangDataNormalizer
    {
        public static LangDataNormalizerData ProcessLangFile(string enfile, string cnfile)
        {
            var ens = ProcessLangSingle(enfile);
            var cns = ProcessLangSingle(cnfile);
            return ProcessLastStage(ens.ToList(), cns.ToList());
        }

        public static IEnumerable<KeyValuePair<string, string>> ProcessLangSingle(string enfile)
        {
            var ens = enfile.Split("\n")
                .Select(line => line.Trim()) // Trim
                .Where(line => !line.IsNullOrWhiteSpace()) // 移除空行
                .Where(line => !line.StartsWith("#")) // 移除注释
                .Where(line => line.Contains("=")) // 保证有等号
                .Select(line =>
                {
                    var s = line.Split("=", 2);
                    return new KeyValuePair<string, string>(s[0], s[1]);
                })
                .DistinctBy(o => o.Key);
            return ens;
        }

        public static LangDataNormalizerData? ProcessJsonFile(string enfile, string cnfile)
        {
            if (ProcessJsonSingle(enfile, out var ens)) return null;
            if (ProcessJsonSingle(cnfile, out var cns)) return null;
            return ProcessLastStage(ens.ToList(), cns.ToList());
        }

        public static bool ProcessJsonSingle(string enfile, out IEnumerable<KeyValuePair<string, string>> ens)
        {
            var document = JsonDocument.Parse(enfile, new() { CommentHandling = JsonCommentHandling.Skip });
            if (!document.RootElement.EnumerateObject().Any())
            {
                ens = null; return false;
            }
            ens = document.RootElement
                .EnumerateObject()
                .Where(k => !k.Name.StartsWith("_"))
                .Select(o => new KeyValuePair<string, string>(o.Name, o.Value.ValueKind == JsonValueKind.String ? o.Value.GetString() : o.Value.GetRawText()))
                .DistinctBy(o => o.Key);
            return true;
        }

        public static List<KeyValuePair<string, string>> Unnormalize(List<KeyValuePair<string, string>> data)
        {
            // a.b.c
            // ..d (a.b.d)
            // .e (a.e)
            // ..f (a.e.f)
            var decodedFullKey = new Queue<string>();
            var result = new List<KeyValuePair<string, string>>();
            foreach (var s in data)
            {
                var unprocessedKey = s.Key;
                var value = s.Value;
                var keyBuilder = new StringBuilder();
                var endFlag = false;
                foreach (var c in unprocessedKey)
                {
                    if (endFlag)
                    {
                        keyBuilder.Append(c);
                    }
                    else
                    {
                        if (c == '.')
                        {
                            keyBuilder.Append(decodedFullKey.Dequeue() + '.');
                        }
                        else
                        {
                            endFlag = true;
                            keyBuilder.Append(c);
                        }
                    }
                }

                var key = keyBuilder.ToString().TrimEnd('.');
                result.Add(new KeyValuePair<string, string>(key, value));
                decodedFullKey = new Queue<string>(key.Split('.'));
            }

            return result;
        }
        public static List<KeyValuePair<string, string>> Normalize(List<KeyValuePair<string, string>> data)
        {
            var queue = new Queue<string>(0);
            var result = new List<KeyValuePair<string, string>>();
            foreach (var (key, value) in data)
            {
                var segments = key.Split('.');
                var resultKey = new StringBuilder();

                var difFlag = false;
                foreach (var seg in segments)
                {
                    if (difFlag)
                    {
                        resultKey.Append(seg + ".");
                        continue;
                    }
                    if (queue.TryDequeue(out var baseSeg))
                    {
                        if (baseSeg == seg)
                        {
                            resultKey.Append(".");
                        }
                        else
                        {
                            resultKey.Append(seg + ".");
                            difFlag = true;
                        }
                    }
                    else
                    {
                        resultKey.Append(seg + ".");
                    }
                }

                queue = new Queue<string>(segments);
                result.Add(new KeyValuePair<string, string>(resultKey.ToString().TrimEnd('.'), value));
            }

            return result;
        }
        static LangDataNormalizerData ProcessLastStage(List<KeyValuePair<string, string>> ens, List<KeyValuePair<string, string>> cns)
        {
            List<KeyValuePair<string, string>> ens2 = new();
            List<KeyValuePair<string, string>> cns2 = new();
            foreach (var (key, env) in ens)
            {
                if (cns.FirstOrDefault(x => x.Key == key) is { } pair && pair.Key == null) continue;
                //if (!IsChinese(cnv)) continue;
                var cnv = pair.Value;
                ens2.Add(new KeyValuePair<string, string>(key, env.Trim()));
                cns2.Add(new KeyValuePair<string, string>(key, cnv.Trim()));
            }

            return new LangDataNormalizerData(ens2, cns2, Normalize(ens2), Normalize(cns2));
        }
    }
}
