#nullable enable
using System;
using System.Net.Http;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.Utils;

namespace CFPABot.Christina.LLMs
{
    /// <summary>模型来源标识符。格式: "provider:modelId"，例如 "gemini:gemini-2.0-flash" 或 "custom:my-local"</summary>
    public sealed record ModelSpec(
        string Provider,     // "gemini" | "openrouter" | "custom"
        string ModelId,
        string? BaseUrl = null,
        [property: JsonIgnore] string? ApiKeyOverride = null)
    {
        /// <summary>唯一标识，用于 dedup key 和缓存哈希（不含 ApiKey)。</summary>
        public string UniqueId => $"{Provider}:{ModelId}";

        public override string ToString() => UniqueId;
    }

    /// <summary>统一 LLM Provider 接口，每个实例绑定到一个具体 Provider（不含 model 信息）。</summary>
    public interface ILLMProvider
    {
        /// <summary>单轮请求，返回模型文本回复。</summary>
        Task<string> QueryAsync(string userPrompt, string model, CancellationToken ct = default);

        /// <summary>带 system prompt 的单轮请求，返回模型文本回复。</summary>
        Task<string> QueryWithSystemPromptAsync(string systemPrompt, string userPrompt, string model, CancellationToken ct = default);
    }

    /// <summary>根据 ModelSpec 创建对应的 ILLMProvider 实例。</summary>
    public static class LLMProviderFactory
    {
        private static readonly HttpClient SharedHttp = new() { Timeout = TimeSpan.FromMinutes(10) };
        /// <summary>Dedicated client for custom (user-hosted) endpoints — isolated from the shared Gemini/OpenRouter pool.</summary>
        private static readonly HttpClient CustomHttp  = new() { Timeout = TimeSpan.FromMinutes(10) };

        public static ILLMProvider Create(ModelSpec spec)
        {
            return spec.Provider switch
            {
                "gemini" => new GeminiProviderAdapter(
                    new ApiKeyPool(new[]
                    {
                        !string.IsNullOrWhiteSpace(spec.ApiKeyOverride) ? spec.ApiKeyOverride : (Constants.GeminiApiKey ?? throw new InvalidOperationException("GeminiApiKey not set"))
                    }),
                    Constants.GeminiEndpoint ?? throw new InvalidOperationException("GeminiEndpoint not set"),
                    SharedHttp),

                "openrouter" => new OpenRouterProviderAdapter(
                    !string.IsNullOrWhiteSpace(spec.ApiKeyOverride)
                        ? new ApiKeyPool(new[] { spec.ApiKeyOverride })
                        : new ApiKeyPool(new[]
                        {
                            Constants.OpenRouterApiKey ?? throw new InvalidOperationException("OpenRouterApiKey not set"),
                            Constants.OpenRouterApiKey2 ?? Constants.OpenRouterApiKey!
                        }),
                    SharedHttp),

                "custom" => new OpenAICompatClient(
                    spec.BaseUrl ?? throw new InvalidOperationException($"模型 '{spec.ModelId}' 需要配置 Base URL。请在 Model Config 中设置。"),
                    !string.IsNullOrWhiteSpace(spec.ApiKeyOverride) ? spec.ApiKeyOverride : throw new InvalidOperationException($"模型 '{spec.ModelId}' 需要 API Key。请在 Model Config > API Key 管理 中配置。"),
                    CustomHttp),

                _ => throw new ArgumentException($"Unknown provider: {spec.Provider}")
            };
        }
    }
}
