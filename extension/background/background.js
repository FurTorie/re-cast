// re:cast - background.js
// Intercepte les requêtes réseau pour détecter les streams vidéo

const streamStore = {};

// ─── Patterns de détection ────────────────────────────────────────────────────
function isStreamUrl(url) {
  return (
    url.includes('.m3u8') ||
    url.includes('.mpd') ||
    url.includes('videoplayback') ||   // YouTube
    url.includes('/manifest')  ||       // YouTube DASH manifest
    url.includes('googlevideo.com') ||  // YouTube CDN
    /\.mp4(\?|#|$)/.test(url) ||
    /\.webm(\?|#|$)/.test(url) ||
    /\.ts(\?|#|$)/.test(url) ||         // segments HLS
    url.includes('/seg-') ||            // segments Vimeo
    url.includes('/chunk_') ||          // chunks génériques
    url.includes('mime=video') ||       // YouTube type param
    url.includes('range=') && url.includes('video') // YouTube range requests
  );
}

// ─── Détection via webRequest ─────────────────────────────────────────────────
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== 'xmlhttprequest' &&
        details.type !== 'media' &&
        details.type !== 'other') return;

    if (isStreamUrl(details.url)) {
      const existing = streamStore[details.tabId];
      // Priorité : .m3u8 > .mpd > videoplayback > .mp4 > aperçu de vignette
      const priority  = getPriority(details.url);
      const existingP = existing ? getPriority(existing.url) : -1;

      // À priorité égale on ne remplace PAS un src remonté par le content script :
      // lui lit video.currentSrc, donc il sait ce qui joue vraiment, alors que le
      // trafic réseau ne fait que passer.
      const meilleur = priority > existingP ||
        (priority === existingP && existing?.source !== 'video');

      if (!existing || meilleur) {
        streamStore[details.tabId] = {
          url: details.url,
          referer: null,
          timestamp: Date.now(),
          source: 'network'
        };
        console.log('[re:cast] Stream détecté:', details.url);
      }
    }
  },
  { urls: ['<all_urls>'] }
);

// Aperçus de vignettes : ce sont de vrais fichiers MP4, mais jamais celui qu'on veut.
// Survoler une miniature en charge un par vignette, et à priorité égale le dernier vu
// écrasait la vraie vidéo — on castait alors l'aperçu d'une suggestion.
// Priorité 0 et non exclusion : si la page n'offre rien d'autre, ça reste castable.
function isPreviewUrl(url) {
  return /thumbs?[-.\/]|\/preview\.|preview\.mp4|\/sprite|\/thumb\//i.test(url);
}

// Playlist audio seule. En HLS, une page charge sa playlist vidéo PUIS sa playlist
// audio : les deux étant des .m3u8 de même priorité, la seconde écrasait la première
// et on castait la bande son sans image. C'est le symptôme « ça se lance mais il n'y
// a que le son ».
// Dépriorisé, pas exclu : sur un contenu réellement audio, ça reste castable.
function isAudioOnlyUrl(url) {
  const chemin = url.split(/[?#]/)[0].toLowerCase();
  return /\.m3u8$|\.mpd$/.test(chemin)
      && (/\/audio\//.test(chemin) || /[\/_-]audio\.(m3u8|mpd)$/.test(chemin));
}

function getPriority(url) {
  if (isPreviewUrl(url))     return 0;
  if (isAudioOnlyUrl(url))   return 1;
  if (url.includes('.m3u8')) return 5;
  if (url.includes('.mpd'))  return 4;
  if (url.includes('videoplayback') || url.includes('googlevideo')) return 3;
  return 2;
}

// ─── Capture du Referer ───────────────────────────────────────────────────────
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isStreamUrl(details.url)) return;
    const referer = details.requestHeaders?.find(
      h => h.name.toLowerCase() === 'referer'
    )?.value;
    if (streamStore[details.tabId]) {
      streamStore[details.tabId].referer = referer || null;
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

// ─── Effacer le store quand la page navigue (nouveau site = nouveau stream) ───
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Seulement sur vrai rechargement/navigation (pas sur pushState des SPA)
  if (changeInfo.status === 'loading' && changeInfo.url) {
    delete streamStore[tabId];
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  delete streamStore[tabId];
});

// ─── Recevoir le src vidéo directement depuis le content script ───────────────
// (fallback pour les lecteurs qui ne font pas de requête réseau détectable)
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REPORT_VIDEO_SRC') {
    const { src, tabId } = message;
    if (!src || src.startsWith('blob:')) return; // blob: inutilisable
    const existing = streamStore[sender.tab?.id];
    // `>=` et non `>` : à priorité égale ce src l'emporte, car il vient de
    // video.currentSrc — c'est ce que le lecteur joue réellement, pas une URL
    // aperçue au passage dans le trafic réseau.
    if (!existing || getPriority(src) >= getPriority(existing.url)) {
      streamStore[sender.tab.id] = {
        url: src,
        referer: message.referer,
        timestamp: Date.now(),
        source: 'video'
      };
      console.log('[re:cast] Stream via content script:', src);
    }
    return false;
  }

  if (message.type === 'GET_STREAM') {
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const tabId = tabs[0]?.id;
      sendResponse(streamStore[tabId] || null);
    });
    return true;
  }
});
