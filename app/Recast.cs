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
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Windows.Forms;

// System.Threading et System.Windows.Forms exposent tous deux un Timer. Ici on
// veut systematiquement celui de WinForms, qui declenche sur le thread d'interface.
using Timer = System.Windows.Forms.Timer;

namespace Recast
{
    static class Program
    {
        // Conserve pendant toute la vie du processus : le mutex est libere a la
        // sortie. Sans instance unique, deux apps lancent deux daemons qui se
        // disputent le port 7171, et la seconde reste inerte.
        static Mutex verrou;

        [STAThread]
        static void Main()
        {
            bool premier;
            verrou = new Mutex(true, "recast-tray-app-9f2c", out premier);
            if (!premier)
            {
                MessageBox.Show(
                    "re:cast est déjà lancé.\n\nSon icône se trouve dans la zone de notification, " +
                    "près de l'horloge — pensez à déplier la flèche si elle est masquée.",
                    "re:cast", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());

            GC.KeepAlive(verrou);
        }
    }

    // ─── Port ─────────────────────────────────────────────────────────────────
    // Quand le port est pris par un daemon fantome — lance a la main, ou reste
    // d'une instance mal fermee — l'app doit pouvoir le liberer sur demande
    // plutot que de rester bloquee sans recours.

    static class Port
    {
        // netstat plutot que GetExtendedTcpTable : quinze lignes contre soixante,
        // et c'est une action ponctuelle declenchee par l'utilisateur.
        public static int Occupant(int port)
        {
            try
            {
                var psi = new ProcessStartInfo("netstat", "-ano -p TCP")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };

                using (var p = Process.Start(psi))
                {
                    string sortie = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);

                    foreach (string ligne in sortie.Split('\n'))
                    {
                        if (ligne.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        var m = Regex.Match(ligne, @"\S+:" + port + @"\s+\S+\s+LISTENING\s+(\d+)");
                        if (m.Success) return int.Parse(m.Groups[1].Value);
                    }
                }
            }
            catch { }
            return 0;
        }

        public static string Nom(int pid)
        {
            try { return Process.GetProcessById(pid).ProcessName; }
            catch { return "inconnu"; }
        }

        // La ligne de commande dit si le processus fautif est un daemon re:cast
        // orphelin — cas courant apres un arret force, l'enfant node survivant a
        // son parent — ou un logiciel tiers qu'il ne faut surtout pas tuer sans
        // demander. WMI est le seul moyen de l'obtenir pour un autre processus.
        public static string LigneDeCommande(int pid)
        {
            try
            {
                using (var chercheur = new System.Management.ManagementObjectSearcher(
                    "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
                using (var resultats = chercheur.Get())
                {
                    foreach (System.Management.ManagementObject o in resultats)
                    {
                        var v = o["CommandLine"];
                        if (v != null) return v.ToString();
                    }
                }
            }
            catch { }
            return null;
        }

        // Un daemon re:cast, reconnaissable a son script. On ne se fie pas au seul
        // nom « node » : d'autres logiciels tournent sous Node.
        public static bool EstNotreDaemon(int pid)
        {
            string ligne = LigneDeCommande(pid);
            if (string.IsNullOrEmpty(ligne)) return false;
            ligne = ligne.Replace('/', '\\').ToLowerInvariant();
            return ligne.Contains("\\daemon\\index.js")
                && (ligne.Contains("re-cast") || ligne.Contains("re cast") || ligne.Contains("recast"));
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

    // ─── Mise à jour ──────────────────────────────────────────────────────────
    // L'app telecharge et execute un installateur : c'est puissant, donc deux
    // verrous non negociables.
    //   1. L'URL doit pointer vers les releases de CE depot. Sans ce controle, un
    //      manifeste altere ferait executer n'importe quel binaire.
    //   2. L'empreinte SHA-256 publiee par la CI doit correspondre au fichier
    //      telecharge, sinon on jette.
    // On passe par un manifeste statique plutot que par l'API GitHub : pas de
    // quota, et c'est le meme principe que l'updates.json de l'extension.

    static class MiseAJour
    {
        const string MANIFESTE = "https://raw.githubusercontent.com/FurTorie/re-cast/main/app-latest.json";
        const string PREFIXE_AUTORISE = "https://github.com/FurTorie/re-cast/releases/download/";

        public class Info
        {
            public Version Version;
            public string Url;
            public string Sha256;
        }

        // Retourne null s'il n'y a rien de plus recent, ou en cas d'echec reseau :
        // une mise a jour ratee ne doit jamais gener l'usage normal.
        public static Info Chercher(Version courante)
        {
            try
            {
                ServicePointManager.SecurityProtocol =
                    SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; // 12288 = Tls13

                string json;
                using (var wc = new WebClient())
                {
                    wc.Encoding = Encoding.UTF8;
                    wc.Headers.Add("User-Agent", "recast-app");
                    json = wc.DownloadString(MANIFESTE + "?t=" + DateTime.UtcNow.Ticks);
                }

                string v   = Champ(json, "version");
                string url = Champ(json, "url");
                string sha = Champ(json, "sha256");
                if (v == null || url == null) return null;

                Version distante;
                if (!Version.TryParse(v.Length == 3 || v.Split('.').Length == 3 ? v + ".0" : v, out distante))
                    return null;

                if (distante <= courante) return null;
                if (!url.StartsWith(PREFIXE_AUTORISE, StringComparison.OrdinalIgnoreCase)) return null;

                return new Info { Version = distante, Url = url, Sha256 = sha };
            }
            catch { return null; }
        }

        static string Champ(string json, string nom)
        {
            var m = Regex.Match(json, "\"" + nom + "\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value : null;
        }

        // Retourne le chemin du fichier telecharge, ou null si quoi que ce soit cloche.
        public static string Telecharger(Info info)
        {
            string cible = Path.Combine(Path.GetTempPath(), "recast-setup-" + info.Version + ".exe");
            try
            {
                using (var wc = new WebClient())
                {
                    wc.Headers.Add("User-Agent", "recast-app");
                    wc.DownloadFile(info.Url, cible);
                }

                if (!string.IsNullOrEmpty(info.Sha256))
                {
                    string reel = Empreinte(cible);
                    if (!string.Equals(reel, info.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        try { File.Delete(cible); } catch { }
                        return null;
                    }
                }
                return cible;
            }
            catch
            {
                try { if (File.Exists(cible)) File.Delete(cible); } catch { }
                return null;
            }
        }

        static string Empreinte(string chemin)
        {
            using (var sha = SHA256.Create())
            using (var flux = File.OpenRead(chemin))
                return BitConverter.ToString(sha.ComputeHash(flux)).Replace("-", "");
        }

        public static Version Courante()
        {
            return System.Reflection.Assembly.GetExecutingAssembly().GetName().Version;
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

        readonly SynchronizationContext ui;
        MiseAJour.Info majDispo;
        bool majEnCours;
        bool portOccupe;         // le daemon a refusé de démarrer, port déjà pris

        public TrayApp()
        {
            // Capturé ici, sur le thread d'interface : les vérifications réseau
            // tournent en tâche de fond et doivent revenir par ce canal.
            ui = SynchronizationContext.Current;

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

            // Première vérification 30 s après le démarrage — laisser le daemon
            // se lancer d'abord — puis toutes les 6 h.
            var verifMaj = new Timer { Interval = 30000 };
            verifMaj.Tick += (s, e) => { verifMaj.Interval = 6 * 3600 * 1000; ChercherMaj(); };
            verifMaj.Start();
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

            // Un daemon re:cast orphelin garde le port : cas courant apres un arret
            // force, l'enfant node survivant a son parent. Comme il est indubitablement
            // le notre, on le remplace sans rien demander. Tout autre processus, en
            // revanche, ne sera jamais tue sans confirmation explicite.
            int occupant = Port.Occupant(PORT);
            if (occupant != 0 && Port.EstNotreDaemon(occupant))
            {
                try
                {
                    var vieux = Process.GetProcessById(occupant);
                    vieux.Kill();
                    vieux.WaitForExit(5000);
                    Ajouter("[app] Daemon orphelin (PID " + occupant + ") remplace.");
                    portOccupe = false;
                }
                catch (Exception ex)
                {
                    Ajouter("[app] Daemon orphelin non remplacable : " + ex.Message);
                }
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

            // Le daemon annonce lui-même le conflit de port : on s'en sert pour
            // proposer le déblocage plutôt que de laisser l'app muette et inerte.
            if (ligne.IndexOf("EADDRINUSE", StringComparison.OrdinalIgnoreCase) >= 0 ||
                ligne.IndexOf("déjà utilisé", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                portOccupe = true;
                if (ui != null) ui.Post(_ => Rafraichir(), null);
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

            // Conflit de port : proposer le déblocage, avec le nom du processus
            // fautif. Sans ça l'app reste inerte sans que rien n'explique pourquoi.
            if (portOccupe && !actif)
            {
                var forcer = new ToolStripMenuItem("⚠  Libérer le port " + PORT + " et démarrer");
                forcer.Font = new Font(forcer.Font, FontStyle.Bold);
                forcer.Click += (s, e) => DemarrageForce();
                menu.Items.Add(forcer);
                menu.Items.Add(new ToolStripSeparator());
            }

            var redem = new ToolStripMenuItem("Redémarrer le serveur");
            redem.Enabled = !redemarrage;
            redem.Click += (s, e) => Redemarrer();
            menu.Items.Add(redem);

            var cons = new ToolStripMenuItem(nbErreurs > 0
                ? "Console  (" + nbErreurs + " erreur" + (nbErreurs > 1 ? "s" : "") + ")"
                : "Console");
            cons.Click += (s, e) => OuvrirConsole();
            menu.Items.Add(cons);

            // Mise à jour : n'apparaît que s'il y a réellement quelque chose de neuf
            if (majDispo != null)
            {
                menu.Items.Add(new ToolStripSeparator());
                if (majEnCours)
                {
                    menu.Items.Add(Inerte("⏳  Téléchargement…"));
                }
                else
                {
                    var maj = new ToolStripMenuItem("⬆  Installer la version " + Court(majDispo.Version));
                    maj.Font = new Font(maj.Font, FontStyle.Bold);
                    maj.Click += (s, e) => InstallerMaj();
                    menu.Items.Add(maj);
                }
            }

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
            portOccupe = false;
            Rafraichir();

            Ajouter("[app] Redémarrage du serveur demandé.");
            ArreterNode();
            adresse = null;
            lectureNom = null;
            DemarrerNode();

            redemarrage = false;
            Rafraichir();
        }

        // Tue le processus qui retient le port, puis relance. On demande toujours
        // confirmation en nommant le coupable : ce peut être un daemon lancé à la
        // main dans un terminal, mais aussi tout autre logiciel.
        void DemarrageForce()
        {
            int pid = Port.Occupant(PORT);

            if (pid == 0)
            {
                // Plus personne dessus : le conflit s'est résolu seul entre-temps
                Ajouter("[app] Le port " + PORT + " est libre, redémarrage direct.");
                Redemarrer();
                return;
            }

            if (pid == Process.GetCurrentProcess().Id ||
                (node != null && !node.HasExited && pid == node.Id))
            {
                Ajouter("[app] Le port est tenu par notre propre daemon, simple redémarrage.");
                Redemarrer();
                return;
            }

            string nom = Port.Nom(pid);
            string ligne = Port.LigneDeCommande(pid);
            if (!string.IsNullOrEmpty(ligne) && ligne.Length > 110) ligne = ligne.Substring(0, 109) + "…";

            var choix = MessageBox.Show(
                "Le port " + PORT + " est utilisé par :\n\n" +
                "    " + nom + "  (PID " + pid + ")\n" +
                (string.IsNullOrEmpty(ligne) ? "" : "    " + ligne + "\n") +
                "\nFermer ce processus et démarrer le serveur re:cast ?",
                "re:cast — port occupé",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);

            if (choix != DialogResult.OK) return;

            try
            {
                var p = Process.GetProcessById(pid);
                p.Kill();
                p.WaitForExit(5000);
                Ajouter("[app] Processus " + nom + " (PID " + pid + ") fermé, le port est libre.");
            }
            catch (Exception ex)
            {
                Ajouter("[app] Impossible de fermer " + nom + " : " + ex.Message);
                MessageBox.Show(
                    "Impossible de fermer ce processus :\n\n" + ex.Message +
                    "\n\nIl appartient peut-être à un autre utilisateur, ou nécessite " +
                    "des droits administrateur.",
                    "re:cast", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Redemarrer();
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

        // ─── Mise à jour ──────────────────────────────────────────────────────

        void ChercherMaj()
        {
            System.Threading.ThreadPool.QueueUserWorkItem(_ =>
            {
                var info = MiseAJour.Chercher(MiseAJour.Courante());
                if (info == null) return;
                ui.Post(__ =>
                {
                    if (majDispo != null && majDispo.Version >= info.Version) return;
                    majDispo = info;
                    Ajouter("[app] Mise à jour disponible : " + Court(info.Version));
                    Rafraichir();
                    try
                    {
                        icone.BalloonTipTitle = "re:cast";
                        icone.BalloonTipText = "Version " + Court(info.Version) + " disponible";
                        icone.ShowBalloonTip(5000);
                    }
                    catch { }
                }, null);
            });
        }

        void InstallerMaj()
        {
            if (majDispo == null || majEnCours) return;
            majEnCours = true;
            Rafraichir();

            var info = majDispo;
            Ajouter("[app] Téléchargement de la mise à jour…");

            System.Threading.ThreadPool.QueueUserWorkItem(_ =>
            {
                string fichier = MiseAJour.Telecharger(info);
                ui.Post(__ =>
                {
                    majEnCours = false;

                    if (fichier == null)
                    {
                        // Empreinte fausse ou téléchargement interrompu : on ne lance rien.
                        Ajouter("[app] Mise à jour abandonnée : téléchargement ou empreinte invalide.");
                        MessageBox.Show(
                            "Le téléchargement a échoué, ou l'empreinte du fichier ne correspond pas.\n\n" +
                            "Rien n'a été installé.",
                            "re:cast", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        Rafraichir();
                        return;
                    }

                    // L'installateur remplace des fichiers que cette app utilise :
                    // il faut donc quitter. On demande avant, plutôt que de fermer
                    // le serveur sous les pieds d'une lecture en cours.
                    string enCours = string.IsNullOrEmpty(lectureNom)
                        ? ""
                        : "\n\nUne lecture est en cours sur " + lectureNom + " : elle sera interrompue.";

                    var choix = MessageBox.Show(
                        "La version " + Court(info.Version) + " est prête à être installée.\n\n" +
                        "re:cast va se fermer pendant l'installation, puis redémarrer." + enCours,
                        "re:cast — mise à jour",
                        MessageBoxButtons.OKCancel, MessageBoxIcon.Information);

                    if (choix != DialogResult.OK) { Rafraichir(); return; }

                    try
                    {
                        // /SILENT : garder une barre de progression, sans questions.
                        // L'app se relance seule grâce au postinstall du script.
                        Process.Start(new ProcessStartInfo(fichier, "/SILENT /NOCANCEL")
                        {
                            UseShellExecute = true
                        });
                    }
                    catch (Exception ex)
                    {
                        Ajouter("[app] Lancement de l'installateur impossible : " + ex.Message);
                        Rafraichir();
                        return;
                    }

                    Quitter();
                }, null);
            });
        }

        static string Court(Version v)
        {
            return v.Major + "." + v.Minor + "." + v.Build;
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
