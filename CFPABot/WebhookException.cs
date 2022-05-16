using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using JetBrains.Annotations;

namespace CFPABot
{
    public class WebhookException : Exception
    {
        public WebhookException([CanBeNull] string message) : base(message)
        {
        }
    }
}
