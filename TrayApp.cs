// TBSA-Serveur : lanceur en arriere-plan (icone pres de l'horloge), comme Plex Media Server.
// Demarre TBSA-Serveur-Core.exe sans fenetre, le relance s'il s'arrete, et ouvre l'interface dans le navigateur.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    static Mutex mutex;
    static Process server;
    static NotifyIcon icon;
    static bool quitting, silent, firstStart = true;
    static string appDir, dataDir, logPath, portPath;
    static int quickDeaths;
    static DateTime lastStart = DateTime.MinValue;
    static readonly object logLock = new object();

    [STAThread]
    static void Main(string[] args)
    {
        silent = Array.IndexOf(args, "--silent") >= 0;
        bool created;
        mutex = new Mutex(true, "TBSA-Serveur-Tray-Mutex", out created);
        appDir = AppDomain.CurrentDomain.BaseDirectory;
        dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TBSA-Serveur");
        portPath = Path.Combine(dataDir, "port.txt");
        logPath = Path.Combine(dataDir, "server.log");
        if (!created)
        {   // deja lance : on se contente d'ouvrir l'interface
            if (!silent) OpenBrowser();
            return;
        }
        try { Directory.CreateDirectory(dataDir); } catch { }
        try { if (File.Exists(logPath) && new FileInfo(logPath).Length > 2000000) File.Delete(logPath); } catch { }

        Application.EnableVisualStyles();
        icon = new NotifyIcon();
        icon.Text = "TBSA-Serveur";
        try { icon.Icon = new Icon(Path.Combine(appDir, "TBSA.ico")); } catch { icon.Icon = SystemIcons.Application; }
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Ouvrir TBSA-Serveur", null, delegate { OpenBrowser(); });
        menu.Items.Add("Ouvrir le dossier des données", null, delegate { Process.Start("explorer.exe", "\"" + dataDir + "\""); });
        menu.Items.Add("Voir le journal", null, delegate { if (File.Exists(logPath)) Process.Start("notepad.exe", "\"" + logPath + "\""); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Redémarrer le serveur", null, delegate { Restart(); });
        menu.Items.Add("Quitter", null, delegate { Quit(); });
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += delegate { OpenBrowser(); };
        icon.Visible = true;

        StartServer();
        if (!silent) { Thread t = new Thread(OpenWhenReady); t.IsBackground = true; t.Start(); }
        Application.ApplicationExit += delegate { StopServer(); icon.Visible = false; };
        Application.Run();
    }

    static void Log(string s)
    {
        try { lock (logLock) File.AppendAllText(logPath, s + Environment.NewLine); } catch { }
    }

    static void StartServer()
    {
        try
        {
            string core = Path.Combine(appDir, "TBSA-Serveur-Core.exe");
            try { if (File.Exists(portPath)) File.Delete(portPath); } catch { }
            ProcessStartInfo psi = new ProcessStartInfo(core);
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.EnvironmentVariables["TBSA_HIDDEN"] = "1";
            psi.EnvironmentVariables["TBSA_NOOPEN"] = "1";
            Process p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
            p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
            p.Exited += OnExited;
            lastStart = DateTime.Now;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            server = p;
        }
        catch (Exception ex)
        {
            Log("Impossible de lancer le serveur : " + ex.Message);
            icon.ShowBalloonTip(5000, "TBSA-Serveur", "Impossible de lancer le serveur : " + ex.Message, ToolTipIcon.Error);
        }
    }

    static void OnExited(object sender, EventArgs e)
    {
        if (quitting) return;
        if ((DateTime.Now - lastStart).TotalSeconds < 15) quickDeaths++; else quickDeaths = 0;
        if (quickDeaths >= 4)
        {
            Log("Le serveur s'arrete tout de suite : abandon.");
            try { icon.ShowBalloonTip(8000, "TBSA-Serveur", "Le serveur ne démarre pas. Clic droit sur l'icône > Voir le journal.", ToolTipIcon.Error); } catch { }
            return;
        }
        Thread.Sleep(1500);   // arret volontaire (ex. restauration d'une sauvegarde) ou plantage : on relance
        if (!quitting) StartServer();
    }

    static void StopServer()
    {
        quitting = true;
        try
        {
            if (server != null && !server.HasExited)
            {
                Process k = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + server.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
                k.WaitForExit(4000);
            }
        }
        catch { }
    }

    static void Restart()
    {
        quickDeaths = 0;
        try { if (server != null && !server.HasExited) { server.Kill(); return; } } catch { }
        StartServer();   // (si le serveur etait deja arrete)
    }

    static void Quit()
    {
        StopServer();
        icon.Visible = false;
        Application.Exit();
    }

    static string ReadPort()
    {
        try { if (File.Exists(portPath)) { string t = File.ReadAllText(portPath).Trim(); int n; if (int.TryParse(t, out n) && n > 0) return t; } } catch { }
        return null;
    }

    static void OpenWhenReady()
    {
        for (int i = 0; i < 120; i++) { if (ReadPort() != null) break; Thread.Sleep(500); }
        OpenBrowser();
    }

    static void OpenBrowser()
    {
        string port = ReadPort() ?? "8585";
        try { Process.Start(new ProcessStartInfo("http://localhost:" + port + "/") { UseShellExecute = true }); } catch { }
    }
}
