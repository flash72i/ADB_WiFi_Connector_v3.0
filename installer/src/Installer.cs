using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AdbWifiSetup
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try { Native.SetProcessDPIAware(); } catch { }

            if (args.Length >= 2 && args[0] == "/extract")
            {
                try
                {
                    Payload.ExtractAll(args[1]);
                    Environment.Exit(0);
                }
                catch (Exception ex)
                {
                    try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "adbwifi-extract-error.txt"), ex.ToString()); } catch { }
                    Environment.Exit(1);
                }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Length >= 2 && args[0] == "/preview")
            {
                Preview.Run(args[1]);
                return;
            }

            Application.Run(new SetupForm());
        }
    }

    static class Native
    {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        public const int WM_NCLBUTTONDOWN = 0xA1;
        public const int HTCAPTION = 0x2;
    }

    static class Payload
    {
        const string MAGIC = "ADBWIFISETUP0001";

        public static string ZipFromExe(string exePath)
        {
            using (FileStream fs = File.OpenRead(exePath))
            {
                long len = fs.Length;
                if (len < 24) throw new InvalidDataException("Файл установщика повреждён.");
                fs.Seek(-24, SeekOrigin.End);
                byte[] tail = new byte[24];
                int read = fs.Read(tail, 0, 24);
                if (read != 24) throw new InvalidDataException("Файл установщика повреждён.");
                string magic = System.Text.Encoding.ASCII.GetString(tail, 0, 16);
                if (magic != MAGIC) throw new InvalidDataException("Данные установщика не найдены.");
                long payloadLen = BitConverter.ToInt64(tail, 16);
                long start = len - 24 - payloadLen;
                if (start < 0 || payloadLen <= 0) throw new InvalidDataException("Данные установщика повреждены.");

                string temp = Path.Combine(Path.GetTempPath(), "adbwifi-" + Guid.NewGuid().ToString("N") + ".zip");
                fs.Seek(start, SeekOrigin.Begin);
                using (FileStream outp = File.Create(temp))
                {
                    byte[] buf = new byte[131072];
                    long left = payloadLen;
                    while (left > 0)
                    {
                        int want = (int)Math.Min(buf.Length, left);
                        int n = fs.Read(buf, 0, want);
                        if (n <= 0) break;
                        outp.Write(buf, 0, n);
                        left -= n;
                    }
                }
                return temp;
            }
        }

        public static void ExtractAll(string target)
        {
            string zip = ZipFromExe(Application.ExecutablePath);
            try
            {
                Directory.CreateDirectory(target);
                using (ZipArchive a = ZipFile.OpenRead(zip))
                {
                    foreach (ZipArchiveEntry e in a.Entries)
                    {
                        string name = e.FullName.Replace('/', '\\');
                        string dest = Path.GetFullPath(Path.Combine(target, name));
                        string root = Path.GetFullPath(target).TrimEnd('\\') + "\\";
                        if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                        if (name.EndsWith("\\")) { Directory.CreateDirectory(dest); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        e.ExtractToFile(dest, true);
                    }
                }
            }
            finally
            {
                try { File.Delete(zip); } catch { }
            }
        }
    }

    static class InstallOps
    {
        public const string APP_NAME = "ADB Wi-Fi Connector";
        public const string EXE_NAME = "ADB-WiFi-Connector-RU.exe";
        public const string UNINST_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ADBWiFiConnector";
        public const string RUN_VALUE = "ADB Wi-Fi Connector";

        public static void CreateShortcuts(string target, bool desktop, bool menu)
        {
            try
            {
                string exe = Path.Combine(target, EXE_NAME);
                if (desktop)
                    MakeLnk(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), APP_NAME + ".lnk"), exe, target);
                if (menu)
                    MakeLnk(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), APP_NAME + ".lnk"), exe, target);
            }
            catch { }
        }

        static void MakeLnk(string lnkPath, string targetExe, string workDir)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
                object shell = Activator.CreateInstance(t);
                object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type sct = sc.GetType();
                sct.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { targetExe });
                sct.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
                sct.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { targetExe });
                sct.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { APP_NAME });
                sct.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            }
            catch { }
        }

        public static void Register(string target, bool autostart)
        {
            string exe = Path.Combine(target, EXE_NAME);
            string unins = Path.Combine(target, "Uninstall.exe");
            try
            {
                using (RegistryKey k = Registry.LocalMachine.CreateSubKey(UNINST_KEY))
                {
                    k.SetValue("DisplayName", APP_NAME);
                    k.SetValue("DisplayVersion", "3.0");
                    k.SetValue("Publisher", "ADB Toolchain Devs");
                    k.SetValue("InstallLocation", target);
                    k.SetValue("DisplayIcon", exe);
                    k.SetValue("UninstallString", "\"" + unins + "\"");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    try
                    {
                        long size = 0;
                        foreach (string f in Directory.GetFiles(target, "*", SearchOption.AllDirectories)) size += new FileInfo(f).Length;
                        k.SetValue("EstimatedSize", (int)(size / 1024), RegistryValueKind.DWord);
                    }
                    catch { }
                }
            }
            catch { }

            GrantUsersModify(target);

            try
            {
                if (autostart)
                {
                    using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                        if (k != null) k.SetValue(RUN_VALUE, "\"" + exe + "\"");
                }
            }
            catch { }
        }

        static void GrantUsersModify(string dir)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("icacls.exe", "\"" + dir + "\" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WorkingDirectory = Path.GetTempPath();
                Process p = Process.Start(psi);
                if (p != null) p.WaitForExit(120000);
            }
            catch { }
        }
    }

    class SetupForm : Form
    {
        const float W = 1080f;
        const float H = 690f;
        const float TITLE_H = 40f;
        const float RAIL_W = 322f;
        const float BOTTOM_Y = 628f;

        const string APP_NAME = "ADB Wi-Fi Connector";
        const string EXE_NAME = "ADB-WiFi-Connector-RU.exe";

        static readonly Color C_TXT = Color.FromArgb(233, 239, 247);
        static readonly Color C_TXT2 = Color.FromArgb(147, 163, 181);
        static readonly Color C_TXT3 = Color.FromArgb(100, 117, 133);
        static readonly Color C_CYAN = Color.FromArgb(34, 211, 238);
        static readonly Color C_BLUE = Color.FromArgb(59, 130, 246);
        static readonly Color C_GREEN = Color.FromArgb(61, 220, 132);
        static readonly Color C_LINE = Color.FromArgb(24, 34, 45);
        static readonly Color C_LINE2 = Color.FromArgb(34, 49, 65);

        readonly float scale;
        readonly Bitmap appIcon;

        Font fBrand, fBrandSub, fTitle, fVersion, fH1, fSub, fCardTitle, fDesc, fFeat, fBtn, fBadge;
        Font fChip, fTerm, fRailFoot, fSmall, fStatus, fH2, fP, fPath, fDoneH, fDoneP, fLink;

        int step;
        bool portable;
        string installPath, portablePath;
        bool cbDesktop = true, cbMenu = true, cbAuto = false, cbLaunch = true;

        volatile int progressInt;
        volatile int stageInt;
        volatile bool running;
        volatile bool cancelFlag;

        float animPhase;
        int caretPhase;

        string hover;
        internal bool DontCenter;

        List<Spot> spots = new List<Spot>();
        List<Spot> overlaySpots = new List<Spot>();

        bool overlayLic;
        bool overlayMode;
        string donePath;

        TextBox tbInstall, tbPortable;
        System.Windows.Forms.Timer animTimer;

        class Spot
        {
            public string Id;
            public RectangleF Rect;
        }

        public SetupForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Text = APP_NAME + " — установка";
            DoubleBuffered = true;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Color.FromArgb(7, 12, 17);
            ShowInTaskbar = true;
            KeyPreview = true;

            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
            if (scale < 1f) scale = 1f;
            ClientSize = new Size((int)Math.Round(W * scale), (int)Math.Round(H * scale));

            installPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), APP_NAME);
            portablePath = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), APP_NAME);

            appIcon = LoadIcon();
            MakeFonts();

            tbInstall = MakePathBox();
            tbPortable = MakePathBox();
            tbInstall.Text = installPath;
            tbPortable.Text = portablePath;
            tbInstall.TextChanged += delegate { installPath = tbInstall.Text; };
            tbPortable.TextChanged += delegate { portablePath = tbPortable.Text; };

            animTimer = new System.Windows.Forms.Timer();
            animTimer.Interval = 50;
            animTimer.Tick += delegate
            {
                animPhase += 0.10f;
                caretPhase = (int)((Environment.TickCount / 550) % 2);
                if (running) Invalidate();
                else Invalidate(new Rectangle(0, ScaleI(TITLE_H), ScaleI(RAIL_W), ScaleI(BOTTOM_Y - TITLE_H)));
            };
            animTimer.Start();

            UpdateTextBoxes();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (DontCenter) return;
            Rectangle wa = Screen.FromHandle(Handle).WorkingArea;
            Location = new Point(wa.Left + (wa.Width - Width) / 2, wa.Top + (wa.Height - Height) / 2);
        }

        Bitmap LoadIcon()
        {
            try
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("ADBWiFiSetup.icon.ico"))
                {
                    if (s == null) return null;
                    byte[] data = new byte[s.Length];
                    int off = 0;
                    while (off < data.Length)
                    {
                        int n = s.Read(data, off, data.Length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                    int count = BitConverter.ToUInt16(data, 4);
                    int bestPos = -1, bestSize = 0, bestArea = -1;
                    for (int i = 0; i < count; i++)
                    {
                        int e = 6 + i * 16;
                        int w = data[e]; if (w == 0) w = 256;
                        int h = data[e + 1]; if (h == 0) h = 256;
                        int size = (int)BitConverter.ToUInt32(data, e + 8);
                        int pos = (int)BitConverter.ToUInt32(data, e + 12);
                        if (pos + size > data.Length || size < 8) continue;
                        if (data[pos] != 0x89 || data[pos + 1] != 0x50) continue;
                        if (w * h > bestArea) { bestArea = w * h; bestPos = pos; bestSize = size; }
                    }
                    if (bestPos < 0) return null;
                    using (MemoryStream ms = new MemoryStream(data, bestPos, bestSize))
                    using (Bitmap tmp = new Bitmap(ms))
                        return new Bitmap(tmp);
                }
            }
            catch { return null; }
        }

        static Font F(string family, float px, FontStyle st)
        {
            return new Font(family, px, st, GraphicsUnit.Pixel);
        }

        void MakeFonts()
        {
            fBrand = F("Segoe UI", 14.5f, FontStyle.Bold);
            fBrandSub = F("Segoe UI", 11f, FontStyle.Regular);
            fTitle = F("Segoe UI", 12f, FontStyle.Bold);
            fVersion = F("Segoe UI", 11.5f, FontStyle.Regular);
            fH1 = F("Segoe UI", 18f, FontStyle.Bold);
            fSub = F("Segoe UI", 12f, FontStyle.Regular);
            fCardTitle = F("Segoe UI", 15f, FontStyle.Bold);
            fDesc = F("Segoe UI", 11.8f, FontStyle.Regular);
            fFeat = F("Segoe UI", 11.5f, FontStyle.Regular);
            fBtn = F("Segoe UI", 13f, FontStyle.Bold);
            fBadge = F("Segoe UI", 10.5f, FontStyle.Regular);
            fChip = F("Segoe UI", 10f, FontStyle.Regular);
            fTerm = F("Consolas", 10.5f, FontStyle.Regular);
            fRailFoot = F("Segoe UI", 10f, FontStyle.Regular);
            fSmall = F("Segoe UI", 11f, FontStyle.Regular);
            fStatus = F("Segoe UI", 10.5f, FontStyle.Regular);
            fH2 = F("Segoe UI", 16f, FontStyle.Bold);
            fP = F("Segoe UI", 11.5f, FontStyle.Regular);
            fPath = F("Consolas", 12f, FontStyle.Regular);
            fDoneH = F("Segoe UI", 18.5f, FontStyle.Bold);
            fDoneP = F("Segoe UI", 12.2f, FontStyle.Regular);
            fLink = F("Segoe UI", 11.5f, FontStyle.Regular);
        }

        TextBox MakePathBox()
        {
            TextBox t = new TextBox();
            t.BorderStyle = BorderStyle.None;
            t.BackColor = Color.FromArgb(10, 18, 25);
            t.ForeColor = Color.FromArgb(200, 215, 230);
            t.Font = F("Consolas", 12f * scale, FontStyle.Regular);
            t.Visible = false;
            Controls.Add(t);
            return t;
        }

        int ScaleI(float v) { return (int)Math.Round(v * scale); }

        void SetStep(int s)
        {
            step = s;
            UpdateTextBoxes();
            Invalidate();
        }

        void UpdateTextBoxes()
        {
            bool showInstall = (step == 1) && !overlayLic;
            bool showPortable = (step == 4) && !overlayLic;
            tbInstall.Visible = showInstall;
            tbPortable.Visible = showPortable;
            if (showInstall) tbInstall.Bounds = new Rectangle(ScaleI(445), ScaleI(291), ScaleI(432), ScaleI(22));
            if (showPortable) tbPortable.Bounds = new Rectangle(ScaleI(445), ScaleI(291), ScaleI(432), ScaleI(22));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            try { g.TextRenderingHint = scale > 1.01f ? TextRenderingHint.AntiAliasGridFit : TextRenderingHint.ClearTypeGridFit; }
            catch { }

            spots.Clear();
            GraphicsState st = g.Save();
            g.ScaleTransform(scale, scale);

            DrawBackground(g);
            DrawTitleBar(g);
            DrawRail(g);
            DrawMain(g);
            DrawBottomBar(g);
            DrawOverlay(g);

            g.Restore(st);
            base.OnPaint(e);
        }

        void DrawBackground(Graphics g)
        {
            using (LinearGradientBrush b = new LinearGradientBrush(new RectangleF(0, 0, W, H), Color.FromArgb(11, 18, 25), Color.FromArgb(7, 12, 17), 65f))
                g.FillRectangle(b, 0, 0, W, H);
            using (LinearGradientBrush b = new LinearGradientBrush(new RectangleF(0, 0, W, 200), Color.FromArgb(16, 30, 40), Color.FromArgb(0, 16, 30, 40), LinearGradientMode.Vertical))
                g.FillRectangle(b, 0, 0, W, 200);
        }

        void DrawTitleBar(Graphics g)
        {
            using (LinearGradientBrush b = new LinearGradientBrush(new RectangleF(0, 0, W, TITLE_H), Color.FromArgb(13, 21, 29), Color.FromArgb(10, 16, 23), LinearGradientMode.Vertical))
                g.FillRectangle(b, 0, 0, W, TITLE_H);
            using (Pen p = new Pen(C_LINE)) g.DrawLine(p, 0, TITLE_H - 0.5f, W, TITLE_H - 0.5f);

            if (appIcon != null) g.DrawImage(appIcon, new RectangleF(12, 12, 16, 16));

            Txt(g, APP_NAME, 34, 9, 260, 22, fTitle, Color.FromArgb(198, 212, 227));
            float tw = Measure(g, APP_NAME, fTitle);
            Txt(g, "v3.0-setup", 34 + tw + 8, 9.5f, 140, 22, fVersion, Color.FromArgb(88, 104, 121));

            string[] ids = { "min", "max", "close" };
            for (int i = 0; i < 3; i++)
            {
                RectangleF r = new RectangleF(966 + i * 36, 7, 34, 26);
                bool hov = hover == ids[i];
                if (hov)
                {
                    using (SolidBrush b = new SolidBrush(ids[i] == "close" ? Color.FromArgb(224, 56, 74) : Color.FromArgb(30, 38, 48)))
                        FillRound(g, r, 4, b);
                }
                Color gc = (ids[i] == "close" && hov) ? Color.White : Color.FromArgb(139, 152, 167);
                using (Pen p = new Pen(gc, 1.1f))
                {
                    if (ids[i] == "min") g.DrawLine(p, r.X + 12, r.Y + 13, r.X + 22, r.Y + 13);
                    else if (ids[i] == "max") g.DrawRectangle(p, r.X + 12, r.Y + 8, 10, 10);
                    else
                    {
                        g.DrawLine(p, r.X + 12.5f, r.Y + 8.5f, r.X + 21.5f, r.Y + 17.5f);
                        g.DrawLine(p, r.X + 21.5f, r.Y + 8.5f, r.X + 12.5f, r.Y + 17.5f);
                    }
                }
                Hot(ids[i], r);
            }
        }

        void DrawRail(Graphics g)
        {
            RectangleF rail = new RectangleF(0, TITLE_H, RAIL_W, BOTTOM_Y - TITLE_H);
            using (LinearGradientBrush b = new LinearGradientBrush(rail, Color.FromArgb(10, 18, 26), Color.FromArgb(8, 13, 19), LinearGradientMode.Vertical))
                g.FillRectangle(b, rail);

            using (SolidBrush b = new SolidBrush(Color.FromArgb(7, 255, 255, 255)))
            {
                for (float x = 0; x < RAIL_W; x += 26) g.FillRectangle(b, x, TITLE_H, 1, rail.Height);
                for (float y = TITLE_H; y < BOTTOM_Y; y += 26) g.FillRectangle(b, 0, y, RAIL_W, 1);
            }

            using (Pen p = new Pen(C_LINE)) g.DrawLine(p, RAIL_W - 0.5f, TITLE_H, RAIL_W - 0.5f, BOTTOM_Y);

            if (appIcon != null)
            {
                g.DrawImage(appIcon, new RectangleF(20, 60, 50, 50));
                using (Pen p = new Pen(Color.FromArgb(60, 34, 211, 238), 1))
                    DrawRound(g, new RectangleF(20, 60, 50, 50), 12, p);
            }

            Txt(g, APP_NAME, 82, 62, 226, 22, fBrand, C_TXT);
            Txt(g, "Android с ПК по Wi-Fi", 82, 85, 226, 18, fBrandSub, Color.FromArgb(108, 127, 144));

            DrawArt(g, new RectangleF(10, 118, 302, 265));

            RectangleF term = new RectangleF(20, 392, 282, 64);
            using (LinearGradientBrush b = new LinearGradientBrush(term, Color.FromArgb(6, 13, 19), Color.FromArgb(6, 12, 18), LinearGradientMode.Vertical))
                FillRound(g, term, 8, b);
            using (Pen p = new Pen(Color.FromArgb(26, 39, 51))) DrawRound(g, term, 8, p);

            float ty = term.Y + 7;
            TermLine(g, "> adb connect 192.0.2.42:5555", term.X + 10, ty, true, false);
            TermLine(g, "connected · Android 16 · arm64", term.X + 10, ty + 17, false, true);
            RectangleF caret = new RectangleF(term.X + 10 + Measure(g, "> scrcpy --no-window ", fTerm), ty + 34 + 1, 6, 10);
            TermLine(g, "> scrcpy --no-window", term.X + 10, ty + 34, true, false);
            if (caretPhase == 0)
                using (SolidBrush b = new SolidBrush(C_CYAN)) g.FillRectangle(b, caret);

            float cx = 20;
            cx = Chip(g, cx, 466, "Wi-Fi ADB");
            cx = Chip(g, cx, 466, "scrcpy 5.0.1");
            Chip(g, cx, 466, "без root");

            using (SolidBrush b = new SolidBrush(C_GREEN)) g.FillEllipse(b, 20, 596, 5, 5);
            Txt(g, "Работает с любым Android 7+", 32, 591, 270, 16, fRailFoot, Color.FromArgb(70, 85, 99));
        }

        void TermLine(Graphics g, string s, float x, float y, bool prompt, bool ok)
        {
            if (prompt)
            {
                float pw = Measure(g, ">", fTerm);
                Txt(g, ">", x, y, pw + 2, 14, fTerm, C_CYAN);
                Txt(g, s.Substring(1).TrimStart(), x + pw + 4, y, 250, 14, fTerm, Color.FromArgb(95, 118, 136));
            }
            else Txt(g, s, x, y, 260, 14, fTerm, ok ? Color.FromArgb(74, 222, 128) : Color.FromArgb(95, 118, 136));
        }

        float Chip(Graphics g, float x, float y, string text)
        {
            float w = Measure(g, text, fChip) + 12;
            RectangleF r = new RectangleF(x, y, w, 20);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(6, 255, 255, 255))) FillRound(g, r, 4, b);
            using (Pen p = new Pen(Color.FromArgb(30, 42, 54))) DrawRound(g, r, 4, p);
            Txt(g, text, r.X, r.Y + 2, r.Width, 16, fChip, Color.FromArgb(127, 147, 166), StringAlignment.Center, StringAlignment.Near);
            return x + w + 6;
        }

        void DrawArt(Graphics g, RectangleF area)
        {
            GraphicsState st = g.Save();
            g.TranslateTransform(area.X, area.Y);
            g.ScaleTransform(area.Width / 280f, area.Height / 246f);

            using (GraphicsPath glow = new GraphicsPath())
            {
                glow.AddEllipse(58, 12, 172, 200);
                using (PathGradientBrush pg = new PathGradientBrush(glow))
                {
                    pg.CenterColor = Color.FromArgb(26, 34, 211, 238);
                    pg.SurroundColors = new Color[] { Color.FromArgb(0, 34, 211, 238) };
                    g.FillPath(pg, glow);
                }
            }

            using (Pen p = new Pen(Color.FromArgb(22, 35, 46), 1))
            {
                g.DrawLine(p, 14, 34, 22, 34); g.DrawLine(p, 18, 30, 18, 38);
                g.DrawLine(p, 258, 206, 266, 206); g.DrawLine(p, 262, 202, 262, 210);
            }

            RectangleF lapScreen = new RectangleF(26, 146, 72, 46);
            using (LinearGradientBrush b = new LinearGradientBrush(lapScreen, Color.FromArgb(15, 28, 37), Color.FromArgb(8, 17, 26), LinearGradientMode.Vertical))
            using (GraphicsPath path = Round(lapScreen, 4))
                g.FillPath(b, path);
            using (Pen p = new Pen(Color.FromArgb(43, 69, 87))) DrawRound(g, lapScreen, 4, p);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(6, 16, 25))) g.FillRectangle(b, 31, 151, 62, 36);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(191, 34, 211, 238))) g.FillRectangle(b, 36, 158, 24, 2.5f);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(140, 61, 220, 132))) g.FillRectangle(b, 36, 164, 43, 2);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(153, 100, 116, 139))) g.FillRectangle(b, 36, 169, 30, 2);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(82, 34, 211, 238))) g.FillRectangle(b, 36, 174, 47, 2);

            PointF[] basePts = new PointF[] { new PointF(16, 198), new PointF(108, 198), new PointF(102, 207), new PointF(22, 207) };
            using (SolidBrush b = new SolidBrush(Color.FromArgb(12, 22, 32))) g.FillPolygon(b, basePts);
            using (Pen p = new Pen(Color.FromArgb(43, 69, 87))) g.DrawPolygon(p, basePts);
            using (Pen p = new Pen(Color.FromArgb(34, 57, 74), 1.4f)) g.DrawLine(p, 50, 202, 74, 202);

            using (Pen p = new Pen(Color.FromArgb(153, 34, 211, 238), 1.4f))
            {
                p.DashPattern = new float[] { 3f, 5f };
                p.DashOffset = -animPhase * 4f;
                using (GraphicsPath lp = new GraphicsPath())
                {
                    lp.AddBezier(99, 172, 122, 172, 88, 142, 100, 124);
                    g.DrawPath(p, lp);
                }
            }

            RectangleF phone = new RectangleF(99, 24, 90, 168);
            using (LinearGradientBrush b = new LinearGradientBrush(phone, Color.FromArgb(15, 28, 37), Color.FromArgb(8, 17, 26), LinearGradientMode.Vertical))
            using (GraphicsPath path = Round(phone, 17))
                g.FillPath(b, path);
            using (Pen p = new Pen(Color.FromArgb(47, 74, 92), 1.4f)) DrawRound(g, phone, 17, p);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(8, 20, 28))) FillRound(g, new RectangleF(106, 33, 76, 150), 10, b);
            using (Pen p = new Pen(Color.FromArgb(22, 36, 47))) DrawRound(g, new RectangleF(106, 33, 76, 150), 10, p);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(27, 44, 57))) FillRound(g, new RectangleF(134, 39, 20, 3.5f), 1.75f, b);

            using (SolidBrush green = new SolidBrush(C_GREEN))
            using (SolidBrush dark = new SolidBrush(Color.FromArgb(7, 18, 26)))
            {
                using (GraphicsPath head = new GraphicsPath())
                {
                    head.AddArc(127, 76, 30, 30, 180, 180);
                    head.AddLine(157, 91, 127, 91);
                    head.CloseFigure();
                    g.FillPath(green, head);
                }
                using (Pen p = new Pen(C_GREEN, 2.1f)) { p.StartCap = LineCap.Round; p.EndCap = LineCap.Round; g.DrawLine(p, 132, 75.5f, 127.6f, 68.1f); g.DrawLine(p, 152, 75.5f, 156.4f, 68.1f); }
                g.FillEllipse(dark, 134.1f, 81.5f, 3.8f, 3.8f);
                g.FillEllipse(dark, 146.1f, 81.5f, 3.8f, 3.8f);
                FillRound(g, new RectangleF(127, 94, 30, 26), 7, green);
                FillRound(g, new RectangleF(121.5f, 95, 5, 19), 2.5f, green);
                FillRound(g, new RectangleF(157.5f, 95, 5, 19), 2.5f, green);
                FillRound(g, new RectangleF(133.5f, 120.5f, 6, 14), 3, green);
                FillRound(g, new RectangleF(144.5f, 120.5f, 6, 14), 3, green);
            }

            using (SolidBrush b = new SolidBrush(Color.FromArgb(34, 57, 74))) FillRound(g, new RectangleF(131, 174, 26, 3), 1.5f, b);

            DrawWave(g, 196, 77, 11, 11, 2.4f, 205, 130, 0.95f);
            DrawWave(g, 196, 77, 19, 19, 2.2f, 205, 130, 0.66f);
            DrawWave(g, 196, 77, 27, 27, 2.0f, 205, 130, 0.38f);
            using (SolidBrush b = new SolidBrush(C_CYAN)) g.FillEllipse(b, 193.4f, 74.4f, 5.2f, 5.2f);

            g.Restore(st);
        }

        void DrawWave(Graphics g, float cx, float cy, float rx, float ry, float width, float start, float sweep, float baseAlpha)
        {
            float alpha = baseAlpha * (0.55f + 0.45f * (float)(0.5 + 0.5 * Math.Sin(animPhase - rx * 0.08)));
            int a = (int)(255 * Math.Max(0.12f, Math.Min(1f, alpha)));
            using (Pen p = new Pen(Color.FromArgb(a, C_CYAN), width))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddArc(cx - rx, cy - ry, rx * 2, ry * 2, start, sweep);
                    g.DrawPath(p, path);
                }
            }
        }

        void DrawMain(Graphics g)
        {
            switch (step)
            {
                case 0: DrawMode(g); break;
                case 1: DrawInstallOptions(g); break;
                case 2: DrawProgress(g, false); break;
                case 3: DrawDone(g, false); break;
                case 4: DrawPortableOptions(g); break;
                case 5: DrawProgress(g, true); break;
                case 6: DrawDone(g, true); break;
            }
        }

        void DrawMode(Graphics g)
        {
            Txt(g, "Выберите режим работы", 348, 164, 500, 26, fH1, C_TXT);
            Txt(g, "Установка в систему или портативная папка — программа одна и та же", 348, 194, 650, 20, fSub, Color.FromArgb(111, 129, 148));

            RectangleF c1 = new RectangleF(348, 226, 345, 224);
            RectangleF c2 = new RectangleF(709, 226, 345, 224);

            DrawCard(g, c1, "mode-install", "Установить",
                "Ярлыки, меню «Пуск» и удаление через «Приложения»",
                new string[] { "Ярлыки на рабочем столе и в «Пуске»", "Установка для всех пользователей", "Автозапуск по желанию" },
                "Рекомендуется", true, true, "Выбрать установку  →");

            DrawCard(g, c2, "mode-portable", "Портативная версия",
                "Распаковать в папку и запускать откуда угодно",
                new string[] { "Без записей в реестр", "Работа с флешки и сетевой папки", "Готово сразу после распаковки" },
                "Без следов в ОС", false, false, "Распаковать архив");

            string[] names = { "Экран", "Файлы", "Приложения", "Буфер" };
            string[] subs = { "зеркало и управление", "в обе стороны", "APK и иконки", "история обмена" };
            int[] kinds = { 0, 1, 2, 3 };
            float sw = (706 - 36) / 4f;
            using (Pen p = new Pen(Color.FromArgb(13, 255, 255, 255))) g.DrawLine(p, 348, 462, 1054, 462);
            for (int i = 0; i < 4; i++)
            {
                float x = 348 + i * (sw + 12);
                DrawMini(g, x, 478, sw, kinds[i], names[i], subs[i]);
            }
        }

        void DrawCard(Graphics g, RectangleF r, string id, string title, string desc, string[] feats, string badge, bool recommended, bool primaryBtn, string btnText)
        {
            bool hov = hover == id || hover == id + "-btn";
            using (LinearGradientBrush b = new LinearGradientBrush(r, Color.FromArgb(10, 255, 255, 255), Color.FromArgb(3, 255, 255, 255), LinearGradientMode.Vertical))
                FillRound(g, r, 10, b);
            using (Pen p = new Pen(hov ? Color.FromArgb(47, 67, 88) : C_LINE2)) DrawRound(g, r, 10, p);

            RectangleF ib = new RectangleF(r.X + 15, r.Y + 14, 34, 34);
            if (recommended)
            {
                using (LinearGradientBrush b = new LinearGradientBrush(ib, Color.FromArgb(41, 34, 211, 238), Color.FromArgb(10, 34, 211, 238), LinearGradientMode.Vertical))
                    FillRound(g, ib, 8, b);
                using (Pen p = new Pen(Color.FromArgb(89, 34, 211, 238))) DrawRound(g, ib, 8, p);
                DrawGlyph(g, ib, 0, C_CYAN);
            }
            else
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb(10, 255, 255, 255))) FillRound(g, ib, 8, b);
                using (Pen p = new Pen(Color.FromArgb(42, 58, 77))) DrawRound(g, ib, 8, p);
                DrawGlyph(g, ib, 1, Color.FromArgb(159, 179, 200));
            }

            float bw = Measure(g, badge, fBadge) + 14;
            RectangleF br = new RectangleF(r.Right - 15 - bw, r.Y + 16, bw, 20);
            using (SolidBrush b = new SolidBrush(recommended ? Color.FromArgb(18, 34, 211, 238) : Color.FromArgb(8, 255, 255, 255))) FillRound(g, br, 4, b);
            using (Pen p = new Pen(recommended ? Color.FromArgb(77, 34, 211, 238) : Color.FromArgb(36, 48, 61))) DrawRound(g, br, 4, p);
            Txt(g, badge, br.X, br.Y + 3, br.Width, 14, fBadge, recommended ? Color.FromArgb(165, 233, 247) : Color.FromArgb(143, 163, 184), StringAlignment.Center, StringAlignment.Near);

            Txt(g, title, r.X + 15, r.Y + 57, r.Width - 30, 20, fCardTitle, C_TXT);
            TxtWrap(g, desc, r.X + 15, r.Y + 80, r.Width - 30, 34, fDesc, Color.FromArgb(143, 160, 178));

            float fy = r.Y + 116;
            for (int i = 0; i < feats.Length; i++)
            {
                DrawCheck(g, r.X + 15, fy + 2, 10, Color.FromArgb(94, 234, 212));
                Txt(g, feats[i], r.X + 32, fy, r.Width - 47, 16, fFeat, Color.FromArgb(157, 176, 193));
                fy += 17;
            }

            RectangleF btn = new RectangleF(r.X + 15, r.Bottom - 15 - 36, r.Width - 30, 36);
            Button(g, btn, btnText, primaryBtn, id + "-btn", true);
            Hot(id, r);
            Hot(id + "-btn", btn);
        }

        void DrawMini(Graphics g, float x, float y, float w, int kind, string title, string sub)
        {
            RectangleF ic = new RectangleF(x, y, 27, 27);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(12, 21, 29))) FillRound(g, ic, 7, b);
            using (Pen p = new Pen(Color.FromArgb(34, 49, 64))) DrawRound(g, ic, 7, p);
            DrawGlyph(g, ic, 2 + kind, Color.FromArgb(111, 199, 221));
            Txt(g, title, x + 35, y - 1, w - 35, 15, F("Segoe UI", 11.5f, FontStyle.Bold), Color.FromArgb(195, 210, 224));
            Txt(g, sub, x + 35, y + 14, w - 30, 14, fStatus, Color.FromArgb(95, 113, 129));
        }

        void DrawInstallOptions(Graphics g) { DrawOptions(g, false); }
        void DrawPortableOptions(Graphics g) { DrawOptions(g, true); }

        void DrawOptions(Graphics g, bool port)
        {
            RectangleF p = new RectangleF(421, 200, 560, 306);
            Panel(g, p);

            RectangleF ic = new RectangleF(p.X + 18, p.Y + 18, 26, 26);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(20, 34, 211, 238))) FillRound(g, ic, 7, b);
            using (Pen pen = new Pen(Color.FromArgb(77, 34, 211, 238))) DrawRound(g, ic, 7, pen);
            DrawGlyph(g, ic, port ? 1 : 0, C_CYAN);

            Txt(g, port ? "Куда распаковать" : "Куда установить", p.X + 52, p.Y + 18, 400, 24, fH2, C_TXT);
            Txt(g, port ? "Портативная версия не изменяет систему" : "Папка установки и дополнительные параметры", p.X + 18, p.Y + 47, 500, 18, fP, Color.FromArgb(111, 129, 148));

            Txt(g, port ? "Папка назначения" : "Папка установки", p.X + 18, p.Y + 73, 300, 16, fSmall, Color.FromArgb(125, 143, 163));

            RectangleF field = new RectangleF(p.X + 18, p.Y + 91, 440, 36);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(10, 18, 25))) FillRound(g, field, 6, b);
            bool focus = (port ? tbPortable : tbInstall).Focused;
            using (Pen pen = new Pen(focus ? Color.FromArgb(115, 34, 211, 238) : Color.FromArgb(30, 42, 55))) DrawRound(g, field, 6, pen);

            RectangleF browse = new RectangleF(p.Right - 18 - 76, p.Y + 91, 76, 36);
            Button(g, browse, "Обзор…", false, port ? "port-browse" : "install-browse", false);

            if (!port)
            {
                DrawCheckbox(g, p.X + 18, p.Y + 143, cbDesktop, "Ярлык на рабочем столе", "cb-desktop");
                DrawCheckbox(g, p.X + 282, p.Y + 143, cbMenu, "Ярлык в меню «Пуск»", "cb-menu");
                DrawCheckbox(g, p.X + 18, p.Y + 167, cbAuto, "Запускать при входе в Windows", "cb-auto");

                DrawShield(g, p.X + 18, p.Y + 197, 13, Color.FromArgb(95, 147, 173));
                Txt(g, "Установка для всех пользователей — потребуются права администратора", p.X + 38, p.Y + 195, 490, 18, fStatus, Color.FromArgb(113, 132, 154));
            }
            else
            {
                DrawInfo(g, p.X + 18, p.Y + 143, 13, Color.FromArgb(95, 147, 173));
                TxtWrap(g, "Реестр, меню «Пуск» и системные папки не затрагиваются — папку можно перенести на флешку", p.X + 38, p.Y + 141, 470, 36, fStatus, Color.FromArgb(113, 132, 154));
            }

            Button(g, new RectangleF(p.Right - 18 - 108 - 10 - 76, p.Y + 254, 76, 36), "Назад", false, "back", false);
            Button(g, new RectangleF(p.Right - 18 - 108, p.Y + 254, 108, 36), port ? "Распаковать" : "Установить", true, port ? "start-portable" : "start-install", true);
        }

        void Panel(Graphics g, RectangleF r)
        {
            using (LinearGradientBrush b = new LinearGradientBrush(r, Color.FromArgb(8, 255, 255, 255), Color.FromArgb(3, 255, 255, 255), LinearGradientMode.Vertical))
                FillRound(g, r, 10, b);
            using (Pen p = new Pen(C_LINE2)) DrawRound(g, r, 10, p);
        }

        void DrawProgress(Graphics g, bool port)
        {
            int pct = progressInt;
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;

            RectangleF p = new RectangleF(421, 190, 560, 300);
            Panel(g, p);

            RectangleF ic = new RectangleF(p.X + 18, p.Y + 18, 26, 26);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(20, 34, 211, 238))) FillRound(g, ic, 7, b);
            using (Pen pen = new Pen(Color.FromArgb(77, 34, 211, 238))) DrawRound(g, ic, 7, pen);
            DrawGlyph(g, ic, port ? 1 : 0, C_CYAN);

            Txt(g, port ? "Распаковка" : "Установка", p.X + 52, p.Y + 18, 300, 24, fH2, C_TXT);
            Txt(g, port ? "Файлы копируются в выбранную папку" : "Это займёт несколько секунд", p.X + 18, p.Y + 47, 500, 18, fP, Color.FromArgb(111, 129, 148));

            RectangleF path = new RectangleF(p.X + 18, p.Y + 74, 524, 32);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(10, 18, 25))) FillRound(g, path, 6, b);
            using (Pen pen = new Pen(Color.FromArgb(30, 42, 55))) DrawRound(g, path, 6, pen);
            Txt(g, port ? portablePath : installPath, path.X + 10, path.Y + 8, path.Width - 20, 16, fPath, Color.FromArgb(143, 163, 184));

            Txt(g, "Распаковка файлов", p.X + 18, p.Y + 116, 300, 18, fP, Color.FromArgb(143, 163, 184));
            Txt(g, pct + "%", p.Right - 70, p.Y + 116, 52, 18, fP, Color.FromArgb(195, 211, 226), StringAlignment.Far, StringAlignment.Near);

            RectangleF bar = new RectangleF(p.X + 18, p.Y + 138, 524, 8);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(13, 21, 29))) FillRound(g, bar, 4, b);
            using (Pen pen = new Pen(Color.FromArgb(28, 40, 51))) DrawRound(g, bar, 4, pen);
            if (pct > 0)
            {
                RectangleF fill = new RectangleF(bar.X, bar.Y, Math.Max(4, bar.Width * pct / 100f), bar.Height);
                using (LinearGradientBrush b = new LinearGradientBrush(new RectangleF(bar.X, bar.Y, Math.Max(bar.Width * pct / 100f, 1), bar.Height), C_CYAN, C_BLUE, LinearGradientMode.Horizontal))
                    FillRound(g, fill, 4, b);
            }

            string[] stages = port ? new string[] { "Распаковка файлов программы", "Проверка структуры", "Завершение" } : new string[] { "Распаковка файлов программы", "Создание ярлыков", "Регистрация в Windows", "Завершение" };
            int[] marks = port ? new int[] { 1, 58, 88 } : new int[] { 1, 40, 72, 90 };
            float sy = p.Y + 162;
            for (int i = 0; i < stages.Length; i++)
            {
                bool done = pct >= marks[i];
                RectangleF dot = new RectangleF(p.X + 18, sy + 2, 14, 14);
                using (SolidBrush b = new SolidBrush(done ? Color.FromArgb(38, 34, 211, 238) : Color.FromArgb(11, 19, 27))) g.FillEllipse(b, dot);
                using (Pen pen = new Pen(done ? Color.FromArgb(153, 34, 211, 238) : Color.FromArgb(42, 57, 72))) g.DrawEllipse(pen, dot);
                if (done)
                {
                    using (Pen pen = new Pen(Color.FromArgb(103, 232, 249), 1.6f))
                    {
                        pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                        g.DrawLine(pen, dot.X + 3.6f, dot.Y + 7.2f, dot.X + 6.2f, dot.Y + 9.8f);
                        g.DrawLine(pen, dot.X + 6.2f, dot.Y + 9.8f, dot.X + 10.4f, dot.Y + 4.4f);
                    }
                }
                Txt(g, stages[i], p.X + 40, sy, 420, 18, fP, done ? Color.FromArgb(195, 211, 226) : Color.FromArgb(86, 102, 118));
                sy += 18;
            }

            Button(g, new RectangleF(p.Right - 18 - 108, p.Bottom - 18 - 36, 108, 36), "Отмена", false, port ? "cancel-port" : "cancel-install", false);
        }

        void DrawDone(Graphics g, bool port)
        {
            float cx = 701;
            RectangleF tick = new RectangleF(cx - 32, 188, 64, 64);
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddEllipse(tick);
                using (PathGradientBrush pg = new PathGradientBrush(path))
                {
                    pg.CenterColor = Color.FromArgb(40, 34, 211, 238);
                    pg.SurroundColors = new Color[] { Color.FromArgb(8, 34, 211, 238) };
                    g.FillPath(pg, path);
                }
            }
            using (Pen pen = new Pen(Color.FromArgb(115, 34, 211, 238))) g.DrawEllipse(pen, tick);
            using (Pen pen = new Pen(Color.FromArgb(103, 232, 249), 1.9f))
            {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                g.DrawLine(pen, cx - 8, 220, cx - 3, 226);
                g.DrawLine(pen, cx - 3, 226, cx + 10, 211);
            }

            Txt(g, port ? "Портативная версия готова" : "Готово", cx - 260, 262, 520, 28, fDoneH, C_TXT, StringAlignment.Center, StringAlignment.Near);
            Txt(g, port ? "Можно запускать без установки" : "ADB Wi-Fi Connector установлен", cx - 260, 292, 520, 18, fDoneP, C_TXT2, StringAlignment.Center, StringAlignment.Near);

            string target = donePath;
            if (string.IsNullOrEmpty(target)) target = port ? portablePath : installPath;
            RectangleF pathBox = new RectangleF(cx - 230, 318, 460, 32);
            using (SolidBrush b = new SolidBrush(Color.FromArgb(10, 18, 25))) FillRound(g, pathBox, 6, b);
            using (Pen pen = new Pen(Color.FromArgb(30, 42, 55))) DrawRound(g, pathBox, 6, pen);
            Txt(g, target, pathBox.X + 10, pathBox.Y + 8, pathBox.Width - 20, 16, fPath, Color.FromArgb(143, 163, 184), StringAlignment.Center, StringAlignment.Near);

            float cbw = 260;
            DrawCheckbox(g, cx - cbw / 2, 362, cbLaunch, "Запустить ADB Wi-Fi Connector", "done-launch");

            Button(g, new RectangleF(cx - 128, 394, 120, 36), "Открыть папку", false, "done-folder", false);
            Button(g, new RectangleF(cx + 2, 394, 110, 36), "Завершить", true, "done-finish", false);
        }

        void Button(Graphics g, RectangleF r, string label, bool primary, string id, bool arrow)
        {
            bool hov = hover == id;
            if (primary)
            {
                using (LinearGradientBrush b = new LinearGradientBrush(r, hov ? Color.FromArgb(56, 222, 245) : C_CYAN, hov ? Color.FromArgb(80, 145, 250) : C_BLUE, LinearGradientMode.Horizontal))
                    FillRound(g, r, 6, b);
                Txt(g, label, r.X, r.Y + (r.Height - 16) / 2 - 1, r.Width, 18, fBtn, Color.FromArgb(4, 20, 28), StringAlignment.Center, StringAlignment.Near);
            }
            else
            {
                using (SolidBrush b = new SolidBrush(hov ? Color.FromArgb(23, 34, 45) : Color.FromArgb(17, 26, 35))) FillRound(g, r, 6, b);
                using (Pen p = new Pen(hov ? Color.FromArgb(44, 61, 80) : Color.FromArgb(35, 49, 65))) DrawRound(g, r, 6, p);
                Txt(g, label, r.X, r.Y + (r.Height - 16) / 2 - 1, r.Width, 18, fBtn, Color.FromArgb(207, 218, 234), StringAlignment.Center, StringAlignment.Near);
            }
            Hot(id, r);
        }

        void DrawCheckbox(Graphics g, float x, float y, bool on, string label, string id)
        {
            RectangleF box = new RectangleF(x, y + 1, 14, 14);
            using (GraphicsPath path = Round(box, 3))
            {
                if (on)
                {
                    using (LinearGradientBrush b = new LinearGradientBrush(box, C_CYAN, C_BLUE, 45f)) g.FillPath(b, path);
                }
                else
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(11, 19, 27))) g.FillPath(b, path);
                    using (Pen p = new Pen(Color.FromArgb(44, 58, 73))) g.DrawPath(p, path);
                }
            }
            if (on)
            {
                using (Pen pen = new Pen(Color.FromArgb(3, 20, 28), 2f))
                {
                    pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                    g.DrawLine(pen, box.X + 3.4f, box.Y + 7, box.X + 5.8f, box.Y + 9.6f);
                    g.DrawLine(pen, box.X + 5.8f, box.Y + 9.6f, box.X + 10.4f, box.Y + 4.2f);
                }
            }
            Txt(g, label, x + 22, y, 260, 16, fSmall, Color.FromArgb(147, 164, 182));
            Hot(id, new RectangleF(x, y - 2, 22 + Measure(g, label, fSmall) + 4, 18));
        }

        void DrawBottomBar(Graphics g)
        {
            using (SolidBrush b = new SolidBrush(Color.FromArgb(70, 0, 0, 0))) g.FillRectangle(b, 0, BOTTOM_Y, W, H - BOTTOM_Y);
            using (Pen p = new Pen(C_LINE)) g.DrawLine(p, 0, BOTTOM_Y + 0.5f, W, BOTTOM_Y + 0.5f);

            if (step == 0)
            {
                DrawCheckbox(g, 20, 639, cbDesktop, "Создать ярлык на рабочем столе", "cb-bottom");
            }
            else if (step == 1 || step == 4)
            {
                Txt(g, "Шаг 2 из 3", 20, 640, 200, 16, fLink, Color.FromArgb(125, 142, 160));
            }
            else if (step == 2 || step == 5)
            {
                Txt(g, "Файлы распаковываются — окно не закрывайте", 20, 640, 400, 16, fLink, Color.FromArgb(125, 142, 160));
            }
            else
            {
                Txt(g, "Шаг 3 из 3", 20, 640, 200, 16, fLink, Color.FromArgb(125, 142, 160));
            }

            string lic = "ⓘ Лицензионное соглашение";
            float lw = Measure(g, lic, fLink);
            Txt(g, lic, W - 20 - lw, 639, lw + 2, 18, fLink, Color.FromArgb(125, 142, 160));
            Hot("lic", new RectangleF(W - 24 - lw, 636, lw + 8, 22));

            using (Pen p = new Pen(Color.FromArgb(12, 255, 255, 255))) g.DrawLine(p, 0, 664, W, 664);

            Txt(g, "v3.0", 20, 671, 50, 15, fStatus, Color.FromArgb(107, 125, 143));
            Txt(g, "|", 58, 671, 10, 15, fStatus, Color.FromArgb(47, 60, 73));
            Txt(g, "x64 Architecture", 70, 671, 120, 15, fStatus, Color.FromArgb(75, 89, 103));
            Txt(g, "|", 186, 671, 10, 15, fStatus, Color.FromArgb(47, 60, 73));
            DrawShield(g, 200, 671, 11, Color.FromArgb(93, 125, 144));
            Txt(g, "Без рекламы", 216, 671, 100, 15, fStatus, Color.FromArgb(75, 89, 103));

            string right = "Windows 10 / 11 64-bit   •   © 2026 ADB Toolchain Devs   •   Все права защищены";
            float rw = Measure(g, right, fStatus);
            Txt(g, right, W - 20 - rw, 671, rw + 2, 15, fStatus, Color.FromArgb(75, 89, 103));
        }

        void DrawOverlay(Graphics g)
        {
            if (!overlayLic) return;

            overlayMode = true;
            overlaySpots.Clear();

            using (SolidBrush b = new SolidBrush(Color.FromArgb(168, 3, 6, 9))) g.FillRectangle(b, 0, 0, W, H);

            RectangleF d = new RectangleF((W - 430) / 2, (H - 260) / 2, 430, 260);
            using (LinearGradientBrush b = new LinearGradientBrush(d, Color.FromArgb(12, 19, 26), Color.FromArgb(10, 15, 20), LinearGradientMode.Vertical))
                FillRound(g, d, 12, b);
            using (Pen p = new Pen(Color.FromArgb(34, 48, 64))) DrawRound(g, d, 12, p);

            Txt(g, "Лицензионное соглашение", d.X + 20, d.Y + 18, d.Width - 40, 22, F("Segoe UI", 15f, FontStyle.Bold), C_TXT);
            TxtWrap(g, "Здесь будет текст лицензионного соглашения ADB Wi-Fi Connector. В этой сборке показан экран — сам текст соглашения добавим перед публикацией.", d.X + 20, d.Y + 48, d.Width - 40, 120, fP, Color.FromArgb(143, 160, 178));
            Button(g, new RectangleF(d.Right - 20 - 108, d.Bottom - 20 - 36, 108, 36), "Понятно", true, "lic-ok", false);

            overlayMode = false;
        }

        void DrawGlyph(Graphics g, RectangleF box, int kind, Color c)
        {
            float cx = box.X + box.Width / 2;
            float cy = box.Y + box.Height / 2;
            using (Pen p = new Pen(c, 1.6f))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                if (kind == 0)
                {
                    g.DrawLine(p, cx, cy - 7, cx, cy + 4);
                    g.DrawLine(p, cx - 3.4f, cy + 0.8f, cx, cy + 4);
                    g.DrawLine(p, cx + 3.4f, cy + 0.8f, cx, cy + 4);
                    g.DrawLines(p, new PointF[] { new PointF(cx - 6.4f, cy + 4.4f), new PointF(cx - 6.4f, cy + 7), new PointF(cx + 6.4f, cy + 7), new PointF(cx + 6.4f, cy + 4.4f) });
                }
                else if (kind == 1)
                {
                    PointF[] cube = new PointF[] {
                        new PointF(cx, cy - 7), new PointF(cx + 7, cy - 3.2f), new PointF(cx + 7, cy + 3.2f),
                        new PointF(cx, cy + 7), new PointF(cx - 7, cy + 3.2f), new PointF(cx - 7, cy - 3.2f)
                    };
                    g.DrawPolygon(p, cube);
                    g.DrawLine(p, cx - 7, cy - 3.2f, cx, cy);
                    g.DrawLine(p, cx + 7, cy - 3.2f, cx, cy);
                    g.DrawLine(p, cx, cy, cx, cy + 7);
                }
                else if (kind == 2)
                {
                    g.DrawRectangle(p, cx - 7, cy - 5.5f, 14, 9);
                    g.DrawLine(p, cx - 3, cy + 6.5f, cx + 3, cy + 6.5f);
                    g.DrawLine(p, cx, cy + 3.5f, cx, cy + 6.5f);
                }
                else if (kind == 3)
                {
                    using (GraphicsPath fp = FolderPath(cx, cy)) g.DrawPath(p, fp);
                }
                else if (kind == 4)
                {
                    g.DrawRectangle(p, cx - 6.5f, cy - 6.5f, 5.6f, 5.6f);
                    g.DrawRectangle(p, cx + 0.9f, cy - 6.5f, 5.6f, 5.6f);
                    g.DrawRectangle(p, cx - 6.5f, cy + 0.9f, 5.6f, 5.6f);
                    g.DrawRectangle(p, cx + 0.9f, cy + 0.9f, 5.6f, 5.6f);
                }
                else if (kind == 5)
                {
                    g.DrawRectangle(p, cx - 4.5f, cy - 7, 9, 14);
                    g.DrawLine(p, cx - 1.6f, cy - 4.6f, cx + 1.6f, cy - 4.6f);
                    g.DrawLine(p, cx - 1.6f, cy - 1.8f, cx + 1.6f, cy - 1.8f);
                }
            }
        }

        GraphicsPath FolderPath(float cx, float cy)
        {
            GraphicsPath p = new GraphicsPath();
            p.AddLine(cx - 7, cy - 3.4f, cx - 1.5f, cy - 3.4f);
            p.AddLine(cx - 1.5f, cy - 3.4f, cx + 0.4f, cy - 1.6f);
            p.AddLine(cx + 0.4f, cy - 1.6f, cx + 7, cy - 1.6f);
            p.AddLine(cx + 7, cy - 1.6f, cx + 7, cy + 5.4f);
            p.AddLine(cx + 7, cy + 5.4f, cx - 7, cy + 5.4f);
            p.CloseFigure();
            return p;
        }

        void DrawCheck(Graphics g, float x, float y, float size, Color c)
        {
            using (Pen p = new Pen(c, 1.7f))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                g.DrawLine(p, x, y + size * 0.48f, x + size * 0.38f, y + size * 0.86f);
                g.DrawLine(p, x + size * 0.38f, y + size * 0.86f, x + size, y);
            }
        }

        void DrawShield(Graphics g, float x, float y, float s, Color c)
        {
            using (Pen p = new Pen(c, 1.5f))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddLine(x + s * 0.5f, y, x + s, y + s * 0.16f);
                    path.AddLine(x + s, y + s * 0.16f, x + s, y + s * 0.55f);
                    path.AddBezier(x + s, y + s * 0.55f, x + s, y + s * 0.82f, x + s * 0.7f, y + s * 0.95f, x + s * 0.5f, y + s);
                    path.AddBezier(x + s * 0.5f, y + s, x + s * 0.3f, y + s * 0.95f, x, y + s * 0.82f, x, y + s * 0.55f);
                    path.AddLine(x, y + s * 0.55f, x, y + s * 0.16f);
                    path.CloseFigure();
                    g.DrawPath(p, path);
                }
            }
        }

        void DrawInfo(Graphics g, float x, float y, float s, Color c)
        {
            using (Pen p = new Pen(c, 1.4f))
            {
                g.DrawEllipse(p, x, y, s, s);
                g.DrawLine(p, x + s * 0.5f, y + s * 0.45f, x + s * 0.5f, y + s * 0.72f);
                g.DrawLine(p, x + s * 0.5f, y + s * 0.28f, x + s * 0.5f, y + s * 0.31f);
            }
        }

        GraphicsPath Round(RectangleF r, float rad)
        {
            GraphicsPath p = new GraphicsPath();
            float d = rad * 2;
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        void FillRound(Graphics g, RectangleF r, float rad, Brush b)
        {
            using (GraphicsPath p = Round(r, rad)) g.FillPath(b, p);
        }

        void DrawRound(Graphics g, RectangleF r, float rad, Pen pen)
        {
            using (GraphicsPath p = Round(r, rad)) g.DrawPath(pen, p);
        }

        void Txt(Graphics g, string s, float x, float y, float w, float h, Font f, Color c)
        {
            Txt(g, s, x, y, w, h, f, c, StringAlignment.Near, StringAlignment.Near);
        }

        void Txt(Graphics g, string s, float x, float y, float w, float h, Font f, Color c, StringAlignment ha, StringAlignment va)
        {
            using (SolidBrush b = new SolidBrush(c))
            using (StringFormat sf = new StringFormat())
            {
                sf.Alignment = ha;
                sf.LineAlignment = va;
                sf.FormatFlags = StringFormatFlags.NoWrap;
                sf.Trimming = StringTrimming.EllipsisCharacter;
                g.DrawString(s, f, b, new RectangleF(x, y, w, h), sf);
            }
        }

        void TxtWrap(Graphics g, string s, float x, float y, float w, float h, Font f, Color c)
        {
            using (SolidBrush b = new SolidBrush(c))
            using (StringFormat sf = new StringFormat())
            {
                sf.Trimming = StringTrimming.EllipsisCharacter;
                g.DrawString(s, f, b, new RectangleF(x, y, w, h), sf);
            }
        }

        float Measure(Graphics g, string s, Font f)
        {
            return g.MeasureString(s, f).Width;
        }

        void Hot(string id, RectangleF r)
        {
            Spot s = new Spot();
            s.Id = id;
            s.Rect = r;
            if (overlayMode) overlaySpots.Add(s); else spots.Add(s);
        }

        string Hit(PointF p, List<Spot> list)
        {
            for (int i = list.Count - 1; i >= 0; i--)
                if (list[i].Rect.Contains(p)) return list[i].Id;
            return null;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            PointF p = new PointF(e.X / scale, e.Y / scale);
            string id = overlayLic ? Hit(p, overlaySpots) : Hit(p, spots);
            if (id != hover)
            {
                hover = id;
                Cursor = id == null ? Cursors.Default : Cursors.Hand;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hover != null) { hover = null; Cursor = Cursors.Default; Invalidate(); }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            PointF p = new PointF(e.X / scale, e.Y / scale);
            if (overlayLic) return;
            if (p.Y < TITLE_H && p.X < 960)
            {
                Native.ReleaseCapture();
                Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            PointF p = new PointF(e.X / scale, e.Y / scale);
            if (overlayLic)
            {
                string oid = Hit(p, overlaySpots);
                if (oid != null) OverlayClick(oid);
                return;
            }
            string id = Hit(p, spots);
            if (id != null) ClickId(id);
        }

        void OverlayClick(string id)
        {
            if (id == "lic-ok") { overlayLic = false; UpdateTextBoxes(); Invalidate(); }
        }

        void ClickId(string id)
        {
            if (id == "min") { WindowState = FormWindowState.Minimized; return; }
            if (id == "max") return;
            if (id == "close")
            {
                if (running) { MessageBox.Show(this, "Дождитесь завершения распаковки.", APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
                Application.Exit();
                return;
            }
            if (id == "lic") { overlayLic = true; UpdateTextBoxes(); Invalidate(); return; }

            if (id == "mode-install" || id == "mode-install-btn") { SetStep(1); return; }
            if (id == "mode-portable" || id == "mode-portable-btn") { SetStep(4); return; }
            if (id == "back") { SetStep(0); return; }

            if (id == "install-browse") { Browse(tbInstall); return; }
            if (id == "port-browse") { Browse(tbPortable); return; }

            if (id == "cb-desktop") { cbDesktop = !cbDesktop; Invalidate(); return; }
            if (id == "cb-menu") { cbMenu = !cbMenu; Invalidate(); return; }
            if (id == "cb-auto") { cbAuto = !cbAuto; Invalidate(); return; }
            if (id == "cb-bottom") { cbDesktop = !cbDesktop; Invalidate(); return; }
            if (id == "done-launch") { cbLaunch = !cbLaunch; Invalidate(); return; }

            if (id == "start-install") { portable = false; BeginInstall(); return; }
            if (id == "start-portable") { portable = true; BeginInstall(); return; }
            if (id == "cancel-install" || id == "cancel-port") { cancelFlag = true; return; }
            if (id == "done-folder") { OpenFolder(donePath); return; }
            if (id == "done-finish") { Finish(); return; }
        }

        void Browse(TextBox tb)
        {
            using (FolderBrowserDialog d = new FolderBrowserDialog())
            {
                d.Description = "Выберите папку";
                d.ShowNewFolderButton = true;
                string cur = tb.Text;
                if (Directory.Exists(cur)) d.SelectedPath = cur;
                if (d.ShowDialog(this) == DialogResult.OK) tb.Text = d.SelectedPath;
            }
        }

        void BeginInstall()
        {
            string target = portable ? portablePath : installPath;
            if (string.IsNullOrEmpty(target) || !Path.IsPathRooted(target))
            {
                MessageBox.Show(this, "Укажите папку установки.", APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try { Directory.CreateDirectory(target); }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Не удалось создать папку:\n" + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (Directory.GetFileSystemEntries(target).Length > 0)
            {
                if (MessageBox.Show(this, "Папка не пуста. Продолжить и заменить файлы?", APP_NAME, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            }

            progressInt = 0;
            stageInt = 0;
            cancelFlag = false;
            running = true;
            SetStep(portable ? 5 : 2);

            Thread t = new Thread(Work);
            t.IsBackground = true;
            t.Start();
        }

        void RunIntegration(string target, string arg)
        {
            string exe = Path.Combine(target, "APP", EXE_NAME);
            if (!File.Exists(exe)) return;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(exe, "--hidden " + arg);
                psi.UseShellExecute = false;
                psi.WorkingDirectory = target;
                using (Process p = Process.Start(psi)) { p.WaitForExit(180000); }
            }
            catch { }
        }

        void Work()
        {
            string target = portable ? portablePath : installPath;
            string zip = null;
            try
            {
                zip = Payload.ZipFromExe(Application.ExecutablePath);
                int lastPct = -1;
                using (ZipArchive a = ZipFile.OpenRead(zip))
                {
                    long total = 0;
                    foreach (ZipArchiveEntry en in a.Entries) total += Math.Max(1, en.Length);
                    long done = 0;
                    string root = Path.GetFullPath(target).TrimEnd('\\') + "\\";

                    foreach (ZipArchiveEntry en in a.Entries)
                    {
                        if (cancelFlag) throw new OperationCanceledException();
                        string name = en.FullName.Replace('/', '\\');
                        string dest = Path.GetFullPath(Path.Combine(target, name));
                        if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;

                        if (name.EndsWith("\\"))
                        {
                            Directory.CreateDirectory(dest);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        using (Stream es = en.Open())
                        using (FileStream fs = File.Create(dest))
                        {
                            byte[] buf = new byte[131072];
                            int n;
                            while ((n = es.Read(buf, 0, buf.Length)) > 0)
                            {
                                if (cancelFlag) throw new OperationCanceledException();
                                fs.Write(buf, 0, n);
                                done += n;
                                int p = (int)(done * 92 / total);
                                if (p != lastPct) { lastPct = p; progressInt = p; }
                            }
                        }
                    }
                }

                progressInt = 93; stageInt = 1;
                if (!portable)
                {
                    try { File.WriteAllText(Path.Combine(target, ".installed"), "1"); } catch { }
                    InstallOps.CreateShortcuts(target, cbDesktop, cbMenu);
                    progressInt = 97; stageInt = 2;
                    InstallOps.Register(target, cbAuto);
                    RunIntegration(target, "--install-integration");
                }
                else
                {
                    try { File.Delete(Path.Combine(target, ".installed")); } catch { }
                    if (!File.Exists(Path.Combine(target, EXE_NAME))) throw new Exception("Не найден " + EXE_NAME + " после распаковки.");
                    RunIntegration(target, "--clean-integration");
                }

                progressInt = 100; stageInt = portable ? 2 : 3;

                Thread.Sleep(420);
                BeginInvoke((Action)delegate
                {
                    running = false;
                    donePath = target;
                    SetStep(portable ? 6 : 3);
                });
            }
            catch (OperationCanceledException)
            {
                BeginInvoke((Action)delegate
                {
                    running = false;
                    progressInt = 0;
                    SetStep(portable ? 4 : 1);
                });
            }
            catch (Exception ex)
            {
                BeginInvoke((Action)delegate
                {
                    running = false;
                    MessageBox.Show(this, "Ошибка установки:\n" + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    SetStep(portable ? 4 : 1);
                });
            }
            finally
            {
                if (zip != null) { try { File.Delete(zip); } catch { } }
            }
        }

        void OpenFolder(string path)
        {
            try { if (Directory.Exists(path)) Process.Start("explorer.exe", "\"" + path + "\""); }
            catch { }
        }

        void Finish()
        {
            try
            {
                if (cbLaunch && !string.IsNullOrEmpty(donePath))
                {
                    string exe = Path.Combine(donePath, EXE_NAME);
                    if (File.Exists(exe))
                        Process.Start("explorer.exe", "\"" + exe + "\"");
                }
            }
            catch { }
            Application.Exit();
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Enter)
            {
                if (overlayLic) return base.ProcessCmdKey(ref msg, keyData);
                if (step == 0) { SetStep(1); return true; }
                if (step == 1) { BeginInstall(); return true; }
                if (step == 4) { portable = true; BeginInstall(); return true; }
                if (step == 3 || step == 6) { Finish(); return true; }
            }
            if (keyData == Keys.Escape)
            {
                if (overlayLic) { overlayLic = false; UpdateTextBoxes(); Invalidate(); return true; }
                if (step == 1 || step == 4) { SetStep(0); return true; }
                if (step == 0) { Application.Exit(); return true; }
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (animTimer != null) animTimer.Dispose();
                if (appIcon != null) appIcon.Dispose();
            }
            base.Dispose(disposing);
        }

        public void PreviewSet(int s, int pct)
        {
            portable = (s == 4 || s == 6);
            progressInt = pct;
            stageInt = 1;
            donePath = portable ? portablePath : installPath;
            SetStep(s);
        }

        public void PreviewSetPaths(string install, string portable)
        {
            installPath = install;
            portablePath = portable;
            tbInstall.Text = install;
            tbPortable.Text = portable;
        }
    }

    static class Preview
    {
        public static void Run(string dir)
        {
            Directory.CreateDirectory(dir);
            using (SetupForm f = new SetupForm())
            {
                f.PreviewSetPaths(@"C:\Program Files\ADB Wi-Fi Connector", @"D:\ADB-WiFi-Connector");
                f.DontCenter = true;
                f.ShowInTaskbar = false;
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-4000, -4000);
                f.Show();
                Application.DoEvents();

                int[] steps = { 0, 1, 2, 3, 4, 6 };
                string[] names = { "01-mode", "02-install-options", "03-install-progress", "04-install-done", "05-portable-options", "06-portable-done" };
                for (int i = 0; i < steps.Length; i++)
                {
                    f.PreviewSet(steps[i], steps[i] == 2 ? 62 : 100);
                    Application.DoEvents();
                    f.Refresh();
                    Application.DoEvents();
                    Bitmap bmp = new Bitmap(f.ClientSize.Width, f.ClientSize.Height);
                    f.DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
                    bmp.Save(Path.Combine(dir, names[i] + ".png"), System.Drawing.Imaging.ImageFormat.Png);
                    bmp.Dispose();
                }
                f.Close();
            }
        }
    }
}
