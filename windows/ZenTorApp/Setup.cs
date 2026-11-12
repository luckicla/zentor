// Installing ZenTor (in the PC or portable), moving over what an older ZenTor
// had, and uninstalling.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ZenTorApp
{
    static class Setup
    {
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ZenTor";

        // an older ZenTor: the single ZenTor.exe that updated itself into this one
        public static bool FromOld =>
            File.Exists(Path.Combine(Program.Dir, "ZenTor.old.exe")) ||
            string.Equals(Path.GetFileName(Program.ExePath), "ZenTor.exe", StringComparison.OrdinalIgnoreCase);

        // where that older one kept things: on its USB (portable) or in the user's profile
        public static bool OldPortable
        {
            get
            {
                if (Directory.Exists(Path.Combine(Program.Dir, ".zentor"))) return true;
                try { return new DriveInfo(Path.GetPathRoot(Program.Dir)).DriveType == DriveType.Removable; } catch { return false; }
            }
        }

        public static async Task Install(string target, bool portable, bool desktop, IProgress<(int pct, string msg)> report)
        {
            target = Path.GetFullPath(target);
            Directory.CreateDirectory(target);

            // 1. what's coming: the newest app, checked
            report.Report((2, Program.T("Buscando la última versión…", "Looking for the latest version…", "Cercant l'última versió…")));
            string ver, sum;
            using (var h = new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
            {
                var line = (await h.GetStringAsync(Program.Base + "app.txt")).Trim().Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                ver = line[0]; sum = line[1].ToLowerInvariant();
            }
            var zip = Path.Combine(Path.GetTempPath(), "ZenTor-pc-" + Guid.NewGuid().ToString("N") + ".zip");
            using (var h = new HttpClient { Timeout = TimeSpan.FromMinutes(20) })
            using (var r = await h.GetAsync(Program.Base + "ZenTor-pc.zip", HttpCompletionOption.ResponseHeadersRead))
            {
                r.EnsureSuccessStatusCode();
                long total = r.Content.Headers.ContentLength ?? 0, got = 0;
                using (var src = await r.Content.ReadAsStreamAsync())
                using (var dst = File.Create(zip))
                {
                    var buf = new byte[1 << 16];
                    int n;
                    while ((n = await src.ReadAsync(buf, 0, buf.Length)) > 0)
                    {
                        await dst.WriteAsync(buf, 0, n);
                        got += n;
                        report.Report((5 + (int)(total > 0 ? 70 * got / total : 0), Program.T("Descargando ZenTor… ", "Downloading ZenTor… ", "Baixant ZenTor… ") + (got >> 20) + " MB"));
                    }
                }
            }
            using (var f = File.OpenRead(zip))
            using (var sha = SHA256.Create())
            {
                var hex = string.Concat(sha.ComputeHash(f).Select(b => b.ToString("x2")));
                if (hex != sum) { File.Delete(zip); throw new Exception(Program.T("La descarga llegó mal, prueba otra vez", "The download arrived damaged, try again", "La baixada ha arribat malament, torna-ho a provar")); }
            }

            // 2. any ZenTor that's open closes (the old one too)
            report.Report((78, Program.T("Cerrando el ZenTor abierto…", "Closing the open ZenTor…", "Tancant el ZenTor obert…")));
            Program.AskQuit();
            await Task.Delay(1200);
            foreach (var name in new[] { "zentor-core", "ZenTor-auto", "ZenTor.old" })
                foreach (var p in Process.GetProcessesByName(name)) try { p.Kill(); p.WaitForExit(3000); } catch { }
            foreach (var p in Process.GetProcessesByName("ZenTor"))
                if (p.Id != Process.GetCurrentProcess().Id) try { p.Kill(); p.WaitForExit(3000); } catch { }

            // 3. the files
            report.Report((82, Program.T("Instalando…", "Installing…", "Instal·lant…")));
            var tmp = Path.Combine(Path.GetTempPath(), "ZenTor-files-" + Guid.NewGuid().ToString("N"));
            ZipFile.ExtractToDirectory(zip, tmp);
            File.Delete(zip);
            for (int tries = 0; ; tries++)
            {
                try { CopyInto(tmp, target); break; }
                catch { if (tries > 20) throw; await Task.Delay(500); }
            }
            try { Directory.Delete(tmp, true); } catch { }
            if (portable)
            {
                Directory.CreateDirectory(Path.Combine(target, ".zentor"));
                Directory.CreateDirectory(Path.Combine(target, "Música"));
            }

            // 4. everything the older ZenTor had: playlists, settings, covers, the DJ's analyses…
            report.Report((90, Program.T("Pasando tus playlists, ajustes y todo lo demás…", "Moving your playlists, settings and everything else…", "Passant les teves llistes, configuració i tota la resta…")));
            MoveData(target, portable);

            // 5. Start menu, desktop, "Installed apps"
            report.Report((96, Program.T("Últimos detalles…", "Final touches…", "Últims detalls…")));
            var app = Path.Combine(target, "ZenTor.exe");
            if (!portable)
            {
                Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "ZenTor.lnk"), app);
                Register(target, ver);
            }
            if (desktop) Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "ZenTor.lnk"), app);
            // the "open ZenTor when the USB is plugged in" helper, if it was on
            var auto = Path.Combine(Program.LocalApp, "ZenTor", "ZenTor-auto.exe");
            if (File.Exists(auto)) try { File.Copy(Path.Combine(target, "zentor-core.exe"), auto, true); Process.Start(new ProcessStartInfo(auto, "-watch") { UseShellExecute = false, CreateNoWindow = true }); } catch { }
            report.Report((100, Program.T("¡Listo!", "Done!", "Fet!")));
        }

        // into dir: everything in src (a running exe can't be replaced, but it can be renamed)
        public static void CopyInto(string src, string dir)
        {
            foreach (var f in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
            {
                var rel = f.Substring(src.Length).TrimStart('\\', '/');
                var dst = Path.Combine(dir, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dst));
                if (File.Exists(dst))
                {
                    try { File.Delete(dst); }
                    catch
                    {
                        var old = dst + ".old-" + DateTime.Now.Ticks;
                        if (string.Equals(dst, Program.ExePath, StringComparison.OrdinalIgnoreCase)) old = Path.Combine(Path.GetDirectoryName(dst), "ZenTor.setup-old.exe");
                        try { File.Delete(old); } catch { }
                        File.Move(dst, old);
                    }
                }
                File.Copy(f, dst);
            }
        }

        static void MoveData(string target, bool portable)
        {
            var installedData = Program.RoamingData;
            var oldPortableData = Path.Combine(Program.Dir, ".zentor");
            bool samePlace = string.Equals(Path.GetFullPath(Program.Dir).TrimEnd('\\'), target.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
            if (!portable)
            {
                if (FromOld && OldPortable && !samePlace && Directory.Exists(oldPortableData) && !File.Exists(Path.Combine(installedData, "settings.json")))
                    CopyDir(oldPortableData, installedData);
            }
            else
            {
                var dst = Path.Combine(target, ".zentor");
                var src = FromOld && OldPortable && !samePlace && Directory.Exists(oldPortableData) ? oldPortableData : installedData;
                if (!samePlace || !Directory.Exists(oldPortableData))
                    if (Directory.Exists(src) && !File.Exists(Path.Combine(dst, "settings.json"))) CopyDir(src, dst);
            }
            // what the old window kept in its browser profile (the page also keeps a copy in the data folder)
            var oldLS = Path.Combine(Program.LocalApp, "ZenTor", "profile", "Default", "Local Storage");
            var udf = portable ? Path.Combine(target, ".zentor", "webview") : Path.Combine(Program.LocalApp, "ZenTor", "webview");
            var newLS = Path.Combine(udf, "EBWebView", "Default", "Local Storage");
            if (Directory.Exists(oldLS) && !Directory.Exists(newLS)) try { CopyDir(oldLS, newLS); } catch { }
        }

        public static void CopyDir(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var d in Directory.GetDirectories(src, "*", SearchOption.AllDirectories))
            {
                var rel = d.Substring(src.Length).TrimStart('\\');
                if (rel.StartsWith("webview", StringComparison.OrdinalIgnoreCase)) continue;
                Directory.CreateDirectory(Path.Combine(dst, rel));
            }
            foreach (var f in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
            {
                var rel = f.Substring(src.Length).TrimStart('\\');
                if (rel.StartsWith("webview", StringComparison.OrdinalIgnoreCase)) continue;
                try { File.Copy(f, Path.Combine(dst, rel), false); } catch { }
            }
        }

        static void Shortcut(string lnk, string target)
        {
            try
            {
                var t = Type.GetTypeFromProgID("WScript.Shell");
                var sh = Activator.CreateInstance(t);
                var sc = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, sh, new object[] { lnk });
                var st = sc.GetType();
                st.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { target });
                st.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { Path.GetDirectoryName(target) });
                st.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
                st.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { "ZenTor" });
                st.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, sc, null);
            }
            catch { }
        }

        static void Register(string dir, string ver)
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
                {
                    var exe = Path.Combine(dir, "ZenTor.exe");
                    var shown = ver.Split('.').Length > 3 ? string.Join(".", ver.Split('.').Take(3)) : ver;
                    k.SetValue("DisplayName", "ZenTor");
                    k.SetValue("DisplayVersion", shown);
                    k.SetValue("Publisher", "ZenTor");
                    k.SetValue("DisplayIcon", exe + ",0");
                    k.SetValue("InstallLocation", dir);
                    k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    try { k.SetValue("EstimatedSize", (int)(Directory.GetFiles(dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length) / 1024), RegistryValueKind.DWord); } catch { }
                }
            }
            catch { }
        }

        // the files this exe leaves behind once it's done (an older ZenTor that became the installer)
        public static void DeleteLater(params string[] files)
        {
            var sb = new StringBuilder("/c ping 127.0.0.1 -n 4 >nul");
            foreach (var f in files.Where(x => !string.IsNullOrEmpty(x))) sb.Append(" & del /f /q \"" + f + "\"");
            try { Process.Start(new ProcessStartInfo("cmd.exe", sb.ToString()) { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden }); } catch { }
        }

        public static void Uninstall()
        {
            // portable (a USB with your music): nothing is deleted from here, just remove the folder by hand
            if (Program.Portable(Program.Dir) || !string.Equals(Program.Dir.TrimEnd('\\'), Program.InstallDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(Program.T("Este ZenTor es portable: para quitarlo, borra sus archivos (ZenTor.exe, zentor-core.exe…). Tu música no se toca.", "This ZenTor is portable: to remove it, delete its files (ZenTor.exe, zentor-core.exe…). Your music isn't touched.", "Aquest ZenTor és portable: per treure'l, esborra'n els arxius (ZenTor.exe, zentor-core.exe…). La teva música no es toca."), "ZenTor");
                return;
            }
            if (MessageBox.Show(Program.T("¿Desinstalar ZenTor? Tu música no se toca.", "Uninstall ZenTor? Your music isn't touched.", "Desinstal·lar ZenTor? La teva música no es toca."), "ZenTor", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            var data = MessageBox.Show(Program.T("¿Borrar también tus playlists, ajustes y lo demás de ZenTor? (Si dices que no, se quedan por si lo vuelves a instalar.)",
                "Also delete your playlists, settings and the rest of ZenTor's data? (If not, they stay in case you install it again.)",
                "Esborrar també les teves llistes, configuració i la resta de ZenTor? (Si dius que no, es queden per si el tornes a instal·lar.)"), "ZenTor", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;
            Program.AskQuit();
            Thread.Sleep(800);
            foreach (var p in Process.GetProcessesByName("zentor-core")) try { p.Kill(); } catch { }
            foreach (var p in Process.GetProcessesByName("ZenTor")) if (p.Id != Process.GetCurrentProcess().Id) try { p.Kill(); } catch { }
            foreach (var l in new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "ZenTor.lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "ZenTor.lnk") })
                try { File.Delete(l); } catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
            var dirs = new System.Collections.Generic.List<string> { Program.Dir };
            if (data) { dirs.Add(Program.RoamingData); dirs.Add(Path.Combine(Program.LocalApp, "ZenTor")); }
            var cmd = "/c ping 127.0.0.1 -n 3 >nul" + string.Concat(dirs.Select(d => " & rmdir /s /q \"" + d.TrimEnd('\\') + "\""));
            try { Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false }); } catch { }
        }
    }
}
