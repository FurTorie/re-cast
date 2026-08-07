// re:cast - proxy.js
// Proxy HTTP pour streams HTTPS → Samsung DLNA ne supporte pas HTTPS
// Utilise des IDs courts (/stream/abc123) pour éviter les URLs encodées

const https = require('https');
const http  = require('http');
const url   = require('url');
const crypto = require('crypto');
const discovery = require('./discovery');

const PORT = 7171;

// Stockage des streams enregistrés : id → { url, referer, mode }
const streamStore = {};

// Connexions réutilisées vers le CDN. Sans ça chaque segment HLS repayait une
// poignée de main TCP + TLS complète vers un serveur distant — le coût dominant
// lors d'un déplacement dans la vidéo, où la TV réclame plusieurs segments d'affilée.
const agents = {
  http:  new http.Agent({  keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16 }),
  https: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16 })
};

// Manifestes déjà réécrits. La TV relit le manifeste à CHAQUE déplacement validé
// dans la vidéo : sans ce cache, chaque saut paie un aller-retour vers le CDN avant
// même de commencer à charger le moindre segment.
const manifestCache = new Map(); // clé → { body, headers, expires }
const cacheHits = new Map();     // clé → { n, dernierLog } pour ne pas noyer la console
const TTL_VOD  = 60000; // #EXT-X-ENDLIST présent : la playlist ne changera plus
const TTL_LIVE = 2000;  // direct : elle évolue, on ne la garde qu'un instant
const MAX_MANIFESTS = 40;

// IP de l'appareil qui nous parle, pour savoir quelle IP locale lui annoncer
function clientIp(req) {
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

// Un lecteur qui ne sait pas quoi faire d'une playlist la redemande en boucle :
// des dizaines de fois par seconde. Logger chaque service depuis le cache noyait
// la console et coûtait cher — chaque écriture est SYNCHRONE sous Windows.
// On resserre à une ligne toutes les 5 s, avec le nombre de requêtes encaissées.
function journaliserCacheHit(cle) {
  const maintenant = Date.now();
  const e = cacheHits.get(cle) || { n: 0, dernierLog: 0 };
  e.n++;

  if (maintenant - e.dernierLog >= 5000) {
    console.log(e.n > 1
      ? `[re:cast] Manifest depuis le cache (${e.n} demandes du lecteur)`
      : '[re:cast] Manifest depuis le cache');
    e.dernierLog = maintenant;
    e.n = 0;
  }
  cacheHits.set(cle, e);
}

// Enregistrer un stream et retourner son URL proxy courte
// L'URL se termine par .mp4 pour tromper Samsung DLNA sur le type de contenu
//
// `target` = IP de l'appareil qui va consommer le flux. Elle détermine l'interface
// locale annoncée : sur une machine multi-interfaces, annoncer l'IP d'un adaptateur
// virtuel (VMware, vEthernet Hyper-V) donne à la TV une URL qu'elle ne peut pas
// joindre — et l'échec est silencieux côté daemon.
// `mode` détermine ce qu'on raconte au client :
//   'samsung' (défaut) — Content-Type: video/mp4 quel que soit le contenu réel, plus
//                        les en-têtes DLNA. C'est un mensonge nécessaire : le firmware
//                        Samsung refuse les MIME HLS mais ne vérifie jamais le corps.
//   'strict'           — vrai Content-Type et gestion des requêtes Range. Obligatoire
//                        pour Chromecast, qui lui se fie au MIME annoncé et rejette
//                        un manifeste HLS présenté comme du MP4.
// `localIp` et `quiet` servent à la réécriture de manifeste, qui appelle cette
// fonction une fois par segment : y résoudre l'IP et y écrire deux lignes de log
// coûtait un appel système et deux écritures console synchrones PAR SEGMENT, à
// chaque relecture du manifeste — c'est-à-dire à chaque déplacement dans la vidéo.
function registerStream(streamUrl, referer, {
  port = PORT, target = null, mode = 'samsung', localIp = null, quiet = false, segment = false
} = {}) {
  // Identifiant DÉTERMINISTE : une même URL amont donne toujours le même ID. Avec des
  // IDs aléatoires, chaque relecture du manifeste réinventait une URL par segment, ce
  // qui invalidait tout ce que la TV avait déjà en cache — elle devait re-télécharger
  // même les segments qu'elle venait de lire — et faisait grossir streamStore sans fin.
  // 12 caractères hex : assez court pour Samsung, assez large pour éviter les collisions.
  const id = crypto.createHash('sha1')
    .update(`${streamUrl}|${referer || ''}|${mode}`)
    .digest('hex')
    .slice(0, 12);
  streamStore[id] = { url: streamUrl, referer, mode, segment };
  const ip = localIp || discovery.localIpFor(target);
  // .mp4 à la fin en mode Samsung : la TV lit l'extension pour deviner le type
  // .mp4 sur TOUTES les URLs en mode Samsung, segments compris — voir le bloc
  // d'en-têtes dans fetchAndProxy : la fiction MP4 doit être uniforme. Donner sa
  // vraie extension à un segment suffit à la rompre.
  const suffix = mode === 'samsung' ? '.mp4' : '';
  const proxyUrl = `http://${ip}:${port}/stream/${id}${suffix}`;
  if (!quiet) {
    console.log(`[re:cast] Stream enregistré: ${id} (${mode}) → ${streamUrl.substring(0, 60)}...`);
    console.log(`[re:cast] URL proxy courte: ${proxyUrl}`);
  }
  return proxyUrl;
}

// Sert un corps que NOUS avons produit, en honorant une éventuelle requête Range.
//
// À ne pas confondre avec le relais du Range vers la source : sur un manifeste, le
// corps est réécrit, donc une plage d'octets de l'original n'aurait aucun sens.
// Découper NOTRE corps, en revanche, est parfaitement légitime — et nécessaire.
//
// Cas mesuré : un Samsung DU7000 traite le manifeste comme un fichier MP4 binaire
// et y cherche par plages (`Range: bytes=8192-`). Tant qu'on lui répondait 200 avec
// le corps entier depuis l'octet 0, il redemandait la même plage sans jamais
// progresser, et la lecture ne démarrait pas.
function servirCorps(req, res, corps, headers, statut = 200) {
  const buf = Buffer.isBuffer(corps) ? corps : Buffer.from(corps, 'utf8');
  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());

  if (!m) {
    headers['Content-Length'] = buf.length;
    res.writeHead(statut, headers);
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const debut = m[1] ? parseInt(m[1], 10) : 0;
  let fin     = m[2] ? parseInt(m[2], 10) : buf.length - 1;

  if (debut >= buf.length) {
    headers['Content-Range'] = `bytes */${buf.length}`;
    res.writeHead(416, headers);
    return res.end();
  }
  if (fin >= buf.length) fin = buf.length - 1;

  const tranche = buf.subarray(debut, fin + 1);
  headers['Content-Range']  = `bytes ${debut}-${fin}/${buf.length}`;
  headers['Content-Length'] = tranche.length;
  res.writeHead(206, headers);
  res.end(req.method === 'HEAD' ? undefined : tranche);
}

// Type réel déduit de l'URL d'origine, query string retirée — c'est elle qui fait
// échouer les détections basées sur l'extension (`master.m3u8?token=…`).
function guessContentType(streamUrl, upstreamType) {
  const path = String(streamUrl).split(/[?#]/)[0].toLowerCase();

  if (path.endsWith('.m3u8')) return 'application/x-mpegurl';
  if (path.endsWith('.mpd'))  return 'application/dash+xml';
  if (path.endsWith('.ts'))   return 'video/mp2t';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mp4') || path.endsWith('.m4s')) return 'video/mp4';

  // Sinon : ce que dit la source, à condition que ce ne soit pas du générique
  if (upstreamType && !/octet-stream|text\/plain/i.test(upstreamType)) {
    return upstreamType;
  }
  return 'video/mp4';
}

// Handler Express pour GET /stream/:id.mp4
function streamHandler(req, res) {
  // Accepter /stream/abc123 comme /stream/abc123.mp4 ou .ts : l'extension n'est
  // qu'un indice pour la TV, jamais une donnée d'identification.
  const id = req.params.id.replace(/\.[a-z0-9]{1,5}$/i, '');
  const entry = streamStore[id];

  // Journaliser ce que DEMANDE l'appareil. Sans ça, le log ne montre que nos
  // requêtes sortantes : on voit ce qu'on va chercher, jamais ce qui nous a été
  // demandé, ni avec quelle méthode ni quelles plages. Impossible de comprendre
  // un lecteur qui referme sans savoir ce qu'il attendait.
  const details = [
    req.method,
    req.headers.range ? `Range: ${req.headers.range}` : null,
    req.headers['getcontentfeatures.dlna.org'] ? 'demande le profil DLNA' : null,
    req.headers['transfermode.dlna.org'] ? `transferMode: ${req.headers['transfermode.dlna.org']}` : null
  ].filter(Boolean).join('  ');
  console.log(`[re:cast] ← ${details}  /stream/${req.params.id}`);
  console.log(`[re:cast]   client ${clientIp(req)} · ${(req.headers['user-agent'] || 'sans User-Agent').slice(0, 70)}`);

  if (!entry) {
    console.error(`[re:cast] ⚠ Flux ${id} inconnu — 404 renvoyé.`);
    res.status(404).send('Stream not found');
    return;
  }

  fetchAndProxy(entry.url, entry.referer, req, res, entry.mode || 'samsung', 0, !!entry.segment);
}

// Handler pour /proxy?url=... (fallback rétrocompatibilité)
function proxyHandler(req, res) {
  const params  = url.parse(req.url, true).query;
  const target  = params.url;
  const referer = params.referer;
  if (!target) { res.writeHead(400); return res.end('Missing ?url='); }
  fetchAndProxy(target, referer, req, res);
}

// Erreurs réseau qui méritent un réessai plutôt qu'un abandon
const TRANSIENT = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'];
const MAX_ATTEMPTS = 3;

// Proxy d'une URL vers le client
function fetchAndProxy(target, referer, req, res, mode = 'samsung', attempt = 0, estSegment = false) {
  const parsed  = url.parse(target);
  const isHttps = parsed.protocol === 'https:';
  const lib     = isHttps ? https : http;

  // Un manifeste est réécrit par nos soins : son corps ne correspond plus à celui de
  // la source, une plage d'octets demandée dessus n'aurait donc aucun sens. On ne
  // relaie le Range que pour les segments et les fichiers.
  const looksLikePlaylist = /\.m3u8(\?|$)/i.test(target) || target.includes('index-v');
  const range = (!looksLikePlaylist && req.headers.range) ? req.headers.range : null;

  // Le manifeste réécrit est identique d'une relecture à l'autre (les IDs sont
  // déterministes) : le resservir depuis le cache économise l'aller-retour CDN qui
  // précède chaque saut dans la vidéo.
  const cacheKey = looksLikePlaylist ? `${mode}|${clientIp(req)}|${target}` : null;
  if (cacheKey) {
    const hit = manifestCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      journaliserCacheHit(cacheKey);
      // Copie des en-têtes : servirCorps ajuste Content-Length et Content-Range
      return servirCorps(req, res, hit.body, { ...hit.headers });
    }
  }

  // Journalisé ICI et pas à l'entrée de la fonction : une requête servie depuis le
  // cache n'atteint jamais le CDN, et l'annoncer comme un « fetch » donnait une
  // fausse image du trafic réseau — au point de me faire mal lire un log.
  console.log(`[re:cast] ${estSegment ? 'Segment' : 'Fetch'} (${mode}) → ${target.substring(0, 78)}`);

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     parsed.path,
    method:   'GET',
    agent:    isHttps ? agents.https : agents.http,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(referer ? {
        'Referer': referer,
        'Origin':  new URL(referer).origin
      } : {}),
      // Les deux protocoles demandent le média par tranches. Sans relais du Range,
      // le client reçoit tout depuis le début en 200 : Chromecast ne peut pas se
      // déplacer, et la TV DLNA recharge le flux à chaque saut.
      ...(range ? { 'Range': range } : {})
    }
  };

  // Distinguer « le client est parti » de « l'amont est mort » : sans ce drapeau, la
  // coupure qu'on provoque nous-même en nettoyant ressort comme une panne du CDN,
  // et le log devient inexploitable pour diagnostiquer.
  let clientGone = false;
  let octetsEnvoyes = 0;
  let octetsAttendus = 0;

  const proxyReq = lib.request(options, (proxyRes) => {
    // Le délai plus bas ne doit couvrir QUE l'établissement de la réponse. Une fois le
    // flux démarré, le socket amont peut rester inactif très longtemps, et c'est le
    // fonctionnement normal : quand la TV a rempli son tampon elle cesse de lire, la
    // contre-pression TCP remonte jusqu'ici et on arrête de tirer depuis le CDN.
    // Maintenir un délai d'inactivité coupait alors la vidéo en pleine lecture — sur
    // un MP4 progressif, la lecture s'arrêtait à la taille du tampon.
    // La fin de vie est couverte autrement : res.on('close') si le client s'en va,
    // et les handlers d'erreur de proxyRes si l'amont meurt.
    proxyReq.setTimeout(0);

    // Suivre les redirections
    if ([301,302,303,307,308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      const loc = proxyRes.headers.location.startsWith('http')
        ? proxyRes.headers.location
        : `${parsed.protocol}//${parsed.host}${proxyRes.headers.location}`;
      return fetchAndProxy(loc, referer, req, res, mode, 0, estSegment);
    }

    // pipe() ne propage PAS les erreurs vers la destination : sans ces handlers, un
    // flux amont coupé en cours de route laisse la réponse cliente ouverte à jamais.
    // C'est ce qui fait « perdre le fil » au lecteur sans qu'il puisse repartir.
    let aborted = false;
    const upstreamFailed = (err) => {
      aborted = true;
      // Coupure provoquée par notre propre nettoyage : ce n'est pas une panne
      if (clientGone) return;
      console.error('[re:cast] Flux amont interrompu:', err?.message || 'aborted');
      if (!res.headersSent) { res.writeHead(502); res.end('Upstream error'); }
      else res.destroy();
    };
    proxyRes.on('error',   upstreamFailed);
    proxyRes.on('aborted', () => upstreamFailed(new Error('connexion amont coupée')));

    const upstreamType = proxyRes.headers['content-type'] || '';

    // Un refus du CDN passait totalement inaperçu : on réécrivait la page d'erreur
    // comme si c'était une playlist et on transmettait le code au lecteur, qui
    // abandonnait en silence. Cas réel : 403 Cloudflare faute de Referer.
    if (proxyRes.statusCode >= 400) {
      console.error(`[re:cast] ⚠ Le serveur distant refuse : HTTP ${proxyRes.statusCode} (${upstreamType || 'sans type'})`);
      console.error(`[re:cast]   ${target.substring(0, 90)}`);
      if (!referer) {
        console.error('[re:cast]   Aucun Referer transmis — beaucoup de CDN refusent sans lui.');
      }
    }

    const isM3u8 = target.includes('.m3u8') || target.includes('index-v') ||
                   upstreamType.includes('mpegurl') || upstreamType.includes('x-mpegURL');

    const headers = mode === 'strict'
      // Chromecast se fie au MIME annoncé : il faut dire la vérité, exposer les
      // en-têtes de Range et accepter les requêtes partielles.
      ? {
          'Content-Type':                   guessContentType(target, upstreamType),
          'Access-Control-Allow-Origin':    '*',
          'Access-Control-Allow-Headers':   'Content-Type, Range, Accept-Encoding',
          'Access-Control-Expose-Headers':  'Content-Length, Content-Range, Accept-Ranges',
          'Accept-Ranges':                  proxyRes.headers['accept-ranges'] || 'bytes',
          'Cache-Control':                  'no-cache'
        }
      // Samsung DLNA : forcer video/mp4 quel que soit le contenu réel. Le corps peut
      // être du HLS, la TV ne vérifie que le MIME. Ne pas « corriger » ceci.
      // ⚠ LA FICTION DOIT ÊTRE TOTALE ET UNIFORME.
      //
      // J'ai tenté quatre fois de « corriger » ce bloc en disant la vérité sur les
      // segments — vrai Content-Type, extension .ts, pas d'en-têtes DLNA, pas de
      // profil PN. Chaque tentative a CASSÉ une lecture qui fonctionnait.
      //
      // La raison : cette TV ne parse pas le HLS. Elle suit la fiction qu'on lui
      // raconte — tout est du MP4 — et son démuxeur s'accommode d'une charge utile
      // MPEG-TS tant que RIEN ne la contredit. Dès qu'un seul élément dit la vérité,
      // la fiction se rompt et le lecteur perd le fil.
      //
      // Ne pas « réparer » l'incohérence apparente : elle est le mécanisme.
      : {
          'Content-Type':                'video/mp4',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'no-cache',
          'Accept-Ranges':               proxyRes.headers['accept-ranges'] || 'bytes',
          'transferMode.dlna.org':       'Streaming',
          'contentFeatures.dlna.org':    'DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5;DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01500000000000000000000000000000'
        };

    // Une réponse partielle doit conserver son statut 206 et sa plage, sinon le
    // client reçoit un morceau de fichier annoncé comme le fichier entier.
    if (proxyRes.headers['content-range']) {
      headers['Content-Range'] = proxyRes.headers['content-range'];
    }

    if (isM3u8) {
      // Le corps du manifeste est réécrit : il ne correspond plus à celui de la
      // source, ni en contenu ni en taille. Annoncer le support des plages d'octets
      // dessus serait un mensonge qui invite le client à demander un Range qu'on
      // ignore ensuite — d'où des lecteurs qui se bloquent sans erreur.
      delete headers['Accept-Ranges'];

      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        // Un manifeste tronqué ne doit surtout pas être servi ni mis en cache :
        // il resterait valable une minute et casserait toute la lecture.
        if (aborted) return;

        // Le corps n'est pas une playlist : page d'erreur, captcha, redirection
        // HTML… La réécrire produisait des « URLs proxifiées » absurdes tirées du
        // HTML, et masquait complètement la cause. On sert tel quel et on le dit.
        if (!body.trimStart().startsWith('#EXTM3U')) {
          const apercu = body.trim().slice(0, 120).replace(/\s+/g, ' ');
          console.error(`[re:cast] ⚠ Réponse annoncée HLS mais ce n'est pas une playlist : ${apercu}`);
          headers['Content-Length'] = Buffer.byteLength(body);
          res.writeHead(proxyRes.statusCode, headers);
          return res.end(body);
        }

        // clientIp(req) = l'appareil qui vient chercher le manifest : les URLs de
        // segments doivent pointer vers l'interface locale qu'il sait joindre, et
        // hériter du même mode que le manifest.
        const rewritten = rewriteM3u8(body, target, referer, clientIp(req), mode);

        if (cacheKey) {
          // Une playlist VOD est figée ; une playlist live évolue en continu
          const ttl = /#EXT-X-ENDLIST/.test(body) ? TTL_VOD : TTL_LIVE;
          if (manifestCache.size >= MAX_MANIFESTS) manifestCache.clear();
          manifestCache.set(cacheKey, {
            body: rewritten,
            headers: { ...headers },
            expires: Date.now() + ttl
          });
        }

        servirCorps(req, res, rewritten, headers, proxyRes.statusCode);
      });
    } else {
      if (proxyRes.headers['content-length']) {
        headers['Content-Length'] = proxyRes.headers['content-length'];
        octetsAttendus = parseInt(proxyRes.headers['content-length'], 10) || 0;
      }
      // Compter ce qui part réellement : c'est la seule façon de distinguer un
      // lecteur qui refuse d'emblée d'un lecteur qui lit puis renonce.
      proxyRes.on('data', (c) => { octetsEnvoyes += c.length; });
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    // Une connexion réutilisée peut avoir été fermée côté CDN entre deux requêtes :
    // Node rend alors un socket déjà mort et la requête échoue en ECONNRESET. C'est
    // le revers du keepAlive, et la réponse correcte est de réessayer.
    const transient = TRANSIENT.includes(err.code) || /socket hang up/i.test(err.message);

    // Ne pas réessayer pour un client déjà parti : l'ECONNRESET vient alors de NOTRE
    // propre coupure, et retélécharger le segment ne sert plus personne.
    if (clientGone) return;

    if (transient && attempt < MAX_ATTEMPTS - 1 && !res.headersSent) {
      console.warn(`[re:cast] Échec transitoire (${err.code || err.message}), tentative ${attempt + 2}/${MAX_ATTEMPTS}`);
      return fetchAndProxy(target, referer, req, res, mode, attempt + 1, estSegment);
    }

    console.error('[re:cast] Proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Proxy error');
    } else {
      // En-têtes déjà partis : on ne peut plus signaler l'erreur proprement, mais il
      // faut couper. Sans ça le client reste suspendu sur un flux tronqué qui ne se
      // termine jamais — le lecteur ne redémarre pas et ne signale rien.
      res.destroy();
    }
  });

  // Inactivité, pas durée totale : un gros segment qui se télécharge normalement ne
  // déclenche jamais ce délai. 10 s était trop court au démarrage d'un CDN lent.
  proxyReq.setTimeout(20000, () => {
    const err = new Error('timeout amont');
    err.code = 'ETIMEDOUT';
    proxyReq.destroy(err);   // repasse par le handler ci-dessus, donc par le réessai
  });

  // Le client a abandonné (saut dans la vidéo, arrêt, changement de source) :
  // inutile de continuer à tirer le segment depuis le CDN.
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    // C'est l'appareil qui a raccroché, pas le CDN : le distinguer explicitement,
    // car les deux cas appellent des corrections opposées. Le volume déjà transmis
    // départage « il a refusé d'entrée » de « il a lu puis renoncé ».
    const attendu = octetsAttendus ? ` sur ${octetsAttendus}` : '';
    console.log(`[re:cast] Client parti après ${octetsEnvoyes} octet(s)${attendu} — abandon`);
    proxyReq.destroy();
  });

  proxyReq.end();
}

// Réécrire les URLs dans un manifest HLS pour passer par le proxy
function rewriteM3u8(body, manifestUrl, referer, target = null, mode = 'samsung') {
  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);

  const absolutize = (u) =>
    (u.startsWith('http://') || u.startsWith('https://')) ? u : base + u;

  // Résolu UNE fois pour tout le manifeste : localIpFor() interroge les interfaces
  // système, et l'appeler par ligne était l'un des coûts dominants de la réécriture.
  const localIp = discovery.localIpFor(target);
  let count = 0;

  const proxify = (u) => {
    count++;
    // segment: true → l'URL garde sa vraie extension, cohérente avec le Content-Type
    return registerStream(absolutize(u), referer, { target, mode, localIp, quiet: true, segment: true });
  };

  const rewritten = body.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Les tags portant un attribut URI="…" doivent AUSSI passer par le proxy :
    // #EXT-X-KEY (clé de déchiffrement AES), #EXT-X-MAP (segment d'init),
    // #EXT-X-MEDIA (pistes audio/sous-titres). Sans ça la TV va les chercher
    // directement sur le CDN, sans Referer → 403, et la lecture reste bloquée
    // sans le moindre message d'erreur.
    if (trimmed.startsWith('#')) {
      return line.includes('URI="')
        ? line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxify(u)}"`)
        : line;
    }

    // Ligne de segment ou de variante
    return proxify(trimmed);
  }).join('\n');

  console.log(`[re:cast] Manifest réécrit (${mode}) : ${count} URL(s) proxifiée(s)`);
  return rewritten;
}

module.exports = { proxyHandler, streamHandler, registerStream, guessContentType };
