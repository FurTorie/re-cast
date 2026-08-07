// re:cast - airplay.js
// Cast AirPlay - Étape 1 (implémenté en dernier)
// Note: AirPlay fonctionne mieux sur Mac. Sur Windows, compatibilité partielle avec Apple TV.

const http = require('http');
const mdnsLib = require('multicast-dns');
const discovery = require('../discovery');

let discoveredDevices = {}; // id → { name, host, port }
// Nom de service mDNS → id en cache : l'identité stable de l'appareil, celle qui
// ne change pas selon l'interface par laquelle il a répondu.
const identites = {};

function idFor(host) {
  return `airplay-${host.replace(/\./g, '-')}`;
}

// ─── Découverte ───────────────────────────────────────────────────────────────

// Liste immédiate, sans attendre le réseau
function cached() {
  return Object.entries(discoveredDevices).map(([id, d]) => ({
    id, name: d.name, type: 'AirPlay', host: d.host
  }));
}

// Un socket mDNS PAR interface. Comme pour SSDP, un socket non lié émet sur
// l'interface choisie par la table de routage — sur une machine avec des adaptateurs
// virtuels, la requête n'atteint jamais le réseau où se trouve l'appareil.
// Les listeners restent actifs : une réponse arrivant hors fenêtre alimente le cache.
let sockets = null;

function listen() {
  if (sockets) return sockets;

  sockets = discovery.interfaces().map(iface => {
    const m = mdnsLib({ interface: iface.address });
    m.on('error', (err) => console.error(`[re:cast] mDNS ${iface.address}: ${err.message}`));
    m.on('response', handleResponse);
    return m;
  });
  return sockets;
}

function handleResponse(response) {
  const all = response.answers.concat(response.additionals || []);

  // Filtrer strictement : uniquement les PTR _airplay._tcp.local
  all.forEach(answer => {
    if (answer.type !== 'PTR' || answer.name !== '_airplay._tcp.local') return;

    const serviceName = answer.data;

    const srv = all.find(a => a.type === 'SRV' && a.name === serviceName);
    if (!srv) return;

    const host = srv.data?.target;
    const port = srv.data?.port || 7000;
    if (!host) return;

    const aRecord = all.find(a => a.type === 'A' && a.name === host);
    const ip = aRecord ? aRecord.data : host;

    const friendlyName = serviceName
      .replace('._airplay._tcp.local', '')
      .trim();

    // Exclure Samsung/LG/Sony qui font de l'AirPlay 2 — incompatible avec AirPlay 1 HTTP
    // Ces TVs sont déjà détectées en DLNA
    const isTVWithAirplay2 = /samsung|lg |sony|crystal|qled|oled|bravia/i.test(friendlyName);
    if (isTVWithAirplay2) return;

    const id = idFor(ip);

    // Même appareil déjà connu sous une autre adresse. Le nom de service mDNS ne
    // dépend pas de l'interface qui a reçu la réponse, l'adresse si : un appareil
    // joignable par deux chemins occupait deux lignes. On garde celle du réseau
    // principal.
    const jumeau = identites[serviceName];
    if (jumeau && jumeau !== id && discoveredDevices[jumeau]) {
      if (!discovery.adresseMeilleure(ip, discoveredDevices[jumeau].host)) return;
      console.log(`[re:cast] AirPlay ${friendlyName} : ${discoveredDevices[jumeau].host} → ${ip} (réseau principal)`);
      delete discoveredDevices[jumeau];
    }

    if (!discoveredDevices[id]) {
      console.log(`[re:cast] AirPlay découvert: ${friendlyName} @ ${ip}`);
    }
    discoveredDevices[id] = { name: friendlyName, host: ip, port };
    identites[serviceName] = id;
  });
}

// Émettre une requête mDNS sur chaque interface, sans attendre les réponses
function ping() {
  listen().forEach(m => {
    try {
      m.query({ questions: [{ name: '_airplay._tcp.local', type: 'PTR' }] });
    } catch (err) {
      console.error('[re:cast] AirPlay ping error:', err.message);
    }
  });
}

// Découverte AirPlay via mDNS/Bonjour.
// Retourne TOUT le cache après la fenêtre d'écoute — pas seulement les appareils
// qui ont répondu pendant ces 4s, sinon un appareil déjà connu disparaît de la liste.
function discover() {
  ping();
  return new Promise((resolve) => setTimeout(() => resolve(cached()), 4000));
}

function has(deviceId) {
  return !!discoveredDevices[deviceId];
}

// Un appareil AirPlay se reconstruit entièrement à partir de son IP : le cast n'a
// besoin que de host + port. Pas besoin d'attendre le mDNS.
function resolveByHost(host, name, port = 7000) {
  const id = idFor(host);
  if (!discoveredDevices[id]) {
    discoveredDevices[id] = { name: name || `AirPlay (${host})`, host, port };
    console.log(`[re:cast] AirPlay reconstruit depuis l'IP: ${host}`);
  }
  return Promise.resolve(id);
}

// ─── Cast ─────────────────────────────────────────────────────────────────────

// Envoyer le stream à l'Apple TV via HTTP AirPlay
function cast({ deviceId, streamUrl }) {
  return new Promise((resolve, reject) => {
    const device = discoveredDevices[deviceId];
    if (!device) return reject(new Error(`Appareil ${deviceId} introuvable`));

    const body = `Content-Location: ${streamUrl}\nStart-Position: 0\n`;

    const options = {
      host: device.host,
      port: device.port || 7000,
      path: '/play',
      method: 'POST',
      headers: {
        'Content-Type': 'text/parameters',
        'Content-Length': Buffer.byteLength(body),
        'X-Apple-Session-ID': generateSessionId()
      }
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        console.log('[re:cast] AirPlay: lecture démarrée');
        resolve();
      } else {
        reject(new Error(`AirPlay erreur HTTP ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function stop() {
  return new Promise((resolve) => {
    // Envoyer la commande stop à tous les appareils AirPlay connus
    const promises = Object.values(discoveredDevices).map(device => {
      return new Promise((res) => {
        const options = {
          host: device.host,
          port: device.port || 7000,
          path: '/stop',
          method: 'POST'
        };
        http.request(options, () => res()).on('error', () => res()).end();
      });
    });
    Promise.all(promises).then(resolve).catch(resolve);
  });
}

function generateSessionId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = { discover, ping, cached, has, resolveByHost, cast, stop };
