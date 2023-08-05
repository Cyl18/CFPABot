using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using CFPABot.Exceptions;
using CFPABot.Utils;
using Serilog;

namespace CFPABot.DiffEngine
{
    public record LangFilePair(LangFile FromENFile, LangFile ToEnFile, LangFile FromCNFile, LangFile ToCNFile, ModPath ModPath);
    public class LangFileFetcher
    {
        public static async Task<List<LangFilePair>> FromPR(int prid, List<Exception> outExceptions)
        {
            var diff = await GitHub.Diff(prid);
            var pr = await GitHub.GetPullRequest(prid);
            var mods = PRAnalyzer.RunBleedingEdge(diff);
            var fromCommit = pr.Base.Sha;
            var prCommit = pr.Head.Sha;

            var list = new List<LangFilePair>();
            foreach (var mod in mods)
            {
                try
                {
                    var fromEn1 = new LangFilePath(mod, LangType.EN).FetchFromCommit(fromCommit);
                    var fromCn1 = new LangFilePath(mod, LangType.CN).FetchFromCommit(fromCommit);
                    var prEn1 = new LangFilePath(mod, LangType.EN).FetchFromCommit(prCommit);
                    var prCn1 = new LangFilePath(mod, LangType.CN).FetchFromCommit(prCommit);

                    await Task.WhenAll(fromEn1, fromCn1, prEn1, prCn1);
                    var fromEn = await fromEn1;
                    var fromCn = await fromCn1;
                    var prEn = await prEn1;
                    var prCn = await prCn1;

                    var fromEnLang = fromEn == null ? null : LangFile.FromString(fromEn, mod.LangFileType);
                    var fromCnLang = fromCn == null ? null : LangFile.FromString(fromCn, mod.LangFileType);
                    var prEnLang = prEn == null ? null : LangFile.FromString(prEn, mod.LangFileType);
                    var prCnLang = prCn == null ? null : LangFile.FromString(prCn, mod.LangFileType);


                    list.Add(new LangFilePair(fromEnLang, prEnLang, fromCnLang, prCnLang, mod));
                }
                catch (Exception e)
                {
                    Log.Warning(e, "LangFileFetcher");
                    outExceptions.Add(e);
                }
            }

            return list;
        }
        

    }
}
