using System;
using System.Runtime.Serialization;

namespace CFPABot.Exceptions
{
    [Serializable]
    public class WTFException : Exception
    {
        public WTFException()
        {
        }

        public WTFException(string message) : base(message)
        {
        }

        public WTFException(string message, Exception inner) : base(message, inner)
        {
        }
    }
}
