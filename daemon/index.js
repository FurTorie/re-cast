// re:cast daemon - index.js
// Démarre le serveur HTTP local sur le port 7171.
//
// Ce module s'utilise de deux façons :
//   - en ligne de commande (`node index.js`), il démarre tout seul ;
//   - depuis l'app de bureau, qui appelle start() / stop() pour piloter le daemon
//     dans son propre processus, sans en lancer un second.

const server     = require('./server');
const discovery  = require('./discovery');
const dlna       = require('./cast/dlna');
const chromecast = require('./cast/chromecast');
const airplay    = require('./cast/airplay');

const SCANNERS = [chromecast, dlna, airplay];

const PORT = 7171;
const INTERVALLE_RESCAN = 60000;

let httpServer = null;
let timerRescan = null;
let gardesInstallees = false;

// ─── Démarrage / arrêt ────────────────────────────────────────────────────────

// Résout avec { port, localIp }. Rejette si le port est pris ou si l'écoute échoue :
// c'est à l'appelant de décider quoi en faire — la CLI sort, l'app affiche l'erreur.
function start({ port = PORT } = {}) {
  if (httpServer) return Promise.reject(new Error('Le daemon tourne déjà'));

  return new Promise((resolve, reject) => {
    let regle = false;
    const fini = (err, val) => {
      if (regle) return;
      regle = true;
      err ? reject(err) : resolve(val);
    };

    // `server` est l'app Express : c'est l'objet retourné par listen() qui émet
    // 'error', pas l'app elle-même. S'abonner sur l'app ne déclenche jamais rien.
    const s = server.listen(port, '0.0.0.0', async () => {
      httpServer = s;
      await discovery.resolvePreferred();
      const localIp = journaliserInterfaces();

      console.log(`[re:cast] Daemon démarré sur http://localhost:${port}`);
      console.log(`[re:cast] Accessible sur le réseau local : http://${localIp}:${port}`);
      console.log('[re:cast] En attente de commandes depuis l\'extension Firefox...');

      fini(null, { port, localIp });
      scanInitial();
    });

    s.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        err.message = `Le port ${port} est déjà utilisé — un autre daemon tourne peut-être.`;
      }
      httpServer = null;
      fini(err);
    });
  });
}

function stop() {
  clearInterval(timerRescan);
  timerRescan = null;

  return new Promise((resolve) => {
    if (!httpServer) return resolve();
    const s = httpServer;
    httpServer = null;
    // closeAllConnections évite d'attendre les flux en cours, qui peuvent durer
    // des heures : sans lui, un redémarrage resterait suspendu sur un cast actif.
    try { s.closeAllConnections?.(); } catch {}
    s.close(() => {
      console.log('[re:cast] Daemon arrêté.');
      resolve();
    });
  });
}

function enMarche() {
  return !!httpServer;
}

// ─── Découverte ───────────────────────────────────────────────────────────────

async function scanInitial() {
  console.log('[re:cast] Scan réseau initial...');
  try {
    const resultats = await Promise.all(SCANNERS.map(m => m.discover().catch(() => [])));
    const tous = resultats.flat();
    if (tous.length) {
      console.log(`[re:cast] ${tous.length} appareil(s) mis en cache:`, tous.map(d => d.name));
    } else {
      console.log('[re:cast] Aucun appareil trouvé au démarrage (normal, réessayez via l\'extension)');
    }
  } catch {}

  // Re-scan périodique. Le cache n'oublie jamais un appareil : un appareil vu une
  // fois reste listé jusqu'à l'arrêt du daemon, et l'extension le garde au-delà.
  clearInterval(timerRescan);
  timerRescan = setInterval(() => {
    Promise.all(SCANNERS.map(m => m.discover().catch(() => {}))).catch(() => {});
  }, INTERVALLE_RESCAN);
}

// Plus de liste noire d'adaptateurs virtuels : elle était forcément incomplète
// (« vEthernet (Default Switch) » d'Hyper-V passait pour une interface réelle).
// L'IP réellement annoncée à un appareil est choisie par sous-réseau au moment du
// cast, dans discovery.localIpFor() — ce qui suit n'est qu'un affichage indicatif.
function journaliserInterfaces() {
  const ifs = discovery.interfaces();
  console.log('[re:cast] Interfaces réseau disponibles:');
  ifs.forEach(i => console.log(`  ${i.address.padEnd(16)} ${i.name}`));
  console.log('[re:cast] La découverte interroge TOUTES ces interfaces.');
  return discovery.localIpFor();
}

// ─── Garde-fou : ne jamais mourir sur une erreur de librairie ─────────────────
// Les librairies UPnP/mDNS parsent du XML fourni par la TV et lèvent parfois depuis
// un callback interne : l'exception échappe alors aux try/catch des modules de cast.
// Si on laissait le processus mourir, on perdrait le proxy (donc la lecture en cours)
// et tout le cache d'appareils. On log et on continue.
//
// Ces gardes ne sortent JAMAIS du processus : l'app de bureau doit survivre à une
// erreur du daemon. Les échecs fatals de démarrage remontent par le rejet de start().
function installerGardes() {
  if (gardesInstallees) return;
  gardesInstallees = true;

  process.on('uncaughtException', (err) => {
    console.error('[re:cast] Exception non gérée (ignorée):', err.message);
  });

  process.on('unhandledRejection', (raison) => {
    console.error('[re:cast] Rejet non géré (ignoré):', raison?.message || raison);
  });
}

// ─── Démarrage direct en ligne de commande ────────────────────────────────────

if (require.main === module) {
  installerGardes();
  start().catch((err) => {
    console.error('[re:cast] ERREUR:', err.message);
    process.exit(1);
  });
}

module.exports = { start, stop, enMarche, installerGardes, PORT };
