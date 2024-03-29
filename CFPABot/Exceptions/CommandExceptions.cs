﻿using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace CFPABot.Exceptions
{
    [Serializable]
    public class ProcessException : Exception
    {
        public ProcessException(string message) : base(message)
        {

        }
    }

    [Serializable]
    public class CommandException : Exception
    {
        public CommandException(string message) : base(message)
        {
        }
    }
}
