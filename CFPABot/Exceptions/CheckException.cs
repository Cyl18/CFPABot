using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.Serialization;
using System.Threading.Tasks;

namespace CFPABot.Exceptions
{
    [Serializable]
    public class CheckException : Exception
    {

        public CheckException(string message) : base(message)
        {
        }

    }
}
