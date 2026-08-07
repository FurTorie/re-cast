// re:cast - discovery.js
// Découverte SSDP liée explicitement aux interfaces, et choix de l'IP locale.
//
// Pourquoi ne pas laisser les librairies faire : node-ssdp et multicast-dns sont
// instanciés sans options par dlnacasts2 et chromecast-api, donc leur socket est lié
// à 0.0.0.0 et c'est la table de routage qui choisit l'interface d'émission du
// multicast. Sur une machine avec des adaptateurs VMware / Hyper-V, la requête part
// sur une interface virtuelle et n'atteint jamais la TV. Ici on émet depuis TOUTES
// les interfaces : pas de liste noire à maintenir, seule la bonne reçoit des réponses.

const dgram = require('dgram');
const os    = require('os');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// ─── Interfaces ───────────────────────────────────────────────────────────────

function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ name, address: a.address, netmask: a.netmask });
      }
    }
  }
  return out;
}

function toInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
}

function sameSubnet(a, b, netmask) {
  if (!netmask) return false;
  const m = toInt(netmask);
  return ((toInt(a) & m) >>> 0) === ((toInt(b) & m) >>> 0);
}

// IP source que l'OS utiliserait pour sortir du réseau : on « connecte » un socket UDP
// (aucun paquet émis, simple résolution de route) et on lit l'adresse locale choisie.
// C'est la seule façon fiable de départager des adaptateurs virtuels d'une vraie
// interface sans liste noire — celle-ci était forcément incomplète, le « vEthernet
// (Default Switch) » d'Hyper-V passant par exemple pour une interface réelle.
let preferred = null;

function resolvePreferred() {
  return new Promise((resolve) => {
    let sock;
    const finish = (ip) => {
      try { sock?.close(); } catch {}
      const valid = ip && interfaces().some(i => i.address === ip);
      preferred = valid ? ip : null;
      resolve(preferred);
    };

    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', () => finish(null));
      // 8.8.8.8 n'est jamais contacté : seule la table de routage est consultée
      sock.connect(53, '8.8.8.8', () => {
        try { finish(sock.address().address); } catch { finish(null); }
      });
    } catch {
      finish(null);
    }
  });
}

// IP locale à annoncer à un appareil donné : celle de l'interface dont le sous-réseau
// contient réellement cet appareil.
function localIpFor(targetHost) {
  const ifs = interfaces();

  if (targetHost) {
    const match = ifs.find(i => sameSubnet(i.address, targetHost, i.netmask));
    if (match) return match.address;
  }

  // Sans cible : l'interface de sortie par défaut de l'OS
  if (preferred) return preferred;

  // Dernier recours seulement : les adaptateurs virtuels courants passent en dernier
  const scored = [...ifs].sort((a, b) =>
    Number(isLikelyVirtual(a)) - Number(isLikelyVirtual(b))
  );
  return scored[0] ? scored[0].address : '127.0.0.1';
}

function isLikelyVirtual(iface) {
  return /vmware|vbox|virtualbox|hyper-v|vethernet|docker|tap|tun|loopback|pseudo/i.test(iface.name)
    || /^169\.254\./.test(iface.address);
}

// ─── Un appareil, plusieurs adresses ──────────────────────────────────────────
//
// Émettre depuis toutes les interfaces est nécessaire (cf. en-tête), mais a une
// contrepartie : quand PLUSIEURS chemins mènent au même appareil, il répond sur
// chacun, avec l'adresse correspondant à ce chemin. Un PC qui partage sa connexion
// crée exactement ce cas — Windows fixe ce réseau à `192.168.137.0/24` — et la TV
// se retrouve joignable en `192.168.1.13` par le Wi-Fi et en `192.168.137.247`
// par le partage. Les caches étant indexés sur l'IP, la même TV occupait alors
// deux entrées par protocole : quatre lignes pour un seul téléviseur, mesuré.
//
// D'où le départage ci-dessous. On garde l'adresse du réseau principal : c'est
// celle que le téléphone et la TV ont en commun, et la seule qui survive à
// l'extinction du partage de connexion.

function surReseauPrefere(host) {
  if (!host || !preferred) return false;
  const iface = interfaces().find(i => i.address === preferred);
  return !!iface && sameSubnet(preferred, host, iface.netmask);
}

// Faut-il remplacer l'adresse déjà connue d'un appareil par une nouvelle ?
// Seulement pour gagner le réseau principal. À égalité, la première vue reste :
// une règle qui bascule à chaque découverte ferait changer l'ID de l'appareil
// d'un scan à l'autre, et l'extension perdrait ses appareils enregistrés.
function adresseMeilleure(nouvelle, connue) {
  if (!nouvelle || nouvelle === connue) return false;
  return surReseauPrefere(nouvelle) && !surReseauPrefere(connue);
}

// L'en-tête USN d'une réponse SSDP porte l'UDN de l'appareil, stable d'une
// interface à l'autre — contrairement à son adresse :
//   « uuid:xxxxxxxx-…::urn:schemas-upnp-org:device:MediaRenderer:1 »
function udnDepuisUsn(usn) {
  return /^(uuid:[0-9a-z-]+)/i.exec(usn || '')?.[1].toLowerCase() || null;
}

// ─── M-SEARCH SSDP ────────────────────────────────────────────────────────────

function buildMSearch(st, mx) {
  return Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    `MX: ${mx}\r\n` +
    `ST: ${st}\r\n\r\n`
  );
}

function header(text, name) {
  return text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1].trim() || null;
}

// Émet un M-SEARCH depuis une interface et rapporte chaque réponse via onDevice.
function searchFrom(iface, sts, timeoutMs, onDevice) {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      console.error(`[re:cast] SSDP socket (${iface.address}):`, err.message);
      return resolve();
    }

    const done = () => {
      try { sock.close(); } catch {}
      resolve();
    };

    sock.on('error', (err) => {
      console.error(`[re:cast] SSDP ${iface.address}: ${err.message}`);
      done();
    });

    sock.on('message', (msg, rinfo) => {
      const text     = msg.toString();
      const location = header(text, 'LOCATION');
      if (!location) return;
      onDevice({
        host:     rinfo.address,
        location,
        // Seule identité de l'appareil qui ne change pas avec l'interface par
        // laquelle il a répondu — c'est elle qui permet de dédupliquer.
        usn:      header(text, 'USN') || '',
        st:       header(text, 'ST') || header(text, 'NT') || '',
        server:   header(text, 'SERVER') || ''
      });
    });

    sock.bind({ address: iface.address, port: 0 }, () => {
      // Forcer l'interface de sortie du multicast — c'est tout l'intérêt du module
      try { sock.setMulticastInterface(iface.address); } catch {}
      try { sock.setMulticastTTL(4); } catch {}

      sts.forEach(st => {
        const buf = buildMSearch(st, Math.max(1, Math.floor(timeoutMs / 1000) - 1));
        sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR, (err) => {
          if (err) console.error(`[re:cast] SSDP send ${iface.address}: ${err.message}`);
        });
      });
    });

    setTimeout(done, timeoutMs);
  });
}

// Cherche sur toutes les interfaces en parallèle. Résout avec la liste dédupliquée
// par location. onDevice est appelé au fil de l'eau, avant la fin du timeout.
async function search({ sts, timeoutMs = 4000, onDevice = () => {} } = {}) {
  const found = new Map();

  const collect = (device) => {
    if (found.has(device.location)) return;
    found.set(device.location, device);
    onDevice(device);
  };

  await Promise.all(
    interfaces().map(iface => searchFrom(iface, sts, timeoutMs, collect))
  );

  return [...found.values()];
}

module.exports = {
  search, interfaces, localIpFor, resolvePreferred, sameSubnet,
  surReseauPrefere, adresseMeilleure, udnDepuisUsn
};
