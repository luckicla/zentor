// ZenTor for Windows. One exe, three jobs:
//  - the app: its own window (WebView2, the same engine as Edge) showing
//    ZenTor's interface, served by zentor-core.exe next to it;
//  - the installer ("ZenTor-Setup.exe", or this exe when the core isn't next
//    to it): installed in the PC or portable (a USB…), and moving everything
//    over from an older ZenTor;
//  - updates (--apply-update) and uninstalling (--uninstall).
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace ZenTorApp
{
    static class Program
    {
        public const string Url = "http://127.0.0.1:47811/";
        public const string Base = "https://github.com/luckicla/zentor/releases/download/pc-latest/";
        public static readonly string ExePath = Application.ExecutablePath;
        public static readonly string Dir = Path.GetDirectoryName(Application.ExecutablePath);
        public static string Core => Path.Combine(Dir, "zentor-core.exe");
        public static string LocalApp => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        public static string RoamingData => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ZenTor");
        public static string InstallDir => Path.Combine(LocalApp, "Programs", "ZenTor");
        public static bool Portable(string dir) => Directory.Exists(Path.Combine(dir, ".zentor"));
        public static Mutex AppLock;

        [STAThread]
        static int Main(string[] args)
        {
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; } catch { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var a = args.Select(x => x.ToLowerInvariant()).ToArray();

            if (a.Contains("--uninstall")) { Setup.Uninstall(); return 0; }
            // the old ZenTor's "open it when the USB is plugged in" copy, if it became this exe
            if (a.Contains("-watch")) { if (File.Exists(Core)) Start(Core, "-watch"); return 0; }
            if (a.Contains("--setup") || !File.Exists(Core)) { Application.Run(new SetupForm()); return 0; }
            if (a.Contains("--apply-update")) ApplyUpdate();
            Cleanup();
            RunApp();
            return 0;
        }

        // (kept apart so the installer never needs the WebView2 files)
        [MethodImpl(MethodImplOptions.NoInlining)]
        static void RunApp() => AppRunner.Run();

        public static Process Start(string exe, string args, bool hidden = true)
        {
            var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe), CreateNoWindow = hidden };
            return Process.Start(psi);
        }

        public static bool CoreAnswers()
        {
            try
            {
                using (var h = new HttpClient { Timeout = TimeSpan.FromSeconds(1.5) })
                    return h.GetAsync(Url + "api/version").Result.IsSuccessStatusCode;
            }
            catch { return false; }
        }

        public static void AskQuit()
        {
            try { using (var h = new HttpClient { Timeout = TimeSpan.FromSeconds(2) }) h.PostAsync(Url + "api/quit", new StringContent("")).Wait(2500); } catch { }
        }

        public static void Cleanup()
        {
            foreach (var n in new[] { "ZenTor.old.exe", "ZenTor.setup-old.exe" })
                try { File.Delete(Path.Combine(Dir, n)); } catch { }
        }

        // the update the core downloaded (update\files): moved in now, with the
        // old app window already gone
        static void ApplyUpdate()
        {
            var src = Path.Combine(Dir, "update", "files");
            if (!Directory.Exists(src)) return;
            // wait for the window that asked for it to close
            using (var m = new Mutex(false, @"Local\ZenTorApp"))
            {
                try { if (m.WaitOne(TimeSpan.FromSeconds(20))) m.ReleaseMutex(); } catch (AbandonedMutexException) { try { m.ReleaseMutex(); } catch { } }
            }
            for (int tries = 0; tries < 40; tries++)
            {
                try { Setup.CopyInto(src, Dir); break; }
                catch { Thread.Sleep(500); }
            }
            try { Directory.Delete(Path.Combine(Dir, "update"), true); } catch { }
        }

        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);

        public static string T(string es, string en, string ca)
        {
            var l = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
            return l == "ca" ? ca : l == "es" || l == "gl" || l == "eu" ? es : en;
        }
    }
}
