
using System;
using System.Collections.Generic;

namespace CFPABot.Utils.LLMs
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
            return !_handlers.TryGetValue(name, out var h) ? throw new InvalidOperationException($"Tool not found: {name}") : h(arguments);
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
