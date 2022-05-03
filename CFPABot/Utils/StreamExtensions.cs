using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using GammaLibrary.Extensions;

namespace CFPABot.Utils
{
    public static class StreamExtensions
    {
        public static async Task<string> ReadToEndAsync1(this Stream stream, Encoding encoding = null)
        {
            using var streamReader = stream.CreateStreamReader(encoding);
            return await streamReader.ReadToEndAsync();
        }
    }
}
