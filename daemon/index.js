// re:cast daemon - index.js
// Point d'entrée : démarre le serveur HTTP local sur localhost:7171

const server     = require('./server');
const discovery  = require('./discovery');
const dlna       = require('./cast/dlna');
const chromecast = require('./cast/chromecast');
const airplay    = require('./cast/airplay');

const SCANNERS = [chromecast, dlna, airplay];

const PORT = 7171;

// Écouter sur toutes les interfaces — nécessaire pour que la TV puisse atteindre le proxy
// `server` est l'app Express : c'est l'objet retourné par listen() qui émet 'error',
// pas l'app elle-même. S'abonner sur l'app ne déclenchait jamais rien.
const httpServer = server.listen(PORT, '0.0.0.0', async () => {
  // Détermine l'interface de sortie par défaut avant tout affichage
  await discovery.resolvePreferred();
  const localIp = logInterfaces();
  console.log(`[re:cast] Daemon démarré sur http://localhost:${PORT}`);
  console.log(`[re:cast] Accessible sur le réseau local : http://${localIp}:${PORT}`);
  console.log('[re:cast] En attente de commandes depuis l\'extension Firefox...');

  // Découverte initiale au démarrage — peuple le cache avant la première requête
  console.log('[re:cast] Scan réseau initial...');
  try {
    const results = await Promise.all(SCANNERS.map(m => m.discover().catch(() => [])));
    const all = results.flat();
    if (all.length) {
      console.log(`[re:cast] ${all.length} appareil(s) mis en cache:`, all.map(d => d.name));
    } else {
      console.log('[re:cast] Aucun appareil trouvé au démarrage (normal, réessayez via l\'extension)');
    }
  } catch {}

  // Re-scan toutes les 60s pour garder le cache à jour.
  // Le cache n'oublie jamais un appareil : un appareil vu une fois reste listé
  // jusqu'au redémarrage du daemon, et l'extension le garde en local au-delà.
  setInterval(async () => {
    try {
      await Promise.all(SCANNERS.map(m => m.discover().catch(() => {})));
    } catch {}
  }, 60000);
});

// Plus de liste noire d'adaptateurs virtuels : elle était forcément incomplète
// (« vEthernet (Default Switch) » d'Hyper-V passait pour une interface réelle).
// L'IP réellement annoncée à un appareil est choisie par sous-réseau au moment du
// cast, dans discovery.localIpFor() — ce qui suit n'est qu'un affichage indicatif.
function logInterfaces() {
  const ifs = discovery.interfaces();
  console.log('[re:cast] Interfaces réseau disponibles:');
  ifs.forEach(i => console.log(`  ${i.address.padEnd(16)} ${i.name}`));
  console.log('[re:cast] La découverte interroge TOUTES ces interfaces.');
  return discovery.localIpFor();
}

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[re:cast] ERREUR: Le port ${PORT} est déjà utilisé.`);
    console.error('[re:cast] Un autre daemon est peut-être déjà en cours d\'exécution.');
  } else {
    console.error('[re:cast] ERREUR serveur:', err.message);
  }
  process.exit(1);
});

// ─── Garde-fou : ne jamais mourir sur une erreur de librairie ─────────────────
// Les librairies UPnP/mDNS parsent du XML fourni par la TV et lèvent parfois depuis
// un callback interne : l'exception échappe alors aux try/catch des modules de cast.
// Si on laissait le processus mourir, on perdrait le proxy (donc la lecture en cours)
// et tout le cache d'appareils. On log et on continue.
//
// Les erreurs fatales de démarrage doivent en revanche rester fatales : elles sont
// traitées au-dessus, sur httpServer, avant d'arriver ici.
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[re:cast] ERREUR: Le port ${PORT} est déjà utilisé.`);
    process.exit(1);
  }
  console.error('[re:cast] Exception non gérée (ignorée):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[re:cast] Rejet non géré (ignoré):', reason?.message || reason);
});
