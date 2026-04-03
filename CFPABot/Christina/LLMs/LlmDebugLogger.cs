#nullable enable
using System;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using GammaLibrary.Extensions;

namespace CFPABot.Christina.LLMs
{
    /// <summary>
    /// 为每次 LLM 调用会话创建一个独立目录，把每次 HTTP 请求（包括失败的）记录为单独的 JSON 文件。
    /// 目录格式: config/llm_debug/{yyyyMMdd-HHmmss-fff}_{client}-{method}/
    /// 文件格式: 1.json, 2.json, ...（按请求顺序）
    /// </summary>
    internal static class LlmDebugLogger
    {
        private static readonly string BaseDir = Path.Combine("config", "llm_debug");

        private static readonly JsonSerializerOptions WriteOptions = new()
        {
            WriteIndented = true
        };

        // Masks values of sensitive JSON fields (Authorization, apiKey, api_key)
        private static readonly Regex SensitiveFieldRegex = new(
            @"""(authorization|apiKey|api_key)\s*"":\s*""([^""\\]|\\.)*""",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static string MaskSensitiveFields(string json)
            => SensitiveFieldRegex.Replace(json, m =>
            {
                // Preserve original field name (with quotes) up to the ':' separator
                var colon = m.Value.IndexOf(':');
                return m.Value[..colon] + ": \"***\"";
            });

        internal static string MaskJson(string json) => MaskSensitiveFields(json);

        public static LlmRequestSession StartSession(string label)
        {
            var dirName = $"{DateTime.UtcNow:yyyyMMdd-HHmmss-fff}_{label}";
            var dirPath = Path.Combine(BaseDir, dirName);
            try { Directory.CreateDirectory(dirPath); }
            catch { /* best effort, don't break the main flow */ }
            return new LlmRequestSession(dirPath, WriteOptions);
        }
    }

    internal sealed class LlmRequestSession
    {
        private readonly string _dir;
        private readonly JsonSerializerOptions _options;
        private int _counter;

        internal LlmRequestSession(string dir, JsonSerializerOptions options)
        {
            _dir = dir;
            _options = options;
        }

        /// <summary>把一次请求记录写入 {n}.json，忽略 IO 错误。</summary>
        public async Task WriteAsync(object record)
        {
            var n = Interlocked.Increment(ref _counter);
            var path = Path.Combine(_dir, $"{n}.json");
            try
            {
                var json = LlmDebugLogger.MaskJson(record.ToJsonString(_options));
                await File.WriteAllTextAsync(path, json);
            }
            catch { /* best effort */ }
        }
    }
}
