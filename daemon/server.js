// re:cast daemon - server.js
// Serveur Express localhost:7171 - Étape 1

const express = require('express');
const cors = require('cors');
const chromecast = require('./cast/chromecast');
const dlna = require('./cast/dlna');
const airplay = require('./cast/airplay');
const { proxyHandler, streamHandler } = require('./proxy');
const state = require('./state');
const discovery = require('./discovery');

const app = express();

// Routage par préfixe d'ID d'appareil. Chaque module expose la même interface :
// discover / cached / has / resolveByHost / cast / stop
const MODULES = {
  'chromecast-': chromecast,
  'dlna-':       dlna,
  'airplay-':    airplay
};

function moduleFor(deviceId) {
  const prefix = Object.keys(MODULES).find(p => deviceId.startsWith(p));
  return prefix ? MODULES[prefix] : null;
}

const ALL = Object.values(MODULES);

const VERSION = require('./package.json').version;

// Version de l'extension, apprise à sa première requête. Elle n'apparaît nulle
// part ailleurs, et sans elle un rapport de bug ne dit pas quelle moitié tourne
// avec quelle version — impossible de savoir si c'est déjà corrigé.
let versionExtension = null;

app.use((req, res, next) => {
  const v = req.headers['x-recast-extension'];
  if (v && v !== versionExtension) {
    versionExtension = v;
    console.log(`[re:cast] ═══ extension ${v} connectée ═══`);
  }
  next();
});

// ─── Routes média ─────────────────────────────────────────────────────────────
// Déclarées AVANT la politique CORS stricte, et volontairement hors de son champ :
// le client n'est pas ici l'extension mais la TV ou le récepteur Chromecast. Ce
// dernier est une page web et envoie une origine googleusercontent.com, que la
// politique de l'API de contrôle rejetait — la lecture restait alors bloquée sans
// autre symptôme qu'une barre de chargement infinie.
function mediaCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin',   '*');
  res.setHeader('Access-Control-Allow-Methods',  'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Range, Accept-Encoding');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  // Chromecast fait un préflight OPTIONS avant ses requêtes Range
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// GET /stream/:id.mp4 - proxy HTTP, annoncé comme MP4 pour Samsung DLNA
app.options('/stream/:id', mediaCors);
app.get('/stream/:id', mediaCors, streamHandler);
app.get('/stream/:id.mp4', mediaCors, streamHandler);
// GET /proxy - proxy HTTP legacy (fallback)
app.options('/proxy', mediaCors);
app.get('/proxy', mediaCors, proxyHandler);

// ─── API de contrôle ──────────────────────────────────────────────────────────
// CORS restreint : seule l'extension doit pouvoir piloter le cast, pas un site
// quelconque visité par l'utilisateur. Les origines d'extension Firefox portent un
// UUID propre à chaque installation, d'où la regex plutôt qu'une liste blanche.
app.use(cors({
  origin: (origin, cb) => {
    // Autoriser: extensions Firefox, Chromium, et localhost
    if (!origin || /^(moz|chrome)-extension:\/\//.test(origin) || /^https?:\/\/localhost/.test(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS: origine non autorisée'));
    }
  },
  methods: ['GET', 'POST']
}));
app.use(express.json());

// GET /status - vérifier que le daemon tourne, et ce qu'il diffuse
// `ip` évite à l'app de bureau de deviner l'adresse LAN en relisant les logs :
// c'est celle à saisir dans l'extension, et elle n'apparaissait nulle part ailleurs.
app.get('/status', (req, res) => {
  res.json({
    // `app` sert de signature : l'app de bureau s'en sert pour reconnaître un
    // daemon re:cast lancé en dehors d'elle, et le traiter comme fonctionnel
    // plutôt que comme un programme tiers qui squatte le port.
    app:       're:cast',
    status:    'ok',
    version:   VERSION,
    extension: versionExtension,
    ip:        discovery.localIpFor(),
    lecture:   state.courant()
  });
});

// GET /devices - lister les appareils
// Par défaut : réponse IMMÉDIATE depuis le cache, pour ne pas imposer 4s d'attente
// à chaque ouverture de l'extension.
// ?scan=1 force une vraie découverte réseau (~4s) — c'est le bouton « Rechercher ».
// Cache vide : on scanne quand même, sinon on répondrait une liste vide au démarrage.
app.get('/devices', async (req, res) => {
  const wantScan = req.query.scan === '1' || req.query.scan === 'true';
  const known = ALL.flatMap(m => m.cached());

  if (!wantScan && known.length) {
    console.log(`[re:cast] /devices (cache): ${known.length} appareil(s)`);
    // Recherche relancée en tâche de fond : on ne fait pas attendre l'appelant,
    // mais un appareil allumé entre-temps sera là au prochain appel.
    ALL.forEach(m => m.ping());
    return res.json(known);
  }

  console.log(`[re:cast] Recherche des appareils${wantScan ? ' (scan demandé)' : ' (cache vide)'}...`);
  try {
    const results = await Promise.all(
      Object.entries(MODULES).map(([prefix, m]) =>
        m.discover().catch(e => {
          console.error(`[re:cast] ${prefix} discover error:`, e.message);
          return [];
        })
      )
    );
    const devices = results.flat();
    console.log(`[re:cast] ${devices.length} appareil(s) trouvé(s):`, devices.map(d => d.name));
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /cast - envoyer une URL à caster sur un appareil
// Body: { deviceId, streamUrl, referer, title, host, name }
// `host` est optionnel mais recommandé : l'extension garde ses appareils en local,
// elle peut donc demander un cast sur un appareil que le daemon a oublié (redémarrage).
// Dans ce cas on le reconstruit depuis son IP au lieu de renvoyer une erreur.
app.post('/cast', async (req, res) => {
  const { deviceId, streamUrl, referer, title, host, name } = req.body;

  if (!deviceId || !streamUrl) {
    return res.status(400).json({ error: 'deviceId et streamUrl requis' });
  }

  const mod = moduleFor(deviceId);
  if (!mod) return res.status(400).json({ error: 'Type d\'appareil inconnu' });

  console.log(`[re:cast] Cast demandé sur ${deviceId}: ${streamUrl}`);

  try {
    // Réhydrater l'appareil s'il n'est plus en cache
    let targetId = deviceId;
    if (!mod.has(deviceId)) {
      if (!host) {
        return res.status(409).json({
          error: 'Appareil inconnu du daemon et aucune IP fournie — relancez la recherche'
        });
      }
      targetId = await mod.resolveByHost(host, name);
    }

    await mod.cast({ deviceId: targetId, streamUrl, referer, title });
    state.demarre({ deviceId: targetId, deviceName: name, titre: title, url: streamUrl });
    res.json({ status: 'casting' });
  } catch (err) {
    console.error('[re:cast] Erreur cast:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/add - ajouter un appareil manuellement par IP (contourne SSDP)
// Body: { ip: "192.168.1.10", name: "Samsung Salon" }
app.post('/devices/add', async (req, res) => {
  const { ip, name } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip requis' });
  console.log(`[re:cast] Ajout manuel: ${name || ip} @ ${ip}`);
  try {
    const device = await dlna.addByIp(ip, name);
    res.json(device);
  } catch (err) {
    console.error('[re:cast] addByIp error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /stop - arrêter la lecture en cours
app.post('/stop', async (req, res) => {
  try {
    await Promise.all(ALL.map(m => m.stop().catch(() => {})));
    state.arrete();
    res.json({ status: 'stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Une origine refusée doit donner un 403 lisible, pas une stack trace complète
// répétée à chaque requête dans les logs.
app.use((err, req, res, _next) => {
  if (/CORS/.test(err.message)) {
    console.warn(`[re:cast] Origine refusée sur ${req.method} ${req.path}: ${req.headers.origin}`);
    return res.status(403).json({ error: err.message });
  }
  console.error('[re:cast] Erreur serveur:', err.message);
  res.status(500).json({ error: err.message });
});

module.exports = app;
