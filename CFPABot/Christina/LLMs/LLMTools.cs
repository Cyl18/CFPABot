using System;
using System.Collections.Generic;
using System.Text.Json;
using Serilog;
using GammaLibrary.Extensions;

namespace CFPABot.Christina.LLMs
{
    public sealed class ToolRegistry
    {
        private readonly Dictionary<string, Func<string, string>> _handlers = new();

        public void Register(string name, Func<string, string> handler)
        {
            _handlers[name] = handler;
        }

        public string Invoke(string name, string arguments)
        {
            if (!_handlers.TryGetValue(name, out var h))
            {
                Log.Warning("ToolRegistry: tool '{ToolName}' not found, returning error to LLM", name);
                return new { error = $"Tool '{name}' not found" }.ToJsonString();
            }
            try
            {
                return h(arguments);
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "ToolRegistry: tool '{ToolName}' threw exception", name);
                return new { error = $"Tool '{name}' failed: {ex.Message}" }.ToJsonString();
            }
        }
    }
    public static class ToolItems
    {
        public static object FunctionOutput(string callId, string output) => new
        {
            type = "function_call_output",
            call_id = callId,
            output = output
        };
    }


}
