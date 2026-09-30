using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class Program
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static int Main()
    {
        try
        {
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            while (true)
            {
                Dictionary<string, object> message = ReadMessage(input);
                if (message == null) break;
                WriteMessage(output, Handle(message));
            }
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    private static Dictionary<string, object> Handle(Dictionary<string, object> message)
    {
        string url = message.ContainsKey("url") ? Convert.ToString(message["url"]) : "";
        string browser = message.ContainsKey("browser") ? Convert.ToString(message["browser"]).ToLowerInvariant() : "system";
        Uri parsed;
        if (!Uri.TryCreate(url, UriKind.Absolute, out parsed) || (parsed.Scheme != "http" && parsed.Scheme != "https"))
            return Reply(false, browser, "Разрешены только http/https ссылки");

        try
        {
            if (browser == "system")
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return Reply(true, browser, null);
            }

            string exeName = browser == "chrome" ? "chrome.exe" : browser == "edge" ? "msedge.exe" : browser == "firefox" ? "firefox.exe" : "";
            if (exeName.Length == 0) return Reply(false, browser, "Неизвестный браузер");
            string path = FindBrowser(exeName);
            if (String.IsNullOrEmpty(path)) return Reply(false, browser, "Браузер не найден в системе");
            Process.Start(new ProcessStartInfo(path, Quote(url)) { UseShellExecute = true });
            return Reply(true, browser, null);
        }
        catch (Exception ex)
        {
            return Reply(false, browser, ex.Message);
        }
    }

    private static Dictionary<string, object> Reply(bool ok, string browser, string error)
    {
        var result = new Dictionary<string, object>();
        result["ok"] = ok;
        result["browser"] = browser;
        if (!String.IsNullOrEmpty(error)) result["error"] = error;
        return result;
    }

    private static string FindBrowser(string exe)
    {
        string sub = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe;
        object value = Registry.GetValue(@"HKEY_CURRENT_USER\" + sub, "", null) ?? Registry.GetValue(@"HKEY_LOCAL_MACHINE\" + sub, "", null);
        string path = value as string;
        if (!String.IsNullOrEmpty(path) && File.Exists(path)) return path;

        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates;
        if (exe == "chrome.exe") candidates = new[] { Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"), Path.Combine(pfx86, @"Google\Chrome\Application\chrome.exe"), Path.Combine(local, @"Google\Chrome\Application\chrome.exe") };
        else if (exe == "msedge.exe") candidates = new[] { Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"), Path.Combine(pfx86, @"Microsoft\Edge\Application\msedge.exe"), Path.Combine(local, @"Microsoft\Edge\Application\msedge.exe") };
        else candidates = new[] { Path.Combine(pf, @"Mozilla Firefox\firefox.exe"), Path.Combine(pfx86, @"Mozilla Firefox\firefox.exe") };
        foreach (string candidate in candidates) if (File.Exists(candidate)) return candidate;
        return null;
    }

    private static string Quote(string value) { return "\"" + value.Replace("\"", "%22") + "\""; }

    private static Dictionary<string, object> ReadMessage(Stream input)
    {
        byte[] header = new byte[4];
        int first = input.ReadByte();
        if (first < 0) return null;
        header[0] = (byte)first;
        ReadExact(input, header, 1, 3);
        int length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > 1024 * 1024) throw new InvalidDataException("Bad message length");
        byte[] body = new byte[length];
        ReadExact(input, body, 0, length);
        return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
    }

    private static void WriteMessage(Stream output, Dictionary<string, object> message)
    {
        byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(message));
        byte[] header = BitConverter.GetBytes(body.Length);
        output.Write(header, 0, header.Length);
        output.Write(body, 0, body.Length);
        output.Flush();
    }

    private static void ReadExact(Stream input, byte[] buffer, int offset, int count)
    {
        while (count > 0)
        {
            int n = input.Read(buffer, offset, count);
            if (n <= 0) throw new EndOfStreamException();
            offset += n;
            count -= n;
        }
    }
}
