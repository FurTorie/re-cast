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

        static int Parent(int pid)
        {
            try
            {
                using (var chercheur = new System.Management.ManagementObjectSearcher(
                    "SELECT ParentProcessId FROM Win32_Process WHERE ProcessId = " + pid))
                using (var resultats = chercheur.Get())
                {
                    foreach (System.Management.ManagementObject o in resultats)
                    {
                        var v = o["ParentProcessId"];
                        if (v != null) return Convert.ToInt32(v);
                    }
                }
            }
            catch { }
            return 0;
        }

        // VRAI orphelin : un daemon re:cast dont le processus parent n'existe plus.
        // La distinction est essentielle. Un daemon lance a la main depuis un
        // terminal a un parent bien vivant : le tuer en silence serait hostile,
        // c'est un choix delibere de l'utilisateur. Seul celui dont le parent a
        // disparu — typiquement notre app tuee de force — est a remplacer.
        public static bool EstOrphelin(int pid)
        {
            if (!EstNotreDaemon(pid)) return false;

            int parent = Parent(pid);
            if (parent == 0) return true;

            try
            {
                var p = Process.GetProcessById(parent);
                return p.HasExited;
            }
            catch { return true; }   // parent introuvable donc disparu
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
        // On interroge l'API GitHub, pas raw.githubusercontent.com.
        //
        // raw sert ses fichiers derriere un CDN avec Cache-Control: max-age=300 :
        // pendant cinq minutes apres une publication, il renvoie encore l'ancienne
        // version, et une verification manuelle repondait « a jour » alors qu'une
        // mise a jour venait de sortir. Un parametre anti-cache n'y change rien,
        // le cache est partage, pas local.
        //
        // L'API, elle, plafonne a 60 s et honore la revalidation. Sa limite de
        // 60 requetes par heure est sans risque ici : quatre verifications
        // automatiques par jour, plus les clics occasionnels.
        const string MANIFESTE = "https://api.github.com/repos/FurTorie/re-cast/contents/app-latest.json";
        const string PREFIXE_AUTORISE = "https://github.com/FurTorie/re-cast/releases/download/";

        public class Info
        {
            public Version Version;
            public string Url;
            public string Sha256;
        }

        // Retourne null s'il n'y a rien de plus recent, ou en cas d'echec. `erreur`
        // distingue les deux : la verification automatique s'en moque, la
        // verification manuelle doit pouvoir dire « a jour » plutot que rester muette.
        public static Info Chercher(Version courante, out bool erreur)
        {
            erreur = false;
            try
            {
                ServicePointManager.SecurityProtocol =
                    SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; // 12288 = Tls13

                string json;
                using (var wc = new WebClient())
                {
                    wc.Encoding = Encoding.UTF8;
                    // User-Agent obligatoire sur l'API GitHub
                    wc.Headers.Add("User-Agent", "recast-app");
                    // Sans cet Accept, l'API renvoie une enveloppe JSON avec le
                    // contenu encode en base64 ; avec, on recoit le fichier tel quel.
                    wc.Headers.Add("Accept", "application/vnd.github.raw");
                    wc.Headers.Add("Cache-Control", "no-cache");
                    json = wc.DownloadString(MANIFESTE);
                }

                string v   = Champ(json, "version");
                string url = Champ(json, "url");
                string sha = Champ(json, "sha256");
                if (v == null || url == null) { erreur = true; return null; }

                Version distante;
                if (!Version.TryParse(v.Split('.').Length == 3 ? v + ".0" : v, out distante))
                {
                    erreur = true;
                    return null;
                }

                if (distante <= courante) return null;   // à jour, pas une erreur

                // URL hors du depot : c'est anormal, on le signale comme une erreur
                if (!url.StartsWith(PREFIXE_AUTORISE, StringComparison.OrdinalIgnoreCase))
                {
                    erreur = true;
                    return null;
                }

                return new Info { Version = distante, Url = url, Sha256 = sha };
            }
            catch { erreur = true; return null; }
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
        // 600 était trop court, et pas d'un peu : un cast écrit TROIS lignes par
        // segment, et un manifeste en compte couramment 143 — relus à chaque saut.
        // Une seule lecture évinçait donc tout ce qui l'a précédée, y compris le
        // démarrage et les versions, c'est-à-dire précisément ce qu'on veut lire
        // dans un rapport de bug. 2000 lignes tiennent un cast entier pour ~200 Ko,
        // sans rien changer d'observable à l'empreinte de l'app.
        const int MAX_LIGNES = 2000;
        const int SONDAGE_REPOS = 10000;     // au repos, rien ne change vite
        const int SONDAGE_LECTURE = 3000;    // pendant une lecture, on veut voir l'arrêt rapidement

        readonly NotifyIcon icone;
        readonly Timer sondage;

        // UN SEUL ContextMenuStrip pour toute la vie de l'app. Le remplacer à chaque
        // rafraîchissement obligeait à libérer l'ancien, et le libérer depuis le
        // gestionnaire de clic d'un de ses items détruisait l'objet que WinForms
        // était encore en train d'utiliser pour refermer le menu.
        // Seuls les items sont recréés : le conteneur, lui, ne bouge jamais.
        readonly ContextMenuStrip menu = new ContextMenuStrip();
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
        DateTime? derniereVerif;    // affiché dans le menu : le journal, lui, défile
        bool derniereVerifOk;
        bool portOccupe;         // le daemon a refusé de démarrer, port déjà pris
        string versionDaemon;    // lues dans /status, pour les rapports de bug
        string versionExtension;
        DateTime nodeDemarreA;   // pour distinguer « démarre » de « arrêté »
        string dernierEtat = ""; // évite de reconstruire le menu à chaque sondage

        // « Le serveur répond » et « c'est le nôtre qui répond » sont deux choses
        // différentes : quand un autre programme tient le port, /status répond
        // parfaitement et l'app croyait à tort que tout allait bien.
        bool NotreDaemonTourne
        {
            get { return node != null && !node.HasExited; }
        }

        // Le daemon met quelques secondes à écouter. Sans cet état, le menu affichait
        // « Serveur arrêté » pendant tout ce temps, ce qui est faux et inquiétant.
        bool DemarrageEnCours
        {
            get
            {
                return adresse == null
                    && NotreDaemonTourne
                    && (DateTime.Now - nodeDemarreA).TotalSeconds < 30;
            }
        }

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
            icone.ContextMenuStrip = menu;   // attaché une fois pour toutes

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
            // D'abord le .ico multi-tailles : on demande la taille que Windows
            // affichera réellement, et il y prend l'entrée composée pour elle.
            // Avant, on partait du PNG et Windows réduisait un 256 px jusqu'en
            // 16 px — d'où une icône de barre des tâches floue, quelle que soit
            // la finesse de l'original.
            try
            {
                string ico = Path.Combine(DossierApp(), "icon.ico");
                if (File.Exists(ico))
                    using (var i = new Icon(ico, SystemInformation.SmallIconSize))
                        return (Icon)i.Clone();
            }
            catch { }

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

            // Un daemon re:cast ORPHELIN — parent disparu — garde le port : cas
            // courant apres un arret force. Celui-la, on le remplace sans rien
            // demander. En revanche un daemon lance a la main depuis un terminal a
            // un parent vivant : c'est un choix delibere, on n'y touche pas et le
            // menu proposera de liberer le port.
            int occupant = Port.Occupant(PORT);
            if (occupant != 0 && Port.EstOrphelin(occupant))
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
                nodeDemarreA = DateTime.Now;
                node.BeginOutputReadLine();
                node.BeginErrorReadLine();
                Ajouter("[app] Daemon lancé : " + script);

                // Sondage rapide le temps du démarrage, pour basculer sur « actif »
                // dès que le serveur répond plutôt que d'attendre le cycle suivant.
                if (sondage != null) sondage.Interval = 1000;
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

                // Personne ne répond : le port est-il malgré tout retenu ? netstat
                // n'est appelé que dans ce cas rare, jamais en fonctionnement normal.
                if (!NotreDaemonTourne) portOccupe = Port.Occupant(PORT) != 0;

                // Pendant le démarrage on sonde vite ; une fois la fenêtre écoulée,
                // inutile d'interroger un serveur manifestement absent chaque seconde.
                sondage.Interval = DemarrageEnCours ? 1000 : SONDAGE_REPOS;
                SignalerChangementEtat();
                return;
            }

            // Quelqu'un répond. Si ce n'est pas notre processus, c'est qu'un autre
            // programme tient le port — il faut proposer de le libérer, pas afficher
            // « serveur actif » comme si tout allait bien.
            portOccupe = !NotreDaemonTourne;

            // Le corps est produit par notre propre serveur : une extraction ciblée
            // suffit et évite d'embarquer un analyseur JSON.
            string nom   = Extraire(reponse, "\"deviceName\"\\s*:\\s*\"([^\"]*)\"");
            string proto = Extraire(reponse, "\"protocole\"\\s*:\\s*\"([^\"]*)\"");
            string ip    = Extraire(reponse, "\"ip\"\\s*:\\s*\"([^\"]*)\"");

            // Versions des deux autres moitiés, annoncées par le daemon. Sans ça, un
            // rapport de bug ne dit pas ce qui tournait, et on ne peut pas savoir si
            // le problème est déjà corrigé.
            string vd = Extraire(reponse, "\"version\"\\s*:\\s*\"([^\"]*)\"");
            string ve = Extraire(reponse, "\"extension\"\\s*:\\s*\"([^\"]*)\"");
            if (vd != null && vd != versionDaemon)
            {
                versionDaemon = vd;
                Ajouter("[app] ═══ daemon " + vd + " ═══");
            }
            if (ve != null && ve != versionExtension)
            {
                versionExtension = ve;
                Ajouter("[app] ═══ extension " + ve + " ═══");
            }

            // L'adresse vient désormais du serveur lui-même. Avant, on la relisait
            // dans les logs et on retombait sur « localhost » quand ils n'étaient pas
            // les nôtres — adresse inutilisable depuis le téléphone.
            string nouvelleAdresse = !string.IsNullOrEmpty(ip)
                ? ip + ":" + PORT
                : (LireAdresseDuJournal() ?? adresse);

            bool change = (nom != lectureNom) || (proto != lectureProto)
                       || (nouvelleAdresse != adresse);
            lectureNom = nom;
            lectureProto = proto;
            adresse = nouvelleAdresse;

            // Cadence adaptée : rapide pendant une lecture, lente au repos
            int voulu = string.IsNullOrEmpty(lectureNom) ? SONDAGE_REPOS : SONDAGE_LECTURE;
            if (sondage.Interval != voulu) sondage.Interval = voulu;

            if (change) Rafraichir();
        }

        // Le passage de « démarre » à « arrêté » n'est déclenché par aucun événement :
        // c'est un simple délai qui s'écoule. On surveille donc l'état calculé.
        void SignalerChangementEtat()
        {
            string etat = DemarrageEnCours ? "demarrage"
                        : adresse != null   ? (NotreDaemonTourne ? "actif" : "usurpe")
                        : portOccupe        ? "occupe"
                                            : "arrete";

            // L'âge de la dernière vérification fait partie de la signature, sinon
            // « il y a 3 min » resterait figé tant que rien d'autre ne bouge — et
            // un menu qui ment sur la fraîcheur est pire que pas d'indication.
            etat += "|" + EtatVerif();

            if (etat == dernierEtat) return;
            dernierEtat = etat;
            Rafraichir();
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
            string entree;
            lock (verrou)
            {
                entree = DateTime.Now.ToString("HH:mm:ss") + "  " + ligne;
                journal.Add(entree);
                if (journal.Count > MAX_LIGNES) journal.RemoveAt(0);
                // Même piège que dans CouleurDe() : « Error » cherché en sous-chaîne
                // comptait « prone to errors » comme une erreur, et le compteur du
                // menu montait tout seul. Un avertissement Node n'est pas une erreur ;
                // une vraie erreur .NET s'écrit toujours « QuelqueChoseError: ».
                bool avertissement = ligne.Contains("Warning:") || ligne.Contains("(Use `node");
                if (!avertissement &&
                    (ligne.IndexOf("ERREUR",  StringComparison.OrdinalIgnoreCase) >= 0 ||
                     ligne.IndexOf("Error:",  StringComparison.OrdinalIgnoreCase) >= 0 ||
                     ligne.IndexOf("échec",   StringComparison.OrdinalIgnoreCase) >= 0))
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

            // BeginInvoke lève tant que le handle de la fenêtre n'existe pas. Le daemon
            // écrit en rafale au démarrage, depuis un thread de fond : ouvrir la console
            // pile à ce moment faisait planter l'app. On vérifie donc IsHandleCreated,
            // et on passe la ligne par valeur — relire journal[Count-1] plus tard, sur
            // un autre thread, ne renverrait pas forcément la bonne.
            var c = console;
            if (c != null && !c.IsDisposed && c.IsHandleCreated)
            {
                try { c.BeginInvoke((Action)(() => c.Ajouter(entree))); } catch { }
            }
        }

        public string[] Journal()
        {
            lock (verrou) return journal.ToArray();
        }

        // Rapport de bug prêt à coller : les versions des trois moitiés en tête, puis
        // le journal. Sans l'en-tête, impossible de dire si un log porte sur du code
        // déjà corrigé — c'est la première question devant un rapport.
        public string Rapport()
        {
            var b = new StringBuilder();
            b.AppendLine("═══ re:cast — rapport ═══");
            b.AppendLine("date       : " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            b.AppendLine("app        : " + Court(MiseAJour.Courante()));
            b.AppendLine("daemon     : " + (versionDaemon ?? "inconnu (serveur jamais joint)"));
            b.AppendLine("extension  : " + (versionExtension ?? "inconnue (jamais connectée)"));
            b.AppendLine("Windows    : " + Environment.OSVersion.Version + " " + (Environment.Is64BitOperatingSystem ? "64 bits" : "32 bits"));
            b.AppendLine("adresse    : " + (adresse ?? "—"));
            b.AppendLine("lecture    : " + (string.IsNullOrEmpty(lectureNom) ? "aucune" : lectureNom + " (" + lectureProto + ")"));
            b.AppendLine("erreurs    : " + nbErreurs);
            b.AppendLine();
            b.AppendLine("═══ journal ═══");
            foreach (string l in Journal()) b.AppendLine(l);
            return b.ToString();
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

        // Toujours différé au tour de boucle suivant. Reconstruire le menu depuis le
        // gestionnaire de clic d'un de ses items revient à le modifier pendant que
        // WinForms s'en sert encore — c'est ce qui provoquait une
        // ObjectDisposedException au retour du clic.
        void Rafraichir()
        {
            if (ui != null) ui.Post(_ => ConstruireMenu(), null);
            else ConstruireMenu();
        }

        void ConstruireMenu()
        {
            // Libérer les items précédents, jamais le conteneur
            var anciens = new ToolStripItem[menu.Items.Count];
            menu.Items.CopyTo(anciens, 0);
            menu.Items.Clear();
            foreach (var it in anciens) { try { it.Dispose(); } catch { } }

            bool actif = adresse != null;

            bool notreDaemon = NotreDaemonTourne;

            // Statut
            menu.Items.Add(Inerte(
                  redemarrage                  ? "⏳  Redémarrage…"
                : actif && notreDaemon         ? "●  Serveur actif"
                : actif && !notreDaemon        ? "⚠  Port " + PORT + " tenu par un autre programme"
                : DemarrageEnCours             ? "⏳  Démarrage du serveur…"
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

            // Conflit de port : proposer le déblocage dès que ce n'est pas NOTRE
            // daemon qui occupe la place. Le test portait avant sur « le serveur ne
            // répond pas », donc le bouton n'apparaissait jamais quand un autre
            // programme répondait à sa place — précisément le cas à traiter.
            if (portOccupe && !notreDaemon)
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

            var verif = new ToolStripMenuItem("Vérifier les mises à jour");
            verif.Enabled = !majEnCours;
            verif.Click += (s, e) => ChercherMaj(true);
            menu.Items.Add(verif);

            // Le résultat de la vérification était journalisé, et uniquement là.
            // Le journal est un tampon glissant de MAX_LIGNES, et un seul cast écrit
            // trois lignes par segment — 143 segments, relus à chaque saut. La ligne
            // « Vérification (automatique) » était donc évincée en quelques minutes,
            // ce qui donnait l'impression que la vérification n'avait jamais lieu.
            // Ici, elle ne peut pas défiler.
            menu.Items.Add(Inerte("     version " + Court(MiseAJour.Courante())
                                  + " · " + EtatVerif()));

            menu.Items.Add(new ToolStripSeparator());

            var quitter = new ToolStripMenuItem("Quitter");
            quitter.Click += (s, e) => Quitter();
            menu.Items.Add(quitter);

            icone.Text = !string.IsNullOrEmpty(lectureNom)
                ? Tronquer("re:cast — " + lectureNom, 63)
                : actif ? Tronquer("re:cast — " + adresse, 63) : "re:cast — arrêté";
        }

        static ToolStripMenuItem Inerte(string texte)
        {
            return new ToolStripMenuItem(texte) { Enabled = false };
        }

        // « jamais vérifié » n'est pas un détail : c'est ce qui distingue une
        // vérification qui n'a pas encore eu lieu d'une vérification muette parce
        // que tout va bien. Sans cette nuance, les deux se ressemblent.
        string EtatVerif()
        {
            if (majEnCours)              return "vérification…";
            if (!derniereVerif.HasValue) return "jamais vérifié";

            var age = DateTime.Now - derniereVerif.Value;
            string quand = age.TotalMinutes < 1  ? "à l'instant"
                         : age.TotalMinutes < 60 ? "il y a " + (int)age.TotalMinutes + " min"
                         : age.TotalHours   < 24 ? "il y a " + (int)age.TotalHours + " h"
                                                 : "il y a " + (int)age.TotalDays + " j";

            return (derniereVerifOk ? "vérifié " : "échec, ") + quand;
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

        // `manuel` : déclenché par le menu, donc il faut répondre quelque chose même
        // quand tout va bien. En automatique on reste silencieux.
        void ChercherMaj(bool manuel = false)
        {
            // Journalisé même en automatique : sans trace, impossible de savoir si la
            // vérification a lieu. C'est ce qui donnait l'impression qu'elle n'existait
            // qu'en manuel.
            Ajouter("[app] Vérification des mises à jour" + (manuel ? " (manuelle)…" : " (automatique)…"));

            ThreadPool.QueueUserWorkItem(_ =>
            {
                bool erreur;
                var info = MiseAJour.Chercher(MiseAJour.Courante(), out erreur);

                Post(() =>
                {
                    derniereVerif   = DateTime.Now;
                    derniereVerifOk = !erreur;

                    if (info == null)
                    {
                        Ajouter(erreur
                            ? "[app] Vérification impossible (réseau ou API GitHub)."
                            : "[app] À jour — version " + Court(MiseAJour.Courante()) + ".");

                        // Le menu porte désormais l'état : il doit suivre même quand
                        // la vérification est automatique et sans nouvelle.
                        Rafraichir();

                        if (!manuel) return;

                        if (erreur)
                        {
                            Ajouter("[app] Vérification des mises à jour : échec.");
                            MessageBox.Show(
                                "Impossible de vérifier les mises à jour.\n\n" +
                                "Vérifiez votre connexion, puis réessayez.",
                                "re:cast", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        }
                        else
                        {
                            MessageBox.Show(
                                "re:cast est à jour.\n\nVersion installée : " +
                                Court(MiseAJour.Courante()),
                                "re:cast", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        }
                        return;
                    }

                    bool nouveau = majDispo == null || majDispo.Version < info.Version;
                    majDispo = info;
                    if (nouveau) Ajouter("[app] Mise à jour disponible : " + Court(info.Version));
                    Rafraichir();

                    if (manuel)
                    {
                        InstallerMaj();
                    }
                    else if (nouveau)
                    {
                        try
                        {
                            icone.BalloonTipTitle = "re:cast";
                            icone.BalloonTipText = "Version " + Court(info.Version) + " disponible";
                            icone.ShowBalloonTip(5000);
                        }
                        catch { }
                    }
                });
            });
        }

        // Repasser sur le thread d'interface. SynchronizationContext.Current peut être
        // null au moment de sa capture — aucun handle de fenêtre n'existe encore — et
        // un ui.Post sur null lèverait une NullReferenceException depuis un thread de
        // fond, ce qui tue le processus sans rien afficher.
        void Post(Action action)
        {
            if (ui != null) ui.Post(_ => action(), null);
            else action();
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
                Post(() =>
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
                });
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
        readonly RichTextBox zone;   // RichTextBox et non TextBox : lui seul colore

        public ConsoleForm(TrayApp app)
        {
            this.app = app;

            Text = "re:cast — console";
            Width = 980;
            Height = 600;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(26, 26, 46);

            zone = new RichTextBox
            {
                ReadOnly = true,
                WordWrap = false,
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(22, 33, 62),
                ForeColor = Color.FromArgb(205, 210, 225),
                Font = new Font("Consolas", 9f),
                BorderStyle = BorderStyle.None,
                DetectUrls = false,
                ScrollBars = RichTextBoxScrollBars.Both
            };

            var barre = new Panel { Dock = DockStyle.Bottom, Height = 40, BackColor = Color.FromArgb(26, 26, 46) };

            // Le bouton qui compte pour un rapport de bug : versions en tête, log
            // ensuite. Sans les versions, un log ne dit pas s'il porte sur du code
            // déjà corrigé.
            barre.Controls.Add(Bouton("Copier le rapport", 10, 150, (s, e) =>
            {
                try { Clipboard.SetText(app.Rapport()); } catch { }
            }));
            barre.Controls.Add(Bouton("Copier le log", 170, 120, (s, e) =>
            {
                try { Clipboard.SetText(zone.Text); } catch { }
            }));
            barre.Controls.Add(Bouton("Vider", 300, 90, (s, e) =>
            {
                app.ViderJournal();
                zone.Clear();
            }));

            Controls.Add(zone);
            Controls.Add(barre);
        }

        // Le remplissage attend que la fenêtre existe : ScrollToCaret() sur un
        // contrôle sans handle n'a pas de sens, et c'est aussi le moment où
        // BeginInvoke devient utilisable pour les lignes qui arrivent ensuite.
        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            zone.SuspendLayout();
            foreach (string l in app.Journal()) Ajouter(l);
            zone.ResumeLayout();
        }

        Button Bouton(string texte, int x, int largeur, EventHandler action)
        {
            var b = new Button
            {
                Text = texte,
                Left = x,
                Top = 7,
                Width = largeur,
                Height = 26,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(15, 52, 96),
                ForeColor = Color.White
            };
            b.FlatAppearance.BorderSize = 0;
            b.Click += action;
            return b;
        }

        // La couleur porte le niveau de gravité : on repère une erreur au milieu de
        // centaines de lignes sans les lire. Les requêtes entrantes ont leur teinte
        // propre, car les distinguer des requêtes sortantes est le premier réflexe
        // de diagnostic.
        static Color CouleurDe(string ligne)
        {
            // Testé AVANT le rouge, et c'est tout l'intérêt. Un avertissement de Node
            // n'est pas une erreur, mais le DeprecationWarning de url.parse() sortait
            // en rouge à chaque cast : le test rouge cherche « error », que son texte
            // contient dans « prone to errors ». Même piège pour tout avertissement
            // à venir, d'où un test sur la forme (« …Warning: ») plutôt que sur ce
            // cas précis. Un repli qui réussit et une origine refusée relèvent de la
            // même nuance : ça mérite l'œil, pas l'alarme.
            if (ligne.Contains("Warning:") || ligne.Contains("(Use `node")
             || ligne.Contains("fallback")  || ligne.Contains("Origine refusée"))
                return Color.FromArgb(232, 178, 104);                    // orange : avertissement

            if (ligne.Contains("⚠") || ligne.IndexOf("ERREUR", StringComparison.OrdinalIgnoreCase) >= 0
                                     || ligne.IndexOf("Error", StringComparison.OrdinalIgnoreCase) >= 0
                                     || ligne.IndexOf("échec", StringComparison.OrdinalIgnoreCase) >= 0
                                     || ligne.IndexOf("impossible", StringComparison.OrdinalIgnoreCase) >= 0)
                return Color.FromArgb(255, 105, 97);                      // rouge

            if (ligne.Contains("═══"))          return Color.FromArgb(255, 214, 102);  // jaune : versions
            if (ligne.Contains("← "))           return Color.FromArgb(120, 220, 232);  // cyan : entrant
            if (ligne.Contains("Segment (") ||
                ligne.Contains("Fetch ("))      return Color.FromArgb(150, 190, 255);  // bleu : sortant
            if (ligne.Contains("[app]"))        return Color.FromArgb(150, 155, 175);  // gris : app

            if (ligne.IndexOf("démarré", StringComparison.OrdinalIgnoreCase) >= 0
             || ligne.IndexOf("découvert", StringComparison.OrdinalIgnoreCase) >= 0
             || ligne.IndexOf("lecture démarrée", StringComparison.OrdinalIgnoreCase) >= 0)
                return Color.FromArgb(126, 217, 138);                     // vert : succès

            if (ligne.Contains("Client parti") || ligne.Contains("cache"))
                return Color.FromArgb(190, 170, 220);                     // violet : nuance

            return zoneDefaut;
        }

        static readonly Color zoneDefaut = Color.FromArgb(205, 210, 225);

        public void Ajouter(string ligne)
        {
            // L'heure reste toujours en gris : elle ne doit pas concurrencer le
            // message du regard.
            int coupe = (ligne.Length > 8 && ligne[2] == ':' && ligne[5] == ':') ? 8 : 0;

            if (coupe > 0)
            {
                Ecrire(ligne.Substring(0, coupe), Color.FromArgb(110, 115, 135));
                Ecrire(ligne.Substring(coupe) + Environment.NewLine, CouleurDe(ligne));
            }
            else
            {
                Ecrire(ligne + Environment.NewLine, CouleurDe(ligne));
            }

            zone.SelectionStart = zone.TextLength;
            zone.ScrollToCaret();
        }

        void Ecrire(string texte, Color couleur)
        {
            zone.SelectionStart = zone.TextLength;
            zone.SelectionLength = 0;
            zone.SelectionColor = couleur;
            zone.AppendText(texte);
            zone.SelectionColor = zone.ForeColor;
        }
    }
}
