// re:cast - chromecast.js
// Découverte mDNS maison + cast via castv2-client en direct.
//
// Pourquoi ne plus passer par chromecast-api :
//  1. Ses sockets mDNS/SSDP ne sont pas configurables — sur une machine à plusieurs
//     interfaces la requête part sur un adaptateur virtuel (cf. discovery.js).
//  2. Son DefaultMediaReceiver réécrit le type HLS en 'video/mp2t', le type d'un
//     segment MPEG-TS et non celui d'une playlist : le récepteur tente alors de lire
//     le manifeste comme un flux binaire et échoue.
//  3. Il déduit le type via mime.getType() sur l'URL complète, query string comprise,
//     donc `master.m3u8?token=…` n'est pas reconnu et retombe sur 'video/mp4'.

const mdnsLib = require('multicast-dns');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const discovery = require('../discovery');
const { registerStream, guessContentType } = require('../proxy');

const CAST_PORT = 8009;
const SERVICE   = '_googlecast._tcp.local';

const deviceCache = {}; // id → { name, host, port }
let sockets = null;
let active  = null;     // { client, player } de la lecture en cours

function idFor(host) {
  return `chromecast-${host.replace(/\./g, '-')}`;
}

// ─── Découverte ───────────────────────────────────────────────────────────────

function cached() {
  return Object.entries(deviceCache).map(([id, d]) => ({
    id, name: d.name, type: 'Chromecast', host: d.host
  }));
}

// Un socket mDNS par interface — même raison que pour AirPlay et SSDP
function listen() {
  if (sockets) return sockets;

  sockets = discovery.interfaces().map(iface => {
    const m = mdnsLib({ interface: iface.address });
    m.on('error', (err) => console.error(`[re:cast] mDNS cast ${iface.address}: ${err.message}`));
    m.on('response', handleResponse);
    return m;
  });
  return sockets;
}

// Le SRV pointe vers un nom d'hôte `.local`, dont l'adresse arrive dans un
// enregistrement A — pas nécessairement dans le même paquet. On mémorise donc les
// adresses vues et les services en attente, au lieu d'exiger que tout arrive ensemble.
const hostIps = {};   // 'xxxx.local' → ip
const pending = {};   // 'xxxx.local' → { name, port }

// Nom d'instance mDNS → id en cache. C'est l'identité stable de l'appareil : elle
// ne dépend pas de l'interface par laquelle il a répondu, contrairement à son
// adresse. `hostIps` est justement écrasé par la dernière réponse reçue, si bien
// qu'une TV joignable par deux chemins se faisait enregistrer deux fois.
const identites = {};

// On part du SRV plutôt que du PTR : certains appareils répondent sans PTR, et le SRV
// porte déjà le nom de service, l'hôte et le port.
function handleResponse(response) {
  const all = response.answers.concat(response.additionals || []);

  // 1. Mémoriser toute adresse vue, quelle que soit la requête d'origine
  all.forEach(a => {
    if (a.type === 'A' && a.name && typeof a.data === 'string') hostIps[a.name] = a.data;
  });

  // 2. Traiter les services Google Cast
  all.forEach(answer => {
    if (answer.type !== 'SRV' || !answer.name.endsWith(SERVICE)) return;

    const target = answer.data?.target;
    const port   = answer.data?.port || CAST_PORT;
    if (!target) return;

    const txt = all.find(a => a.type === 'TXT' && a.name === answer.name);
    // `friendly` peut être absent : certaines réponses arrivent sans TXT
    const friendly = txtValue(txt, 'fn');
    const fallback = answer.name.replace('.' + SERVICE, '').trim();

    const ip = hostIps[target];
    if (!ip) {
      // l'adresse suivra
      pending[target] = { friendly, fallback, port, identite: answer.name };
      return;
    }
    register(ip, friendly, fallback, port, answer.name);
  });

  // 3. Débloquer les services dont l'adresse vient d'arriver
  Object.entries(pending).forEach(([target, info]) => {
    const ip = hostIps[target];
    if (!ip) return;
    register(ip, info.friendly, info.fallback, info.port, info.identite);
    delete pending[target];
  });
}

function register(ip, friendly, fallback, port, identite) {
  const id = idFor(ip);

  // Même appareil déjà en cache sous une autre adresse : on ne garde que celle
  // du réseau principal, sinon la même TV occupe deux lignes dans la liste.
  const jumeau = identite ? identites[identite] : null;
  if (jumeau && jumeau !== id && deviceCache[jumeau]) {
    if (!discovery.adresseMeilleure(ip, deviceCache[jumeau].host)) return;
    console.log(`[re:cast] Chromecast ${deviceCache[jumeau].name} : ${deviceCache[jumeau].host} → ${ip} (réseau principal)`);
    delete deviceCache[jumeau];
  }

  const known = deviceCache[id];

  // Ne jamais écraser un nom convivial déjà connu par le repli technique : une
  // réponse mDNS sans TXT remplaçait « 55" Crystal UHD » par « DU7000-7a1beb… ».
  const label = friendly || known?.name || fallback || `Chromecast (${ip})`;

  if (!known) {
    console.log(`[re:cast] Chromecast découvert: ${label} @ ${ip}:${port}`);
  }
  deviceCache[id] = { name: label, host: ip, port };
  if (identite) identites[identite] = id;
}

// Le nom convivial vit dans l'enregistrement TXT, sous la clé `fn`
function txtValue(txtAnswer, key) {
  const entries = txtAnswer?.data;
  if (!entries) return null;
  const list = Array.isArray(entries) ? entries : [entries];
  for (const entry of list) {
    const text = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry);
    if (text.startsWith(key + '=')) return text.slice(key.length + 1).trim();
  }
  return null;
}

function ping() {
  listen().forEach(m => {
    try {
      m.query({ questions: [{ name: SERVICE, type: 'PTR' }] });
    } catch (err) {
      console.error('[re:cast] Chromecast ping error:', err.message);
    }
  });
}

function discover() {
  ping();
  return new Promise((resolve) => setTimeout(() => resolve(cached()), 4000));
}

function has(deviceId) {
  return !!deviceCache[deviceId];
}

// Un Chromecast se reconstruit depuis son IP : le protocole est toujours sur 8009.
// Pas besoin d'attendre le mDNS quand l'extension nous donne déjà l'adresse.
function resolveByHost(host, name, port = CAST_PORT) {
  const id = idFor(host);
  if (!deviceCache[id]) {
    deviceCache[id] = { name: name || `Chromecast (${host})`, host, port };
    console.log(`[re:cast] Chromecast reconstruit depuis l'IP: ${host}`);
  }
  return Promise.resolve(id);
}

// ─── Cast ─────────────────────────────────────────────────────────────────────

function cast({ deviceId, streamUrl, referer, title }) {
  return new Promise((resolve, reject) => {
    const device = deviceCache[deviceId];
    if (!device) return reject(new Error(`Chromecast ${deviceId} inconnu — relancez la découverte`));

    // Le type doit être calculé sur l'URL D'ORIGINE : l'URL proxy est volontairement
    // neutre et ne dit rien du contenu réel.
    const contentType = guessContentType(streamUrl);

    // Proxifier dès qu'un Referer est nécessaire, sinon le CDN répond 403 au
    // Chromecast qui, lui, n'enverra jamais l'en-tête. Mode strict : vrai MIME et
    // requêtes Range relayées, à l'inverse du mode Samsung.
    const castUrl = referer
      ? registerStream(streamUrl, referer, { target: device.host, mode: 'strict' })
      : streamUrl;

    console.log(`[re:cast] Chromecast cast → ${device.name} (${contentType})`);

    const client = new Client();
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { client.close(); } catch {}
        return reject(err);
      }
      resolve();
    };

    const timer = setTimeout(() => finish(new Error('Chromecast: pas de réponse après 15 s')), 15000);

    client.on('error', (err) => finish(err));

    client.connect({ host: device.host, port: device.port || CAST_PORT }, () => {
      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) return finish(err);

        const media = {
          contentId:   castUrl,
          contentType,
          streamType: 'BUFFERED',
          metadata: {
            type: 0,
            metadataType: 0,
            title: title || 're:cast'
          }
        };

        player.load(media, { autoplay: true }, (err) => {
          if (err) return finish(err);
          console.log('[re:cast] Chromecast: lecture démarrée sur', device.name);
          // Fermer la connexion précédente seulement une fois la nouvelle lancée
          if (active && active.client !== client) {
            try { active.client.close(); } catch {}
          }
          active = { client, player };
          finish();
        });
      });
    });
  });
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

function stop() {
  return new Promise((resolve) => {
    if (!active) return resolve();

    const { client, player } = active;
    active = null;

    const close = () => { try { client.close(); } catch {} ; resolve(); };
    try {
      player.stop(close);
      setTimeout(close, 3000); // ne pas rester bloqué si l'appareil ne répond pas
    } catch {
      close();
    }
  });
}

module.exports = { discover, ping, cached, has, resolveByHost, cast, stop };
