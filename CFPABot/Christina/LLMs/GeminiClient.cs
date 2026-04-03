#nullable enable
using GammaLibrary.Extensions;
/*
  Usage example:
  
   var keys = new ApiKeyPool(new[] { "key1", "key2" });
   
   var tools = new ToolRegistry();
   tools.Register("add", args => "{ \"result\": 3 }");
   
   var client = new GeminiClient(
       keys,
       endpointTemplate: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
   );
   
   var request = new GeminiRequest
   {
       Contents = new List<GeminiContent>
       {
           new GeminiContent
           {
               Role = "user",
               Parts = new List<GeminiPart> { GeminiPart.FromText("call tool add") }
           }
       },
       Tools = new[]
       {
           new GeminiFunctionDeclarations
           {
               FunctionDeclarations = new[]
               {
                   new GeminiFunctionDeclaration
                   {
                       Name = "add",
                       Description = "Adds two numbers",
                       Parameters = new { type = "object" }
                   }
               }
           }
       }
   };
   
   var result = await client.RunAsync(
       request,
       tools,
       new ModelPolicy("gemini-2.0-flash", "gemini-1.5-flash")
   );
 */

namespace CFPABot.Christina.LLMs
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Net;
    using System.Net.Http;
    using System.Text;
    using System.Text.Json;
    using System.Text.Json.Serialization;
    using System.Threading;
    using System.Threading.Tasks;
    using Serilog;

    public sealed class GeminiClient
    {
        private readonly HttpClient _http;
        private readonly ApiKeyPool _keyPool;
        private readonly string _endpointTemplate;
        private readonly JsonSerializerOptions _json;

        /// <param name="keyPool">API key pool</param>
        /// <param name="endpointTemplate">
        /// URL template for the Gemini endpoint. Use <c>{model}</c> as a placeholder for the model name.
        /// Example: <c>https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent</c>
        /// The API key will be appended automatically as a <c>key</c> query parameter.
        /// </param>
        /// <param name="httpClient">Optional shared HttpClient</param>
        public GeminiClient(ApiKeyPool keyPool, string endpointTemplate, HttpClient? httpClient = null)
        {
            _keyPool = keyPool;
            _endpointTemplate = endpointTemplate;
            _http = httpClient ?? new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            _json = new JsonSerializerOptions
            {
                PropertyNamingPolicy = SnakeCaseNamingPolicy.Instance,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
            };
        }

        public async Task<GeminiResponseEnvelope> RunAsync(
            GeminiRequest request,
            ToolRegistry tools,
            ModelPolicy modelPolicy,
            CancellationToken ct = default)
        {
            var session = LlmDebugLogger.StartSession("gemini-run");
            var contents = new List<GeminiContent>(request.Contents);
            int sendIndex = 0;

            foreach (var model in modelPolicy.Enumerate())
            {
                while (true)
                {
                    var apiKey = await _keyPool.Acquire();
                    var url = BuildUrl(model, apiKey);

                    using var msg = BuildHttpRequest(url, request, contents);
                    Log.Information("Gemini RunAsync 发送请求, model={Model}, sendIndex={SendIndex}", model, ++sendIndex);
                    var resp = await SendWith429Retry(msg, apiKey, ct);

                    var responseBody = await resp.Content.ReadAsStringAsync();
                    bool success = resp.IsSuccessStatusCode;
                    var contentsSnapshot = contents.ToList();
                    await session.WriteAsync(new
                    {
                        timestamp = DateTime.UtcNow,
                        client = "gemini",
                        method = "run",
                        model,
                        sendIndex,
                        success,
                        statusCode = (int)resp.StatusCode,
                        prompt = new { contents = contentsSnapshot, tools = request.Tools },
                        response = responseBody
                    });

                    if (!success)
                        break;

                    var payload = responseBody.JsonDeserialize<GeminiResponseEnvelope>(_json)
                                  ?? throw new InvalidOperationException("Invalid Gemini response");
                    var toolCalls = payload.ExtractFunctionCalls();

                    if (toolCalls.Count == 0)
                        return payload;

                    // Append the model's tool-call turn
                    contents.Add(new GeminiContent
                    {
                        Role = "model",
                        Parts = toolCalls
                            .Select(c => GeminiPart.FromFunctionCall(c.Name, c.ArgsJson))
                            .ToList()
                    });

                    // Append all tool results in one user turn
                    var resultParts = toolCalls
                        .Select(c => GeminiPart.FromFunctionResponse(c.Name, tools.Invoke(c.Name, c.ArgsJson)))
                        .ToList();

                    contents.Add(new GeminiContent
                    {
                        Role = "user",
                        Parts = resultParts
                    });
                }
            }

            throw new InvalidOperationException("All models exhausted");
        }

        private string BuildUrl(string model, string apiKey)
        {
            var endpoint = _endpointTemplate.Replace("{model}", Uri.EscapeDataString(model));
            var separator = endpoint.Contains('?') ? "&" : "?";
            return $"{endpoint}{separator}key={Uri.EscapeDataString(apiKey)}";
        }

        private HttpRequestMessage BuildHttpRequest(
            string url,
            GeminiRequest req,
            List<GeminiContent> contents)
        {
            var body = new GeminiRequestBody
            {
                Contents = contents,
                Tools = req.Tools,
                GenerationConfig = req.GenerationConfig
            };

            var msg = new HttpRequestMessage(HttpMethod.Post, url);
            msg.Content = new StringContent(
                body.ToJsonString(_json),
                Encoding.UTF8,
                "application/json");

            return msg;
        }

        private async Task<HttpResponseMessage> SendWith429Retry(
            HttpRequestMessage msg,
            string apiKey,
            CancellationToken ct)
        {
            const int maxRetries = 6;
            var attempt = 0;

            while (true)
            {
                var clone = await CloneRequestAsync(msg);
                var resp = await _http.SendAsync(clone, ct);

                if (resp.StatusCode != (HttpStatusCode)429 || attempt >= maxRetries)
                    return resp;

                _keyPool.Penalize(apiKey);

                attempt++;
                var delay = RetryPolicy.ComputeDelay(resp, attempt);
                Log.Warning("Gemini 429 被限流，{Delay}s 后重试 (attempt {Attempt}/{MaxRetries})", delay.TotalSeconds, attempt, maxRetries);
                await Task.Delay(delay, ct);
            }
        }

        // HttpRequestMessage cannot be sent twice; clone it before each retry.
        private static async Task<HttpRequestMessage> CloneRequestAsync(HttpRequestMessage original)
        {
            var clone = new HttpRequestMessage(original.Method, original.RequestUri);
            foreach (var header in original.Headers)
                clone.Headers.TryAddWithoutValidation(header.Key, header.Value);

            if (original.Content is not null)
            {
                var body = await original.Content.ReadAsByteArrayAsync();
                clone.Content = new ByteArrayContent(body);
                foreach (var header in original.Content.Headers)
                    clone.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            return clone;
        }

        private async Task<GeminiResponseEnvelope> ParseAsync(HttpResponseMessage resp)
        {
            var json = await resp.Content.ReadAsStringAsync();
            return json.JsonDeserialize<GeminiResponseEnvelope>(_json)
                   ?? throw new InvalidOperationException("Invalid Gemini response");
        }

        /// <summary>单次请求，不使用工具，直接返回模型的文本回复。</summary>
        public async Task<string> QueryAsync(
            string userPrompt,
            ModelPolicy modelPolicy,
            CancellationToken ct = default)
            => await QueryCoreAsync(systemPrompt: null, userPrompt, modelPolicy, ct);

        /// <summary>Query with a separate system instruction sent via Gemini's system_instruction field.</summary>
        public async Task<string> QueryWithSystemAsync(
            string systemPrompt,
            string userPrompt,
            ModelPolicy modelPolicy,
            CancellationToken ct = default)
            => await QueryCoreAsync(systemPrompt, userPrompt, modelPolicy, ct);

        private async Task<string> QueryCoreAsync(
            string? systemPrompt,
            string userPrompt,
            ModelPolicy modelPolicy,
            CancellationToken ct = default)
        {
            var session = LlmDebugLogger.StartSession("gemini-query");
            var retryDelays = new[] { 0, 1, 5, 5, 5, 5, 5, 30, 60 };

            foreach (var model in modelPolicy.Enumerate())
            {
                for (int attempt = 0; attempt < 9; attempt++)
                {
                    if (attempt > 0)
                    {
                        Log.Warning("Gemini QueryAsync 重试, model={Model}, attempt={Attempt}", model, attempt);
                        await Task.Delay(TimeSpan.FromSeconds(retryDelays[attempt - 1]), ct);
                    }

                    var apiKey = await _keyPool.Acquire();
                    var url = BuildUrl(model, apiKey);

                    var body = new GeminiRequestBody
                    {
                        Contents = new List<GeminiContent>
                        {
                            new GeminiContent
                            {
                                Role = "user",
                                Parts = new List<GeminiPart> { GeminiPart.FromText(userPrompt) }
                            }
                        },
                        SystemInstruction = systemPrompt is null ? null : new GeminiSystemInstruction
                        {
                            Parts = new List<GeminiPart> { GeminiPart.FromText(systemPrompt) }
                        }
                    };

                    Log.Information("Gemini QueryAsync 发送请求, model={Model}, attempt={Attempt}", model, attempt);
                    using var msg = new HttpRequestMessage(HttpMethod.Post, url);
                    msg.Content = new StringContent(
                        body.ToJsonString(_json),
                        Encoding.UTF8,
                        "application/json");

                    var resp = await _http.SendAsync(msg, ct);
                    var responseBody = await resp.Content.ReadAsStringAsync();
                    await session.WriteAsync(new
                    {
                        timestamp = DateTime.UtcNow,
                        client = "gemini",
                        method = "query",
                        model,
                        attempt,
                        success = resp.IsSuccessStatusCode,
                        statusCode = (int)resp.StatusCode,
                        prompt = new { user = userPrompt },
                        response = responseBody
                    });

                    if (!resp.IsSuccessStatusCode)
                        continue;

                    var payload = responseBody.JsonDeserialize<GeminiResponseEnvelope>(_json)
                                  ?? throw new InvalidOperationException("Invalid Gemini response");
                    var text = payload.GetText();
                    if (text is not null)
                        return text;
                }
            }

            throw new InvalidOperationException("All models exhausted");
        }
    }

    // ── Request DTOs ──────────────────────────────────────────────────────────

    public sealed class GeminiRequest
    {
        public List<GeminiContent> Contents { get; set; } = new();
        public GeminiFunctionDeclarations[]? Tools { get; set; }
        public GeminiGenerationConfig? GenerationConfig { get; set; }
    }

    internal sealed class GeminiRequestBody
    {
        public List<GeminiContent> Contents { get; set; } = new();
        public GeminiFunctionDeclarations[]? Tools { get; set; }
        public GeminiGenerationConfig? GenerationConfig { get; set; }
        /// <summary>Gemini system_instruction field — serialised as snake_case by the shared options.</summary>
        public GeminiSystemInstruction? SystemInstruction { get; set; }
    }

    internal sealed class GeminiSystemInstruction
    {
        public List<GeminiPart> Parts { get; set; } = new();
    }

    public sealed class GeminiContent
    {
        public string Role { get; set; } = "";
        public List<GeminiPart> Parts { get; set; } = new();
    }

    public sealed class GeminiPart
    {
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Text { get; set; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public GeminiFunctionCall? FunctionCall { get; set; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public GeminiFunctionResponse? FunctionResponse { get; set; }

        public static GeminiPart FromText(string text) =>
            new() { Text = text };

        public static GeminiPart FromFunctionCall(string name, string argsJson) =>
            new()
            {
                FunctionCall = new GeminiFunctionCall
                {
                    Name = name,
                    Args = argsJson.JsonDeserialize<JsonElement>()
                }
            };

        public static GeminiPart FromFunctionResponse(string name, string outputJson) =>
            new()
            {
                FunctionResponse = new GeminiFunctionResponse
                {
                    Name = name,
                    Response = (string.IsNullOrWhiteSpace(outputJson) ? "{}" : outputJson).JsonDeserialize<JsonElement>()
                }
            };
    }

    public sealed class GeminiFunctionCall
    {
        public string Name { get; set; } = "";
        public JsonElement Args { get; set; }
    }

    public sealed class GeminiFunctionResponse
    {
        public string Name { get; set; } = "";
        public JsonElement Response { get; set; }
    }

    public sealed class GeminiFunctionDeclarations
    {
        public GeminiFunctionDeclaration[] FunctionDeclarations { get; set; } =
            Array.Empty<GeminiFunctionDeclaration>();
    }

    public sealed class GeminiFunctionDeclaration
    {
        public string Name { get; set; } = "";
        public string? Description { get; set; }
        public object? Parameters { get; set; }
    }

    public sealed class GeminiGenerationConfig
    {
        public double? Temperature { get; set; }
        public double? TopP { get; set; }
        public int? MaxOutputTokens { get; set; }
    }

    // ── Response DTOs ─────────────────────────────────────────────────────────

    public sealed class GeminiResponseEnvelope
    {
        public List<GeminiCandidate> Candidates { get; set; } = new();

        /// <summary>Returns the text of the first candidate's first text part, or null.</summary>
        public string? GetText()
        {
            return Candidates
                .FirstOrDefault()
                ?.Content.Parts
                .FirstOrDefault(p => p.Text is not null)
                ?.Text;
        }

        public List<GeminiFunctionCallInfo> ExtractFunctionCalls()
        {
            var list = new List<GeminiFunctionCallInfo>();

            foreach (var candidate in Candidates)
            {
                foreach (var part in candidate.Content.Parts)
                {
                    if (part.FunctionCall is not null)
                    {
                        list.Add(new GeminiFunctionCallInfo
                        {
                            Name = part.FunctionCall.Name,
                            ArgsJson = part.FunctionCall.Args.ToString()
                        });
                    }
                }
            }

            return list;
        }
    }

    public sealed class GeminiCandidate
    {
        public GeminiContent Content { get; set; } = new();
        public string? FinishReason { get; set; }
    }

    public sealed class GeminiFunctionCallInfo
    {
        public string Name = "";
        public string ArgsJson = "";
    }

    /// <summary>将 GeminiClient 适配为 ILLMProvider。</summary>
    public sealed class GeminiProviderAdapter : ILLMProvider
    {
        private readonly GeminiClient _client;

        public GeminiProviderAdapter(ApiKeyPool keyPool, string endpointTemplate, HttpClient? http = null)
        {
            _client = new GeminiClient(keyPool, endpointTemplate, http);
        }

        public Task<string> QueryAsync(string userPrompt, string model, CancellationToken ct = default)
            => _client.QueryAsync(userPrompt, new ModelPolicy(model), ct);

        public Task<string> QueryWithSystemPromptAsync(string systemPrompt, string userPrompt, string model, CancellationToken ct = default)
            => _client.QueryWithSystemAsync(systemPrompt, userPrompt, new ModelPolicy(model), ct);
    }

    internal sealed class SnakeCaseNamingPolicy : JsonNamingPolicy
    {
        public static readonly SnakeCaseNamingPolicy Instance = new();

        public override string ConvertName(string name)
        {
            if (name.IsNullOrEmpty()) return name;

            var sb = new System.Text.StringBuilder(name.Length + 4);
            for (var i = 0; i < name.Length; i++)
            {
                var c = name[i];
                if (char.IsUpper(c))
                {
                    if (i > 0) sb.Append('_');
                    sb.Append(char.ToLowerInvariant(c));
                }
                else
                {
                    sb.Append(c);
                }
            }

            return sb.ToString();
        }
    }
}
