using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AdbWifiUninstall
{
    static class Program
    {
        const string APP_NAME = "ADB Wi-Fi Connector";
        const string UNINST_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ADBWiFiConnector";
        const string RUN_VALUE = "ADB Wi-Fi Connector";

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main(string[] args)
        {
            if (args.Length >= 2 && args[0] == "/cleanup") { RunCleanup(args[1]); return; }

            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            string dataDir = Path.Combine(dir, "Сохранения");
            bool hasData = Directory.Exists(dataDir) && Directory.GetFileSystemEntries(dataDir).Length > 0;

            if (MessageBox.Show("Удалить " + APP_NAME + " с этого компьютера?", APP_NAME,
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                return;

            bool deleteData = true;
            if (hasData)
            {
                DialogResult r = MessageBox.Show(
                    "Удалить также сохранения?\r\n\r\nВ папке «Сохранения» лежат настройки, история, список устройств и метки приложений.\r\n\r\n«Нет» — папка останется на месте.",
                    APP_NAME, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (r == DialogResult.Cancel) return;
                deleteData = (r == DialogResult.Yes);
            }

            try { RemoveShortcuts(); } catch { }
            try { RemoveRegistry(); } catch { }
            try { DeleteContents(dir, Application.ExecutablePath, !deleteData); } catch { }
            ScheduleRemoval(dir, Application.ExecutablePath, deleteData);
        }

        static void RemoveShortcuts()
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
            TryDelete(Path.Combine(desktop, APP_NAME + ".lnk"));
            TryDelete(Path.Combine(programs, APP_NAME + ".lnk"));
        }

        static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        static void RemoveRegistry()
        {
            try { Registry.LocalMachine.DeleteSubKeyTree(UNINST_KEY, false); } catch { }

            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    if (k != null) k.DeleteValue(RUN_VALUE, false);
            }
            catch { }
        }

        static void DeleteContents(string dir, string self, bool keepData)
        {
            string keep = Path.Combine(dir, "Сохранения");
            foreach (string entry in Directory.GetFileSystemEntries(dir))
            {
                if (keepData && string.Equals(entry, keep, StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(entry, self, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    if (Directory.Exists(entry)) Directory.Delete(entry, true);
                    else File.Delete(entry);
                }
                catch { }
            }
        }

        static void ScheduleRemoval(string dir, string self, bool deleteAll)
        {
            try
            {
                if (deleteAll)
                {
                    string helper = Path.Combine(Path.GetTempPath(), "adbwifi-cleanup-" + Guid.NewGuid().ToString("N") + ".exe");
                    File.Copy(self, helper, true);
                    ProcessStartInfo hp = new ProcessStartInfo(helper, "/cleanup \"" + dir + "\"");
                    hp.CreateNoWindow = true;
                    hp.UseShellExecute = false;
                    hp.WorkingDirectory = Path.GetTempPath();
                    Process.Start(hp);
                }
                else
                {
                    ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 2 >nul & del /f /q \"" + self + "\"");
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    psi.WorkingDirectory = Path.GetTempPath();
                    Process.Start(psi);
                }
            }
            catch { }
        }

        static void RunCleanup(string dir)
        {
            for (int i = 0; i < 60; i++)
            {
                try
                {
                    if (!Directory.Exists(dir)) break;
                    Directory.Delete(dir, true);
                    if (!Directory.Exists(dir)) break;
                }
                catch { }
                System.Threading.Thread.Sleep(500);
            }
            try
            {
                string self = Application.ExecutablePath;
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 2 >nul & del /f /q \"" + self + "\"");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WorkingDirectory = Path.GetTempPath();
                Process.Start(psi);
            }
            catch { }
        }
    }
}
