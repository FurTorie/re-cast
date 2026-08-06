// re:cast - dlna.js
// Cast DLNA — Samsung optimisé
// Stratégie : upnp-mediarenderer-client (jaruba fork, Samsung EUPNP fix)
//             + fallback SOAP direct si la librairie échoue

const MediaRendererClient = require('upnp-mediarenderer-client');
const http = require('http');
const url  = require('url');
const { registerStream } = require('../proxy');
const discovery = require('../discovery');

const deviceCache = {};

// On cherche le renderer, pas le serveur de médias : viser MediaRenderer et
// AVTransport évite de polluer la liste avec les MediaServer et la box du FAI.
const SSDP_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1'
];

// ─── Découverte ───────────────────────────────────────────────────────────────

function idFor(host) {
  return `dlna-${host.replace(/\./g, '-')}`;
}

// Liste immédiate, sans attendre le réseau
function cached() {
  return Object.entries(deviceCache).map(([id, d]) => ({
    id, name: d.name, type: 'DLNA', host: d.host
  }));
}

// Le friendlyName arrive encodé dans le XML — une Samsung s'annonce « 85&quot; QLED »
function decodeEntities(text) {
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi,   '<')
    .replace(/&gt;/gi,   '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/gi,  '&'); // en dernier, sinon on décoderait deux fois
}

// La réponse SSDP porte déjà l'URL exacte du description.xml : pas besoin de sonder
// les ports comme le fait l'ajout manuel.
async function addFromSsdp({ host, location }) {
  const id = idFor(host);
  if (deviceCache[id]) return;

  let xml;
  try {
    xml = await fetchXml(location);
  } catch {
    return;
  }

  // Un appareil sans AVTransport ne sait pas lire de média (MediaServer, box…)
  if (!/AVTransport/i.test(xml)) return;

  const raw = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/i)?.[1]?.trim();
  const name = raw ? decodeEntities(raw) : null;
  deviceCache[id] = { name: name || `TV (${host})`, host, location };
  console.log(`[re:cast] DLNA découvert: ${deviceCache[id].name} @ ${host} (${location})`);
}

// Découverte SSDP émise depuis TOUTES les interfaces (cf. discovery.js) : c'est la
// seule façon d'atteindre la TV sur une machine multi-interfaces, où le socket non
// lié des librairies part sur un adaptateur virtuel.
async function discover() {
  const pending = [];
  await discovery.search({
    sts: SSDP_TARGETS,
    timeoutMs: 4000,
    onDevice: (d) => pending.push(addFromSsdp(d).catch(() => {}))
  });
  await Promise.all(pending);
  // Retourne tout le cache, pas seulement ce qui a répondu pendant la fenêtre
  return cached();
}

// Recherche lancée sans attendre le résultat
function ping() {
  discover().catch(err => console.error('[re:cast] DLNA ping error:', err.message));
}

function has(deviceId) {
  return !!deviceCache[deviceId];
}

// Retrouver un appareil DLNA à partir de son IP — même chemin que l'ajout manuel :
// on resonde les ports pour retrouver son description.xml.
async function resolveByHost(host, name) {
  const id = idFor(host);
  if (deviceCache[id]) return id;
  console.log(`[re:cast] DLNA ${host} absent du cache, resondage...`);
  const device = await addByIp(host, name);
  return device.id;
}

// ─── Ajout manuel par IP ──────────────────────────────────────────────────────

const SAMSUNG_PORTS = [9197, 7676, 52235, 49152, 1234];

async function addByIp(ip, name) {
  for (const port of SAMSUNG_PORTS) {
    const location = await probeDlnaPort(ip, port);
    if (location) {
      // Logger le contenu pour debug
      fetchXml(location).then(xml => {
        const controlUrl = extractControlUrl(xml);
        console.log(`[re:cast] description.xml @ ${location}`);
        console.log(`[re:cast] AVTransport controlUrl: ${controlUrl}`);
      }).catch(() => {});

      const id = idFor(ip);
      deviceCache[id] = { name: name || `TV (${ip})`, host: ip, location };
      console.log(`[re:cast] Appareil ajouté manuellement: ${name || ip} @ ${ip} (${location})`);
      return { id, name: name || `TV (${ip})`, type: 'DLNA', host: ip };
    }
  }
  throw new Error(`Aucun service DLNA trouvé sur ${ip} (ports: ${SAMSUNG_PORTS.join(', ')})`);
}

function probeDlnaPort(ip, port) {
  return new Promise((resolve) => {
    const paths = ['/description.xml', '/dmr', '/MediaRenderer/desc.xml', '/upnp/desc/dx.xml', '/'];
    let tried = 0;
    paths.forEach(path => {
      const req = http.get({ host: ip, port, path, timeout: 1500 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (data.includes('AVTransport') || data.includes('MediaRenderer') || data.includes('upnp')) {
            resolve(`http://${ip}:${port}${path}`);
          } else {
            if (++tried === paths.length) resolve(null);
          }
        });
      });
      req.on('error', () => { if (++tried === paths.length) resolve(null); });
      req.on('timeout', () => { req.destroy(); if (++tried === paths.length) resolve(null); });
    });
  });
}

// ─── Cast ─────────────────────────────────────────────────────────────────────

async function cast({ deviceId, streamUrl, referer, title }) {
  const device = deviceCache[deviceId];
  if (!device) throw new Error(`Appareil ${deviceId} inconnu — relancez la découverte`);

  // Samsung DLNA ne supporte pas HTTPS — proxy HTTP avec URL courte /stream/xxxx
  let castUrl = streamUrl;
  if (streamUrl.startsWith('https://')) {
    // device.host : l'URL proxy doit porter l'IP locale que CETTE TV sait joindre
    castUrl = registerStream(streamUrl, referer, { target: device.host });
  }

  console.log(`[re:cast] DLNA cast → ${device.name} (${device.host})`);

  // Essai 1 : upnp-mediarenderer-client (jaruba fork — gère EUPNP 704 Samsung)
  try {
    await castViaLibrary(device, castUrl, title);
    return;
  } catch (err) {
    console.warn(`[re:cast] Librairie échouée (${err.message}), fallback SOAP direct...`);
  }

  // Essai 2 : SOAP direct (contourne PrepareForConnection)
  await castViaSoap(device, castUrl, title);
}

// Le timeout est indispensable : sur certains firmwares la librairie ne rappelle
// jamais son callback (ou meurt dans un callback interne, cf. le garde-fou
// uncaughtException de index.js). Sans lui, la requête reste pendue et on
// n'atteint jamais le fallback SOAP.
function castViaLibrary(device, streamUrl, title, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`pas de réponse de la librairie après ${timeoutMs} ms`)),
      timeoutMs
    );

    let client;
    try {
      client = new MediaRendererClient(device.location);
    } catch (err) {
      return finish(err);
    }

    let contentType = 'video/mp4';
    if (streamUrl.includes('.m3u8'))  contentType = 'video/x-mpegurl';
    if (streamUrl.includes('.mpd'))   contentType = 'video/vnd.mpeg.dash.mpd';
    if (streamUrl.includes('.webm'))  contentType = 'video/webm';

    client.on('error', (err) => finish(err));

    try {
      client.load(streamUrl, {
        autoplay:    true,
        contentType: contentType,
        metadata: { title: title || 're:cast', type: 'video' }
      }, (err) => {
        if (err) return finish(err);
        console.log('[re:cast] DLNA (librairie): lecture démarrée sur', device.name);
        finish();
      });
    } catch (err) {
      finish(err);
    }
  });
}

// ─── Fallback SOAP direct (Samsung) ──────────────────────────────────────────

async function castViaSoap(device, streamUrl, title) {
  const xml = await fetchXml(device.location);
  const controlUrl = extractControlUrl(xml);
  const parsed = url.parse(device.location);
  const host = parsed.hostname;
  const port = parseInt(parsed.port) || 80;

  console.log(`[re:cast] SOAP direct → ${host}:${port}${controlUrl}`);

  // Stop d'abord
  await soap(host, port, controlUrl, 'Stop',
    `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>`
  ).catch(() => {});

  const safeUrl = streamUrl.replace(/&/g, '&amp;');

  // Essayer plusieurs variantes : Samsung est imprévisible selon le firmware
  // castUrl pointe vers /stream/xxxx.mp4 → on annonce toujours video/mp4
  const metadataVariants = [
    buildDidl(streamUrl, title, 'video/mp4'),            // 1. MP4 + DLNA flags complets
    buildDidl(streamUrl, title, 'video/mp4', true),      // 2. MP4 + protocolInfo simplifié
    '',                                                  // 3. Pas de metadata
    buildDidl(streamUrl, title, 'video/x-mpegurl'),      // 4. HLS fallback
  ];

  let lastErr;
  for (let i = 0; i < metadataVariants.length; i++) {
    const metadata = metadataVariants[i];
    console.log(`[re:cast] SetAVTransportURI tentative ${i + 1}/4 (metadata: ${metadata ? 'DIDL' : 'vide'})`);
    try {
      await soap(host, port, controlUrl, 'SetAVTransportURI',
        `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
          <InstanceID>0</InstanceID>
          <CurrentURI>${safeUrl}</CurrentURI>
          <CurrentURIMetaData>${metadata}</CurrentURIMetaData>
        </u:SetAVTransportURI>`
      );
      // SetAVTransportURI OK → Play
      await soap(host, port, controlUrl, 'Play',
        `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
          <InstanceID>0</InstanceID>
          <Speed>1</Speed>
        </u:Play>`
      );
      console.log(`[re:cast] DLNA SOAP: lecture démarrée (variante ${i + 1})`);
      return;
    } catch (err) {
      console.warn(`[re:cast] Variante ${i + 1} échouée: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ─── Helpers SOAP / XML ───────────────────────────────────────────────────────

function soap(host, port, controlUrl, action, bodyInner) {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${bodyInner}</s:Body>
</s:Envelope>`;

    const opts = {
      host, port, path: controlUrl, method: 'POST',
      headers: {
        'Content-Type':   'text/xml; charset="utf-8"',
        'SOAPAction':     `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
        'Content-Length': Buffer.byteLength(envelope),
        'Connection':     'close'
      },
      timeout: 6000
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const code = data.match(/<errorCode>(\d+)<\/errorCode>/)?.[1];
          // Ignorer erreur 704 Samsung (PrepareForConnection local restriction)
          // Ignorer erreur 705 (TransportLocked — TV occupée, on continue quand même)
          if (code === '704' || code === '705') return resolve(data);
          reject(new Error(`SOAP ${action} HTTP ${res.statusCode} code=${code || '?'}: ${data.substring(0, 150)}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`SOAP ${action} timeout`)); });
    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

function fetchXml(location) {
  return new Promise((resolve, reject) => {
    http.get(location, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout fetchXml')));
  });
}

function extractControlUrl(xml) {
  const m = xml.match(
    /<serviceType>[^<]*AVTransport[^<]*<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i
  );
  const raw = m ? m[1] : '/upnp/control/AVTransport1';
  return raw.startsWith('/') ? raw : '/' + raw;
}

function buildDidl(streamUrl, title, mime = 'video/mp4', simple = false) {
  const safeTitle = (title || 're:cast').replace(/[<>&"]/g, '');
  const safeUrl   = streamUrl.replace(/&/g, '&amp;');

  // protocolInfo : version complète avec flags DLNA Samsung, ou version simple
  const protocolInfo = simple
    ? `http-get:*:${mime}:*`
    : `http-get:*:${mime}:DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5;DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01500000000000000000000000000000`;

  return `&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"&gt;` +
    `&lt;item id="0" parentID="-1" restricted="1"&gt;` +
    `&lt;dc:title&gt;${safeTitle}&lt;/dc:title&gt;` +
    `&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;` +
    `&lt;res protocolInfo="${protocolInfo}"&gt;${safeUrl}&lt;/res&gt;` +
    `&lt;/item&gt;&lt;/DIDL-Lite&gt;`;
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

async function stop() {
  for (const device of Object.values(deviceCache)) {
    try {
      const xml = await fetchXml(device.location);
      const controlUrl = extractControlUrl(xml);
      const parsed = url.parse(device.location);
      await soap(parsed.hostname, parseInt(parsed.port) || 80, controlUrl, 'Stop',
        `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
          <InstanceID>0</InstanceID>
        </u:Stop>`
      ).catch(() => {});
    } catch {}
  }
}

module.exports = { discover, ping, cached, has, resolveByHost, cast, stop, addByIp };
