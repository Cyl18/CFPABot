using CFPABot.Exceptions;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using OpenAI;
using OpenAI.Chat;
using System;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Serilog;

namespace CFPABot.CFPALLM;
public record PRReviewAssistantData(string Key, long InReplyToId, string ReplyContent);

public static class CFPALLMManager
{
    public static async Task<(PRReviewAssistantData[] data, string rawOutput)> RunPRReview(int prid, string path)
    {
        var openAiClient = new OpenAIClient(clientSettings: new OpenAIClientSettings("https://ark.cn-beijing.volces.com/api", apiVersion: "v3"),
            openAIAuthentication: Environment.GetEnvironmentVariable("HUOSHAN_API_KEY"), client: new HttpClient() { Timeout = TimeSpan.FromMinutes(1000) });
        var response = await openAiClient.ChatEndpoint.GetCompletionAsync(new ChatRequest(new[]
        {
            new Message(Role.User, "请你扮演一位Minecraft模组语言翻译PR审核者，根据以下Json Schema审核此PR，如果你觉得什么都很好则输出空数组，注意错别字，漏翻，意思不对的情况，你需要提出改进方案（使用```suggestion来表示哪处要换成什么并加上说明和英文原文），```suggestion的前面和后面都需要换行；如果不确定，则提出疑问；在使用```suggestion的时候要注意只修改键值对的值内容，**特别要注意保留空格和键**；" +
                                   "你可以对连续的行进行建议，不仅是对其他人的回复进行回复，你也可以提交新的建议。\n你必须以下方的Json Schema来输出内容，如果不是回复，InReplyToId则为-1，如果有回复，InReplyToId则为回复的ID；ReplyContent则为你的建议，例如输出" + """[{"Key":"a.b","InReplyToId":-1,"ReplyContent":"我的建议是:___"}]。""" + "\n" +
                                     "{\"$schema\":\"http://json-schema.org/draft-07/schema#\",\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"Key\":{\"type\":\"string\"},\"InReplyToId\":{\"type\":\"integer\"},\"ReplyContent\":{\"type\":\"string\"}},\"required\":[\"Key\",\"InReplyToId\",\"ReplyContent\"]}}"+"\n" + await ProcessPrReviewInput(prid, path))
        }, "deepseek-r1-250120", responseFormat: ChatResponseFormat.Json));
        var s = response.FirstChoice.Message.ToString();
        Log.Information($"{prid} 的 LLM 审核结果:");
        Log.Information(s);
        var last = s.Split("</think>").Last();
        var regex = new Regex(@"\[(.|\n)*\]", RegexOptions.Multiline);
        return (regex.Match(last).Value.JsonDeserialize<PRReviewAssistantData[]>(), s);
    }
    public static async Task<string> ProcessPrReviewInput(int prid, string path)
    {
        var sb = new StringBuilder();
        var pr = await GitHub.GetPullRequest(prid);

        var cnFile = await GetLangFileFromGitHub(pr.Head.Sha, path);
        var enFile = await GetLangFileFromGitHub(pr.Head.Sha, path.Replace("zh_cn", "en_us"));
        if (cnFile == null || enFile == null)
        {
            throw new CheckException("找不到对应的文件");
        }

        string enContent;
        if (path.Contains(".json"))
        {
            if (!LangDataNormalizer.ProcessJsonSingle(enFile, out var ens)) throw new CheckException("Json 语法错误");
            enContent = ens.Select(x => $"{x.Key}={x.Value.Replace("\n","\\n")}").Connect("\n");
        }
        else
        {
            enContent = LangDataNormalizer.ProcessLangSingle(enFile).Select(x => $"{x.Key}={x.Value.Replace("\n", "\\n")}").Connect("\n");

        }

        sb.AppendLine("[英文文件]\n" + enContent);
        sb.AppendLine("[中文文件]\nSTART_OF_FILE\n" + cnFile + "END_OF_FILE");

        foreach (var oprr in await GitHub.Instance.PullRequest.ReviewComment.GetAll(Constants.RepoID, prid))
        {
            sb.AppendLine("[Comment]");
            sb.AppendLine($"Id:{oprr.Id}");
            if (oprr.InReplyToId != null)
            {
                sb.AppendLine($"InReplyTo:{oprr.InReplyToId}");
            }

            sb.AppendLine("Content:");
            sb.AppendLine(oprr.Body);
            sb.AppendLine("EndOfContent");
        }

        return sb.ToString();
    }
    // public static async Task<string> ProcessPrReviewInput(int prid, string path)
    // {
    //     var sb = new StringBuilder();
    //     var pr = await GitHub.GetPullRequest(prid);
    //
    //     var cnFile = await GetLangFileFromGitHub(pr.Head.Sha, path);
    //     var enFile = await GetLangFileFromGitHub(pr.Head.Sha, path.Replace("zh_cn", "en_us"));
    //     if (cnFile == null || enFile == null)
    //     {
    //         throw new CheckException("找不到对应的文件");
    //     }
    //
    //     string enContent;
    //     if (path.Contains(".json"))
    //     {
    //         if (!LangDataNormalizer.ProcessJsonSingle(enFile, out var ens)) throw new CheckException("Json 语法错误");
    //         enContent = ens.Select(x => $"{x.Key}={x.Value}").Connect("\n");
    //     }
    //     else
    //     {
    //         enContent = LangDataNormalizer.ProcessLangSingle(enFile).Select(x => $"{x.Key}={x.Value}").Connect("\n");
    //
    //     }
    //
    //     sb.AppendLine("[英文文件]\n"+enContent);
    //     sb.AppendLine("[中文文件]\n" + cnFile);
    //
    //     foreach (var oprr in await GitHub.Instance.PullRequest.ReviewComment.GetAll(Constants.RepoID, prid))
    //     {
    //         sb.AppendLine("[Comment]");
    //         sb.AppendLine($"Id:{oprr.Id}");
    //         if (oprr.InReplyToId != null)
    //         {
    //             sb.AppendLine($"InReplyTo:{oprr.InReplyToId}");
    //         }
    //
    //         sb.AppendLine("Content:");
    //         sb.AppendLine(oprr.Body);
    //         sb.AppendLine("EndOfContent");
    //     }
    //
    //     return sb.ToString();
    // }

    private static HttpClient hc = new HttpClient() {Timeout = TimeSpan.FromMinutes(5)};
    static async Task<string?> GetLangFileFromGitHub(string sha, string path)
    {
        try
        {
            var s = await hc.GetStringAsync(
                $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/{sha}/{path}");
            return s;
        }
        catch (Exception e)
        {
            return null;
        }
    }
}