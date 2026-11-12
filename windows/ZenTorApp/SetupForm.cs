// The installer's window: installed in this PC or portable, and go.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace ZenTorApp
{
    class SetupForm : Form
    {
        static readonly Color Ink = Color.FromArgb(18, 14, 22), Card = Color.FromArgb(32, 26, 38), Paper = Color.FromArgb(240, 232, 244), Dim = Color.FromArgb(168, 156, 176), Acid = Color.FromArgb(255, 111, 216);
        readonly RadioButton rInstall, rPortable;
        readonly TextBox folder;
        readonly Button pick, go;
        readonly CheckBox desk;
        readonly ProgressBar bar;
        readonly Label status;

        public SetupForm()
        {
            Text = Program.T("Instalar ZenTor", "Install ZenTor", "Instal·lar ZenTor");
            try { Icon = Icon.ExtractAssociatedIcon(Program.ExePath); } catch { }
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Ink; ForeColor = Paper;
            Font = new Font("Segoe UI", 10f);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(540, 520);

            var title = new Label { Text = "ZenTor", Font = new Font("Segoe UI Black", 26f, FontStyle.Bold), ForeColor = Acid, AutoSize = true, Location = new Point(28, 18) };
            var sub = new Label
            {
                Text = Setup.FromOld
                    ? Program.T("Ahora ZenTor es una app de verdad. Elige cómo la quieres: todo lo de tu ZenTor de antes (playlists, ajustes, portadas, el DJ…) pasa a la nueva.",
                                "ZenTor is now a real app. Choose how you want it: everything from your old ZenTor (playlists, settings, covers, the DJ…) moves to the new one.",
                                "Ara ZenTor és una app de debò. Tria com la vols: tot el del teu ZenTor d'abans (llistes, configuració, portades, el DJ…) passa a la nova.")
                    : Program.T("Tu música, con estilo. Elige cómo lo quieres:", "Your music, with style. Choose how you want it:", "La teva música, amb estil. Tria com el vols:"),
                ForeColor = Dim, Location = new Point(30, 78), Size = new Size(480, 64)
            };

            rInstall = Radio(Program.T("Instalar en este PC", "Install on this PC", "Instal·lar en aquest PC"), 150);
            var dInstall = Desc(Program.T("Sale en el menú Inicio y en «Aplicaciones instaladas», y se actualiza sola. Tu música: la carpeta Música de Windows.",
                "Shows in the Start menu and in «Installed apps», and updates by itself. Your music: Windows' Music folder.",
                "Surt al menú Inici i a «Aplicacions instal·lades», i s'actualitza sola. La teva música: la carpeta Música de Windows."), 178);
            rPortable = Radio(Program.T("Portable (en un USB o una carpeta)", "Portable (on a USB stick or a folder)", "Portable (en un USB o una carpeta)"), 238);
            var dPortable = Desc(Program.T("Todo va en esa carpeta: la app, tu música y tus ajustes. Llévatela a cualquier PC.",
                "Everything goes in that folder: the app, your music and your settings. Take it to any PC.",
                "Tot va en aquesta carpeta: l'app, la teva música i la teva configuració. Emporta-te-la a qualsevol PC."), 266);
            folder = new TextBox { Location = new Point(52, 304), Size = new Size(346, 28), BackColor = Card, ForeColor = Paper, BorderStyle = BorderStyle.FixedSingle };
            pick = Btn(Program.T("Elegir…", "Choose…", "Triar…"), new Point(406, 302), new Size(100, 30), false);
            pick.Click += (s, e) =>
            {
                using (var d = new FolderBrowserDialog { Description = Program.T("¿Dónde va ZenTor portable?", "Where does portable ZenTor go?", "On va ZenTor portable?"), SelectedPath = folder.Text })
                    if (d.ShowDialog(this) == DialogResult.OK) { folder.Text = d.SelectedPath; rPortable.Checked = true; }
            };
            desk = new CheckBox { Text = Program.T("Acceso directo en el escritorio", "Desktop shortcut", "Accés directe a l'escriptori"), Checked = true, AutoSize = true, Location = new Point(30, 352), ForeColor = Paper };

            bar = new ProgressBar { Location = new Point(30, 400), Size = new Size(480, 10), Visible = false };
            status = new Label { Location = new Point(30, 416), Size = new Size(480, 40), ForeColor = Dim };
            go = Btn(Program.T("Instalar", "Install", "Instal·lar"), new Point(330, 462), new Size(180, 40), true);
            go.Click += async (s, e) => await Run();

            // an older portable ZenTor: portable, right there, by default
            bool oldPortable = Setup.FromOld && Setup.OldPortable;
            folder.Text = oldPortable ? Program.Dir : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "ZenTor");
            (oldPortable ? rPortable : rInstall).Checked = true;
            rInstall.CheckedChanged += (s, e) => UpdateUi();
            UpdateUi();

            Controls.AddRange(new Control[] { title, sub, rInstall, dInstall, rPortable, dPortable, folder, pick, desk, bar, status, go });
            AcceptButton = go;
        }

        void UpdateUi() { folder.Enabled = pick.Enabled = rPortable.Checked; }

        RadioButton Radio(string text, int y) => new RadioButton { Text = text, Font = new Font("Segoe UI Semibold", 12f, FontStyle.Bold), ForeColor = Paper, AutoSize = true, Location = new Point(28, y) };
        Label Desc(string text, int y) => new Label { Text = text, ForeColor = Dim, Location = new Point(52, y), Size = new Size(460, 40) };
        Button Btn(string text, Point at, Size size, bool main)
        {
            var b = new Button { Text = text, Location = at, Size = size, FlatStyle = FlatStyle.Flat, BackColor = main ? Acid : Card, ForeColor = main ? Ink : Paper, Font = new Font("Segoe UI Semibold", main ? 11f : 9.5f, FontStyle.Bold), Cursor = Cursors.Hand };
            b.FlatAppearance.BorderColor = main ? Acid : Color.FromArgb(70, 60, 80);
            return b;
        }

        async System.Threading.Tasks.Task Run()
        {
            bool portable = rPortable.Checked;
            string target = portable ? folder.Text.Trim() : Program.InstallDir;
            if (portable && string.IsNullOrEmpty(target)) { status.Text = Program.T("Elige una carpeta", "Choose a folder", "Tria una carpeta"); return; }
            foreach (Control c in Controls) if (c is RadioButton || c is CheckBox || c is TextBox || c is Button) c.Enabled = false;
            bar.Visible = true;
            var report = new Progress<(int pct, string msg)>(p => { bar.Value = Math.Max(0, Math.Min(100, p.pct)); status.Text = p.msg; });
            try
            {
                await Setup.Install(target, portable, desk.Checked, report);
                // open the new one; this installer (an old ZenTor that became it) goes away
                Process.Start(new ProcessStartInfo(Path.Combine(target, "ZenTor.exe")) { UseShellExecute = false, WorkingDirectory = target });
                var me = Program.ExePath;
                bool inside = me.StartsWith(Path.GetFullPath(target).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
                if (Setup.FromOld)
                    Setup.DeleteLater(inside ? null : me, Path.Combine(Program.Dir, "ZenTor.old.exe"), Path.Combine(Program.Dir, "ZenTor.setup-old.exe"));
                Close();
            }
            catch (Exception ex)
            {
                status.Text = Program.T("No se pudo instalar: ", "Couldn't install: ", "No s'ha pogut instal·lar: ") + ex.Message;
                foreach (Control c in Controls) c.Enabled = true;
                UpdateUi();
                go.Text = Program.T("Reintentar", "Try again", "Reintentar");
            }
        }
    }
}
