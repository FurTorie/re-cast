// re:cast - app de barre des tâches Windows
//
// Pourquoi du C# compilé plutôt qu'Electron : l'app doit rester en permanence en
// arrière-plan. Electron coûterait ~180 Mo sur disque et ~150 Mo de RAM pour
// afficher un menu. Ici l'exécutable pèse quelques dizaines de Ko et se compile
// avec le csc.exe déjà présent dans Windows — rien à installer.
//
// Le daemon reste un processus Node séparé, lancé en enfant. On capture sa sortie
// standard : c'est ce qui permet d'afficher les logs même quand le serveur n'a
// jamais réussi à démarrer, précisément le moment où on en a besoin.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace Recast
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }
    }

    // ─── Mémoire ──────────────────────────────────────────────────────────────
    // Une app qui reste allumée en permanence doit rendre ce qu'elle n'utilise
    // plus. Après le démarrage, .NET garde résidentes quantité de pages qui ne
    // resserviront jamais : EmptyWorkingSet les rend à Windows, qui les
    // rechargera à la demande dans le cas rare où elles redeviennent utiles.

    static class Memoire
    {
        [DllImport("psapi.dll")]
        static extern int EmptyWorkingSet(IntPtr hProcess);

        [DllImport("user32.dll")]
        internal static extern bool DestroyIcon(IntPtr handle);

        public static void Compacter()
        {
            try
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                EmptyWorkingSet(Process.GetCurrentProcess().Handle);
            }
            catch { }
        }
    }

    class TrayApp : ApplicationContext
    {
        const int PORT = 7171;
        const int MAX_LIGNES = 600;          // ~60 Ko de journal, largement assez pour diagnostiquer
        const int SONDAGE_REPOS = 10000;     // au repos, rien ne change vite
        const int SONDAGE_LECTURE = 3000;    // pendant une lecture, on veut voir l'arrêt rapidement

        readonly NotifyIcon icone;
        readonly Timer sondage;
        readonly List<string> journal = new List<string>();
        readonly object verrou = new object();

        Process node;
        ConsoleForm console;
        string adresse;          // "192.168.1.16:7171" quand le serveur répond
        string lectureNom;       // appareil en cours de lecture, sinon null
        string lectureProto;
        int nbErreurs;
        bool redemarrage;

        public TrayApp()
        {
            icone = new NotifyIcon
            {
                Icon = ChargerIcone(),
                Text = "re:cast",
                Visible = true
            };
            icone.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OuvrirMenu(); };

            ConstruireMenu();
            DemarrerNode();

            // Le serveur met un instant à répondre ; on sonde régulièrement plutôt
            // que d'attendre, ce qui rend aussi visible une coupure ultérieure.
            // La cadence s'adapte : inutile d'interroger toutes les 3 s quand rien
            // ne joue, c'est autant d'allocations et de réveils du processeur.
            sondage = new Timer { Interval = SONDAGE_LECTURE };
            sondage.Tick += (s, e) => Sonder();
            sondage.Start();

            // Le démarrage est de loin le moment le plus gourmand : chargement des
            // assemblies, JIT, création des contrôles. Une fois passé, on rend tout
            // ce qui ne resservira pas.
            var apresDemarrage = new Timer { Interval = 8000 };
            apresDemarrage.Tick += (s, e) => { apresDemarrage.Stop(); apresDemarrage.Dispose(); Memoire.Compacter(); };
            apresDemarrage.Start();
        }

        // ─── Icône ────────────────────────────────────────────────────────────

        // On part du PNG livré avec l'app : pas besoin de générer un .ico.
        // GetHicon() alloue un handle non managé que le ramasse-miettes ne libère
        // pas : on recopie l'icône puis on détruit le handle, sinon il fuit.
        Icon ChargerIcone()
        {
            string chemin = Path.Combine(DossierApp(), "tray.png");
            IntPtr h = IntPtr.Zero;
            try
            {
                using (var bmp = new Bitmap(chemin))
                {
                    h = bmp.GetHicon();
                    using (var temporaire = Icon.FromHandle(h))
                        return (Icon)temporaire.Clone();
                }
            }
            catch
            {
                return SystemIcons.Application;
            }
            finally
            {
                if (h != IntPtr.Zero) Memoire.DestroyIcon(h);
            }
        }

        static string DossierApp()
        {
            return Path.GetDirectoryName(Application.ExecutablePath);
        }

        // Remonte l'arborescence jusqu'à trouver daemon/index.js : l'exe peut vivre
        // dans app/ pendant le développement comme ailleurs une fois installé.
        static string TrouverDaemon()
        {
            var dir = new DirectoryInfo(DossierApp());
            for (int i = 0; i < 5 && dir != null; i++)
            {
                string candidat = Path.Combine(dir.FullName, "daemon", "index.js");
                if (File.Exists(candidat)) return candidat;
                dir = dir.Parent;
            }
            return null;
        }

        // ─── Processus Node ───────────────────────────────────────────────────

        void DemarrerNode()
        {
            string script = TrouverDaemon();
            if (script == null)
            {
                Ajouter("[app] ERREUR : daemon/index.js introuvable depuis " + DossierApp());
                return;
            }

            var psi = new ProcessStartInfo("node", "\"" + script + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,          // aucune fenêtre console qui clignote
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(script),
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            try
            {
                node = new Process { StartInfo = psi, EnableRaisingEvents = true };
                node.OutputDataReceived += (s, e) => { if (e.Data != null) Ajouter(e.Data); };
                node.ErrorDataReceived  += (s, e) => { if (e.Data != null) Ajouter(e.Data); };
                node.Exited += (s, e) =>
                {
                    Ajouter("[app] Le daemon s'est arrêté (code " + SafeExitCode() + ").");
                    adresse = null;
                    Rafraichir();
                };

                node.Start();
                node.BeginOutputReadLine();
                node.BeginErrorReadLine();
                Ajouter("[app] Daemon lancé : " + script);
            }
            catch (Exception ex)
            {
                Ajouter("[app] ERREUR au lancement de node : " + ex.Message);
                Ajouter("[app] Node.js est-il installé et dans le PATH ?");
            }
        }

        string SafeExitCode()
        {
            try { return node != null ? node.ExitCode.ToString() : "?"; }
            catch { return "?"; }
        }

        void ArreterNode()
        {
            if (node == null) return;
            try
            {
                if (!node.HasExited)
                {
                    // Kill(true) tuerait aussi les descendants, mais n'existe pas en
                    // .NET Framework : le daemon n'a pas d'enfants, Kill() suffit.
                    node.Kill();
                    node.WaitForExit(4000);
                }
            }
            catch { }
            node = null;
        }

        // ─── Sondage de l'état ────────────────────────────────────────────────

        void Sonder()
        {
            string reponse = null;
            try
            {
                using (var wc = new WebClient())
                {
                    // Court : le serveur est local, s'il ne répond pas vite il est mort
                    wc.Encoding = Encoding.UTF8;
                    reponse = wc.DownloadString("http://127.0.0.1:" + PORT + "/status");
                }
            }
            catch { }

            if (reponse == null)
            {
                if (adresse != null) { adresse = null; Rafraichir(); }
                return;
            }

            // Le corps est produit par notre propre serveur : une extraction ciblée
            // suffit et évite d'embarquer un analyseur JSON.
            string nom   = Extraire(reponse, "\"deviceName\"\\s*:\\s*\"([^\"]*)\"");
            string proto = Extraire(reponse, "\"protocole\"\\s*:\\s*\"([^\"]*)\"");

            bool change = (nom != lectureNom) || (proto != lectureProto) || (adresse == null);
            lectureNom = nom;
            lectureProto = proto;
            if (adresse == null) adresse = LireAdresseDuJournal() ?? ("localhost:" + PORT);

            // Cadence adaptée : rapide pendant une lecture, lente au repos
            int voulu = string.IsNullOrEmpty(lectureNom) ? SONDAGE_REPOS : SONDAGE_LECTURE;
            if (sondage.Interval != voulu) sondage.Interval = voulu;

            if (change) Rafraichir();
        }

        static string Extraire(string source, string motif)
        {
            var m = Regex.Match(source, motif);
            return m.Success ? m.Groups[1].Value : null;
        }

        // Le daemon annonce son IP LAN au démarrage ; c'est celle à saisir dans
        // l'extension, et elle n'apparaît nulle part ailleurs.
        string LireAdresseDuJournal()
        {
            lock (verrou)
            {
                for (int i = journal.Count - 1; i >= 0; i--)
                {
                    var m = Regex.Match(journal[i], @"Accessible sur le réseau local : http://([\d.]+:\d+)");
                    if (m.Success) return m.Groups[1].Value;
                }
            }
            return null;
        }

        // ─── Journal ──────────────────────────────────────────────────────────

        void Ajouter(string ligne)
        {
            lock (verrou)
            {
                journal.Add(DateTime.Now.ToString("HH:mm:ss") + "  " + ligne);
                if (journal.Count > MAX_LIGNES) journal.RemoveAt(0);
                if (ligne.IndexOf("ERREUR", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    ligne.IndexOf("Error",  StringComparison.OrdinalIgnoreCase) >= 0)
                    nbErreurs++;
            }

            if (console != null && !console.IsDisposed)
                console.BeginInvoke((Action)(() => console.Ajouter(journal[journal.Count - 1])));
        }

        public string[] Journal()
        {
            lock (verrou) return journal.ToArray();
        }

        public void ViderJournal()
        {
            lock (verrou) { journal.Clear(); nbErreurs = 0; }
            Rafraichir();
        }

        // ─── Menu ─────────────────────────────────────────────────────────────

        void OuvrirMenu()
        {
            // Le menu contextuel ne s'ouvre pas seul au clic gauche
            var mi = typeof(NotifyIcon).GetMethod("ShowContextMenu",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            if (mi != null) mi.Invoke(icone, null);
        }

        void Rafraichir()
        {
            if (icone.ContextMenuStrip != null && icone.ContextMenuStrip.InvokeRequired)
            {
                icone.ContextMenuStrip.BeginInvoke((Action)ConstruireMenu);
                return;
            }
            ConstruireMenu();
        }

        void ConstruireMenu()
        {
            var menu = new ContextMenuStrip();
            bool actif = adresse != null;

            // Statut
            menu.Items.Add(Inerte(redemarrage ? "⏳  Redémarrage…"
                                 : actif ? "●  Serveur actif"
                                         : "○  Serveur arrêté"));

            if (actif)
            {
                var it = new ToolStripMenuItem("      " + adresse + "     (copier)");
                it.Click += (s, e) => { try { Clipboard.SetText(adresse); } catch { } };
                menu.Items.Add(it);
            }

            menu.Items.Add(new ToolStripSeparator());

            // Lecture en cours
            if (!string.IsNullOrEmpty(lectureNom))
            {
                menu.Items.Add(Inerte("▶  " + lectureNom));
                if (!string.IsNullOrEmpty(lectureProto))
                    menu.Items.Add(Inerte("      " + lectureProto));

                var stop = new ToolStripMenuItem("      Arrêter la lecture");
                stop.Click += (s, e) => ArreterLecture();
                menu.Items.Add(stop);
            }
            else
            {
                menu.Items.Add(Inerte("■  Aucune lecture en cours"));
            }

            menu.Items.Add(new ToolStripSeparator());

            var redem = new ToolStripMenuItem("Redémarrer le serveur");
            redem.Enabled = !redemarrage;
            redem.Click += (s, e) => Redemarrer();
            menu.Items.Add(redem);

            var cons = new ToolStripMenuItem(nbErreurs > 0
                ? "Console  (" + nbErreurs + " erreur" + (nbErreurs > 1 ? "s" : "") + ")"
                : "Console");
            cons.Click += (s, e) => OuvrirConsole();
            menu.Items.Add(cons);

            menu.Items.Add(new ToolStripSeparator());

            var demarrage = new ToolStripMenuItem("Démarrer avec Windows");
            demarrage.Checked = DemarrageAuto.Actif();
            demarrage.Click += (s, e) => { DemarrageAuto.Basculer(!demarrage.Checked); Rafraichir(); };
            menu.Items.Add(demarrage);

            var quitter = new ToolStripMenuItem("Quitter");
            quitter.Click += (s, e) => Quitter();
            menu.Items.Add(quitter);

            // Libérer l'ancien menu : sans ça chaque rafraîchissement en abandonnait
            // un complet, avec ses items et leurs handles. Sur une app qui tourne
            // des jours, la fuite est loin d'être théorique.
            var precedent = icone.ContextMenuStrip;
            icone.ContextMenuStrip = menu;
            if (precedent != null)
            {
                // Un menu ouvert au moment du rafraîchissement ne doit pas être
                // détruit sous les doigts de l'utilisateur : on attend sa fermeture.
                if (precedent.Visible) precedent.Closed += (s, e) => precedent.Dispose();
                else precedent.Dispose();
            }

            icone.Text = !string.IsNullOrEmpty(lectureNom)
                ? Tronquer("re:cast — " + lectureNom, 63)
                : actif ? Tronquer("re:cast — " + adresse, 63) : "re:cast — arrêté";
        }

        static ToolStripMenuItem Inerte(string texte)
        {
            return new ToolStripMenuItem(texte) { Enabled = false };
        }

        static string Tronquer(string t, int n)
        {
            return t.Length > n ? t.Substring(0, n - 1) + "…" : t;
        }

        // ─── Actions ──────────────────────────────────────────────────────────

        void Redemarrer()
        {
            redemarrage = true;
            Rafraichir();

            Ajouter("[app] Redémarrage du serveur demandé.");
            ArreterNode();
            adresse = null;
            lectureNom = null;
            DemarrerNode();

            redemarrage = false;
            Rafraichir();
        }

        // On passe par l'API HTTP, comme l'extension : même chemin, même état.
        void ArreterLecture()
        {
            try
            {
                using (var wc = new WebClient())
                    wc.UploadString("http://127.0.0.1:" + PORT + "/stop", "POST", "");
                lectureNom = null;
                Rafraichir();
            }
            catch (Exception ex)
            {
                Ajouter("[app] Arrêt de la lecture impossible : " + ex.Message);
            }
        }

        void OuvrirConsole()
        {
            if (console != null && !console.IsDisposed)
            {
                console.Show();
                console.WindowState = FormWindowState.Normal;
                console.Activate();
                return;
            }

            console = new ConsoleForm(this);
            // La fenêtre détient tout le journal dupliqué dans un TextBox : à sa
            // fermeture on la relâche et on rend la mémoire.
            console.FormClosed += (s, e) => { console = null; Memoire.Compacter(); };
            console.Show();
        }

        void Quitter()
        {
            sondage.Stop();
            ArreterNode();
            icone.Visible = false;
            icone.Dispose();
            Application.Exit();
        }
    }

    // ─── Démarrage automatique ────────────────────────────────────────────────
    // Clé Run de l'utilisateur courant : pas de droits administrateur nécessaires,
    // contrairement à un service ou à HKLM.

    static class DemarrageAuto
    {
        const string CLE = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string NOM = "re:cast";

        public static bool Actif()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(CLE))
                    return k != null && k.GetValue(NOM) != null;
            }
            catch { return false; }
        }

        public static void Basculer(bool actif)
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(CLE, true))
                {
                    if (k == null) return;
                    if (actif) k.SetValue(NOM, "\"" + Application.ExecutablePath + "\"");
                    else k.DeleteValue(NOM, false);
                }
            }
            catch { }
        }
    }

    // ─── Fenêtre de console ───────────────────────────────────────────────────

    class ConsoleForm : Form
    {
        readonly TrayApp app;
        readonly TextBox zone;

        public ConsoleForm(TrayApp app)
        {
            this.app = app;

            Text = "re:cast — console";
            Width = 900;
            Height = 560;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(26, 26, 46);

            zone = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(22, 33, 62),
                ForeColor = Color.FromArgb(220, 220, 230),
                Font = new Font("Consolas", 9f),
                BorderStyle = BorderStyle.None
            };

            var barre = new Panel { Dock = DockStyle.Bottom, Height = 38, BackColor = Color.FromArgb(26, 26, 46) };

            barre.Controls.Add(Bouton("Copier tout", 10, (s, e) =>
            {
                try { Clipboard.SetText(zone.Text); } catch { }
            }));
            barre.Controls.Add(Bouton("Vider", 130, (s, e) =>
            {
                app.ViderJournal();
                zone.Clear();
            }));

            Controls.Add(zone);
            Controls.Add(barre);

            zone.Lines = app.Journal();
            Defiler();
        }

        Button Bouton(string texte, int x, EventHandler action)
        {
            var b = new Button
            {
                Text = texte,
                Left = x,
                Top = 6,
                Width = 110,
                Height = 26,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(15, 52, 96),
                ForeColor = Color.White
            };
            b.FlatAppearance.BorderSize = 0;
            b.Click += action;
            return b;
        }

        public void Ajouter(string ligne)
        {
            zone.AppendText(ligne + Environment.NewLine);
        }

        void Defiler()
        {
            zone.SelectionStart = zone.TextLength;
            zone.ScrollToCaret();
        }
    }
}
