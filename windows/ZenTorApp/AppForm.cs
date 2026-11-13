// The app's window: ZenTor's interface in WebView2.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ZenTorApp
{
    static class AppRunner
    {
        public static void Run()
        {
            bool mine;
            Program.AppLock = new Mutex(true, @"Local\ZenTorApp", out mine);
            if (!mine)
            {
                // already open: to the front
                foreach (var p in Process.GetProcessesByName("ZenTor"))
                {
                    if (p.Id == Process.GetCurrentProcess().Id || p.MainWindowHandle == IntPtr.Zero) continue;
                    if (Program.IsIconic(p.MainWindowHandle)) Program.ShowWindow(p.MainWindowHandle, 9);
                    Program.SetForegroundWindow(p.MainWindowHandle);
                }
                return;
            }
            // no WebView2 on this PC (very rare: it comes with Windows 11 and Edge): the old way, in an Edge window
            try { CoreWebView2Environment.SetLoaderDllFolderPath(Program.Dir); } catch { }
            string wv = null;
            try { wv = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
            if (string.IsNullOrEmpty(wv))
            {
                Program.Start(Program.Core, "");
                return;
            }
            Process core = null;
            if (!Program.CoreAnswers()) core = Program.Start(Program.Core, Program.CoreArgs);
            Application.Run(new AppForm(core));
            GC.KeepAlive(Program.AppLock);
        }
    }

    class AppForm : Form
    {
        readonly WebView2 web;
        Process core;
        readonly string udf;
        readonly string boundsFile;
        bool closing;
        int restarts;

        public AppForm(Process core)
        {
            this.core = core;
            udf = Program.PortableRoot != null ? Path.Combine(Program.PortableRoot, ".zentor", "webview") : Path.Combine(Program.LocalApp, "ZenTor", "webview");
            Directory.CreateDirectory(udf);
            boundsFile = Path.Combine(udf, "window.txt");
            Text = "ZenTor";
            try { Icon = Icon.ExtractAssociatedIcon(Program.ExePath); } catch { }
            BackColor = Color.FromArgb(14, 11, 18);
            MinimumSize = new Size(360, 560);
            StartPosition = FormStartPosition.Manual;
            Size = new Size(1280, 800);
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Left + Math.Max(0, (wa.Width - Width) / 2), wa.Top + Math.Max(0, (wa.Height - Height) / 2));
            LoadBounds();
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            Load += async (s, e) => await Init();
            if (core != null) WatchCore();
        }

        async Task Init()
        {
            try
            {
                var opts = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required --disable-features=Translate");
                var env = await CoreWebView2Environment.CreateAsync(null, udf, opts);
                await web.EnsureCoreWebView2Async(env);
                var w = web.CoreWebView2;
                w.Settings.AreDevToolsEnabled = false;
                w.Settings.IsStatusBarEnabled = false;
                w.Settings.IsZoomControlEnabled = false;
                w.Settings.AreDefaultContextMenusEnabled = false;
                w.Settings.IsPasswordAutosaveEnabled = false;
                w.Settings.IsGeneralAutofillEnabled = false;
                // links out of ZenTor: in the normal browser
                w.NewWindowRequested += (s, a) => { a.Handled = true; OpenOutside(a.Uri); };
                w.NavigationStarting += (s, a) => { if (!a.Uri.StartsWith(Program.Url) && !a.Uri.StartsWith("http://localhost:47811")) { a.Cancel = true; OpenOutside(a.Uri); } };
                // the title bar in ZenTor's colours (the page says which)
                w.WebMessageReceived += (s, a) =>
                {
                    try
                    {
                        var m = a.TryGetWebMessageAsString();
                        if (m != null && m.StartsWith("bar:")) TitleBar(ColorTranslator.FromHtml(m.Substring(4).Trim()));
                    }
                    catch { }
                };
                w.DocumentTitleChanged += (s, a) => { var t = w.DocumentTitle; Text = string.IsNullOrWhiteSpace(t) ? "ZenTor" : t; };
                // the core needs a moment the first time
                for (int i = 0; i < 80 && !await Task.Run(() => Program.CoreAnswers()); i++) await Task.Delay(250);
                web.Source = new Uri(Program.Url);
            }
            catch (Exception e)
            {
                MessageBox.Show(this, Program.T("No se pudo abrir la ventana de ZenTor: ", "Couldn't open ZenTor's window: ", "No s'ha pogut obrir la finestra de ZenTor: ") + e.Message, "ZenTor", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Program.Start(Program.Core, "");
                Close();
            }
        }

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            TitleBar(BackColor);
        }

        // dark (or light) title bar, and on Windows 11 exactly ZenTor's colour
        void TitleBar(Color c)
        {
            try
            {
                bool light = (c.R * 299 + c.G * 587 + c.B * 114) / 1000 > 150;
                int dark = light ? 0 : 1;
                DwmSetWindowAttribute(Handle, 20, ref dark, 4);   // immersive dark mode (Windows 10 2004+ / 11)
                DwmSetWindowAttribute(Handle, 19, ref dark, 4);   // (older Windows 10 builds)
                int caption = c.R | (c.G << 8) | (c.B << 16);
                DwmSetWindowAttribute(Handle, 35, ref caption, 4); // caption colour (Windows 11)
                int text = light ? 0x000000 : 0xFFFFFF;
                DwmSetWindowAttribute(Handle, 36, ref text, 4);    // caption text colour (Windows 11)
                BackColor = c;
                if (web != null) web.DefaultBackgroundColor = c;
            }
            catch { }
        }

        static void OpenOutside(string uri)
        {
            if (uri != null && (uri.StartsWith("http://") || uri.StartsWith("https://")))
                try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
        }

        // the core gone: an update (this window closes, the new one opens) or a
        // crash (started again, a couple of times)
        void WatchCore()
        {
            core.EnableRaisingEvents = true;
            core.Exited += (s, e) =>
            {
                if (closing) return;
                BeginInvoke((Action)(() =>
                {
                    if (closing) return;
                    if (Directory.Exists(Path.Combine(Program.Dir, "update", "files")) || restarts >= 2) { Close(); return; }
                    restarts++;
                    core = Program.Start(Program.Core, Program.CoreArgs);
                    WatchCore();
                    Task.Delay(1500).ContinueWith(_ => BeginInvoke((Action)(() => { try { web.Reload(); } catch { } })));
                }));
            };
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            closing = true;
            SaveBounds();
            base.OnFormClosing(e);
            // the core goes by itself when the page stops answering; just in case
            var c = core;
            if (c != null) Task.Run(() => { try { if (!c.WaitForExit(6000)) c.Kill(); } catch { } });
        }

        void LoadBounds()
        {
            try
            {
                var p = File.ReadAllText(boundsFile).Split(' ').Select(int.Parse).ToArray();
                var r = new Rectangle(p[0], p[1], p[2], p[3]);
                if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r)) && r.Width >= 360 && r.Height >= 400) { Location = r.Location; Size = r.Size; }
                if (p.Length > 4 && p[4] == 1) WindowState = FormWindowState.Maximized;
            }
            catch { }
        }

        void SaveBounds()
        {
            try
            {
                var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(boundsFile, $"{r.X} {r.Y} {r.Width} {r.Height} {(WindowState == FormWindowState.Maximized ? 1 : 0)}");
            }
            catch { }
        }
    }
}
