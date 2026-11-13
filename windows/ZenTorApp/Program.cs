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
        // Portable, tidy: in the folder (the USB) only ZenTor.exe and Música;
        // the app's files go inside .zentor\app (hidden). PortableRoot is that
        // folder when this exe is the one inside.
        public static string PortableRoot
        {
            get
            {
                var d = Dir.TrimEnd('\\');
                if (d.EndsWith(@"\.zentor\app", StringComparison.OrdinalIgnoreCase)) return Path.GetDirectoryName(Path.GetDirectoryName(d));
                return Portable(Dir) ? Dir : null;
            }
        }
        public static string CoreArgs => PortableRoot != null && !string.Equals(PortableRoot, Dir, StringComparison.OrdinalIgnoreCase) ? "-hosted -root \"" + PortableRoot + "\"" : "-hosted";
        public static Mutex AppLock;

        [STAThread]
        static int Main(string[] args)
        {
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; } catch { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var a = args.Select(x => x.ToLowerInvariant()).ToArray();

            if (a.Contains("--uninstall")) { Setup.Uninstall(); return 0; }
            // the portable folder's ZenTor.exe: it just opens the app inside .zentor\app
            var inner = Path.Combine(Dir, ".zentor", "app", "ZenTor.exe");
            if (!a.Contains("--setup") && File.Exists(inner) && !string.Equals(inner, ExePath, StringComparison.OrdinalIgnoreCase))
            {
                Process.Start(new ProcessStartInfo(inner, string.Join(" ", args.Select(x => "\"" + x + "\""))) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(inner) });
                return 0;
            }
            // a portable one installed with everything loose in the folder: tidied up into .zentor\app
            if (!a.Contains("--setup") && Portable(Dir) && File.Exists(Core) && PortableRoot == Dir)
            {
                try
                {
                    var app = Path.Combine(Dir, ".zentor", "app");
                    Directory.CreateDirectory(app);
                    foreach (var f in Directory.GetFiles(Dir).Where(f => { var n = Path.GetFileName(f); return n.StartsWith("Microsoft.Web.WebView2", StringComparison.OrdinalIgnoreCase) || n.Equals("WebView2Loader.dll", StringComparison.OrdinalIgnoreCase) || n.Equals("ZenTor.exe.config", StringComparison.OrdinalIgnoreCase) || n.Equals("version.txt", StringComparison.OrdinalIgnoreCase) || n.Equals("zentor-core.exe", StringComparison.OrdinalIgnoreCase); }))
                    {
                        var d = Path.Combine(app, Path.GetFileName(f));
                        if (File.Exists(d)) File.Delete(d);
                        File.Move(f, d);
                    }
                    File.Copy(ExePath, Path.Combine(app, "ZenTor.exe"), true);
                    Setup.HideData(Dir);
                    Process.Start(new ProcessStartInfo(Path.Combine(app, "ZenTor.exe"), string.Join(" ", args.Select(x => "\"" + x + "\""))) { UseShellExecute = false, WorkingDirectory = app });
                    return 0;
                }
                catch { }
            }
            // the old ZenTor's "open it when the USB is plugged in" copy, if it became this exe
            if (a.Contains("-watch")) { if (File.Exists(Core)) Start(Core, "-watch"); return 0; }
            if (a.Contains("--setup") || !File.Exists(Core)) { Application.Run(new SetupForm()); return 0; }
            if (a.Contains("--apply-update")) ApplyUpdate();
            Cleanup();
            KeepLauncher();
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

        // the portable folder's ZenTor.exe, the same as this one (after an update)
        static void KeepLauncher()
        {
            var root = PortableRoot;
            if (root == null || string.Equals(root, Dir, StringComparison.OrdinalIgnoreCase)) return;
            new Thread(() =>
            {
                Thread.Sleep(4000);
                try
                {
                    var top = Path.Combine(root, "ZenTor.exe");
                    var me = new FileInfo(ExePath);
                    var it = new FileInfo(top);
                    if (!it.Exists || it.Length != me.Length || it.LastWriteTimeUtc < me.LastWriteTimeUtc) File.Copy(ExePath, top, true);
                }
                catch { }
            }) { IsBackground = true }.Start();
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
