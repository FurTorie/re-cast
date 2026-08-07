// re:cast - content.js
//
// Ce script n'a plus qu'UN rôle : remonter au background l'URL que le lecteur
// joue réellement. Il n'injecte plus rien dans la page.
//
// Il portait aussi un bouton flottant et un panneau de cast, supprimés : ils
// n'étaient utilisables qu'à la souris (`opacity: 0` révélé au survol), alors que
// la cible du projet est Firefox pour Android. Le popup `browser_action` est le
// chemin unique, et il fait tout ce que le panneau faisait.
//
// Ce qui reste est indispensable : sur un MP4 progressif, `currentSrc` dit ce qui
// est lu, là où le trafic réseau ne fait que passer — d'où la règle du `>=` dans
// `background.js`, qui laisse gagner cette source à priorité égale.

function reporterSrcVideo(video) {
  const src = video.src || video.currentSrc;
  // Ni `blob:` ni `data:` : ces URLs ne peuvent pas être re-téléchargées depuis
  // une autre machine, et le daemon est sur une autre machine. C'est aussi
  // pourquoi ce script n'aide que sur les MP4 progressifs : en HLS/DASH via MSE,
  // `currentSrc` est justement un `blob:`.
  if (!src || src.startsWith('blob:') || src.startsWith('data:')) return;
  browser.runtime.sendMessage({
    type: 'REPORT_VIDEO_SRC',
    src,
    referer: location.href
  }).catch(() => {});
}

const observateur = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.target.nodeName === 'VIDEO') {
      reporterSrcVideo(m.target);
      continue;
    }
    for (const node of m.addedNodes) {
      if (node.nodeName === 'VIDEO') reporterSrcVideo(node);
      else if (node.querySelectorAll) node.querySelectorAll('video').forEach(reporterSrcVideo);
    }
  }
});

observateur.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src']
});

document.querySelectorAll('video').forEach(reporterSrcVideo);

// En capture : ces événements ne remontent pas, et un lecteur peut vivre dans un
// conteneur qui les arrête.
document.addEventListener('loadedmetadata', e => { if (e.target.nodeName === 'VIDEO') reporterSrcVideo(e.target); }, true);
document.addEventListener('play',           e => { if (e.target.nodeName === 'VIDEO') reporterSrcVideo(e.target); }, true);
