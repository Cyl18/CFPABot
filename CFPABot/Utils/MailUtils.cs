using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Mail;
using System.Threading.Tasks;

namespace CFPABot.Utils
{
    public class MailUtils
    {
        static HttpClient hc = new();
        public static async Task SendNotification(string mailAddress, string prUrl)
        {
            await hc.PostAsync("https://cfpa-home.cyan.cafe:2/api/Mail/SendMail", new FormUrlEncodedContent(new KeyValuePair<string, string>[]
            {
                new KeyValuePair<string, string>("password", Constants.GitHubWebhookSecret),
                new KeyValuePair<string, string>("mailAddress", mailAddress),
                new KeyValuePair<string, string>("prUrl", prUrl)
            }));
        }
    }
}
