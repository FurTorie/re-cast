// re:cast - content.js
// Approche minimaliste : bouton cast flottant uniquement, pas de remplacement du lecteur natif

const DAEMON_URL = 'http://localhost:7171';

// Charger l'URL daemon depuis le storage
browser.storage.local.get('daemonUrl').then(s => {
  if (s.daemonUrl) window._recastDaemonUrl = s.daemonUrl;
}).catch(() => {});

function getDaemonUrl() {
  return window._recastDaemonUrl || DAEMON_URL;
}

// ─── Injection ────────────────────────────────────────────────────────────────

function injectOnVideo(videoEl) {
  if (videoEl.dataset.recastInjected) return;
  videoEl.dataset.recastInjected = 'true';

  // NE PAS toucher aux contrôles natifs — juste ajouter le bouton cast
  const btn = createCastButton(videoEl);

  // Wrapper minimal (ne modifie pas la structure du DOM autant que possible)
  const parent = videoEl.parentElement;
  if (!parent) return;

  // Positionner le parent en relative si nécessaire
  const parentStyle = getComputedStyle(parent);
  if (parentStyle.position === 'static') {
    parent.style.position = 'relative';
  }

  parent.appendChild(btn);
  bindCastButton(btn, videoEl);
}

// ─── Bouton cast flottant ─────────────────────────────────────────────────────

function createCastButton(videoEl) {
  const btn = document.createElement('button');
  btn.className = 'recast-float-btn';
  btn.innerHTML = '📡';
  btn.title = 're:cast — Caster cette vidéo';
  return btn;
}

function bindCastButton(btn, videoEl) {
  // Positionner le bouton sur la vidéo
  function reposition() {
    const vr = videoEl.getBoundingClientRect();
    const pr = videoEl.parentElement.getBoundingClientRect();
    btn.style.top    = (vr.top - pr.top + 8) + 'px';
    btn.style.right  = (pr.right - vr.right + 8) + 'px';
  }

  // Mise à jour position au resize
  const ro = new ResizeObserver(reposition);
  ro.observe(videoEl);
  reposition();

  // Afficher uniquement au survol de la vidéo
  videoEl.addEventListener('mouseenter', () => btn.style.opacity = '1');
  videoEl.addEventListener('mouseleave', () => {
    if (!btn.matches(':hover')) btn.style.opacity = '0';
  });
  btn.addEventListener('mouseleave', () => btn.style.opacity = '0');

  // Clic sur le bouton → ouvrir le panel de cast (sans propager)
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    openCastPanel(btn, videoEl);
  });
}

// ─── Panel de cast ────────────────────────────────────────────────────────────

let activePanelCleanup = null;

async function openCastPanel(anchorBtn, videoEl) {
  // Fermer le panel existant si déjà ouvert
  if (activePanelCleanup) { activePanelCleanup(); return; }

  const panel = document.createElement('div');
  panel.className = 'recast-panel';
  panel.innerHTML = `
    <div class="recast-panel-header">
      <span>📡 re:cast</span>
      <button class="recast-panel-close">✕</button>
    </div>
    <div class="recast-panel-stream"></div>
    <ul class="recast-panel-devices"><li class="recast-panel-loading">Recherche...</li></ul>
    <button class="recast-panel-stop" style="display:none">⏹ Arrêter</button>
  `;

  document.body.appendChild(panel);

  // Positionner près du bouton
  function positionPanel() {
    const br = anchorBtn.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    let top  = br.bottom + window.scrollY + 6;
    let left = br.right  + window.scrollX - pr.width;
    if (left < 8) left = 8;
    panel.style.top  = top + 'px';
    panel.style.left = left + 'px';
  }
  setTimeout(positionPanel, 0);

  // Afficher le stream détecté
  const streamEl = panel.querySelector('.recast-panel-stream');
  const stream = await browser.runtime.sendMessage({ type: 'GET_STREAM' }).catch(() => null);
  if (stream?.url) {
    streamEl.textContent = '✅ ' + stream.url.split('?')[0].split('/').pop();
    streamEl.title = stream.url;
  } else {
    streamEl.textContent = '⚠ Aucun stream détecté';
  }

  // Charger les appareils
  const deviceList = panel.querySelector('.recast-panel-devices');
  try {
    const res = await fetch(`${getDaemonUrl()}/devices`, { signal: AbortSignal.timeout(6000) });
    const devices = await res.json();
    if (!devices.length) {
      deviceList.innerHTML = '<li class="recast-panel-loading">Aucun appareil</li>';
    } else {
      deviceList.innerHTML = '';
      devices.forEach(device => {
        const li = document.createElement('li');
        li.textContent = `${device.name} (${device.type})`;
        li.addEventListener('click', (e) => {
          e.stopPropagation();
          castToDevice(device, li, stream, panel);
        });
        deviceList.appendChild(li);
      });
    }
  } catch {
    deviceList.innerHTML = '<li class="recast-panel-loading">Daemon hors ligne</li>';
  }

  // Bouton stop
  panel.querySelector('.recast-panel-stop').addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch(`${getDaemonUrl()}/stop`, { method: 'POST' }).catch(() => {});
    cleanup();
  });

  // Fermer
  const closeBtn = panel.querySelector('.recast-panel-close');
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); cleanup(); });

  // Fermer en cliquant en dehors
  const outsideClick = (e) => {
    if (!panel.contains(e.target) && e.target !== anchorBtn) cleanup();
  };
  setTimeout(() => document.addEventListener('click', outsideClick), 100);

  function cleanup() {
    panel.remove();
    document.removeEventListener('click', outsideClick);
    activePanelCleanup = null;
  }
  activePanelCleanup = cleanup;
}

async function castToDevice(device, li, stream, panel) {
  if (!stream?.url) { li.textContent = '❌ Aucun stream'; return; }

  li.textContent = '⏳ Casting...';
  try {
    const res = await fetch(`${getDaemonUrl()}/cast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId:  device.id,
        streamUrl: stream.url,
        referer:   stream.referer,
        title:     document.title
      })
    });
    if (res.ok) {
      li.textContent = `✅ ${device.name}`;
      panel.querySelector('.recast-panel-stop').style.display = 'block';
    } else {
      li.textContent = '❌ Erreur';
    }
  } catch {
    li.textContent = '❌ Daemon hors ligne';
  }
}

// ─── Reporter le src vidéo au background ─────────────────────────────────────

function reportVideoSrc(videoEl) {
  const src = videoEl.src || videoEl.currentSrc;
  if (!src || src.startsWith('blob:') || src.startsWith('data:')) return;
  browser.runtime.sendMessage({ type: 'REPORT_VIDEO_SRC', src, referer: location.href }).catch(() => {});
}

// ─── Observation DOM ──────────────────────────────────────────────────────────

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeName === 'VIDEO') injectOnVideo(node);
      if (node.querySelectorAll) node.querySelectorAll('video').forEach(injectOnVideo);
    }
    if (m.type === 'attributes' && m.target.nodeName === 'VIDEO') reportVideoSrc(m.target);
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

document.querySelectorAll('video').forEach(v => { injectOnVideo(v); reportVideoSrc(v); });

document.addEventListener('loadedmetadata', e => { if (e.target.nodeName === 'VIDEO') reportVideoSrc(e.target); }, true);
document.addEventListener('play',           e => { if (e.target.nodeName === 'VIDEO') reportVideoSrc(e.target); }, true);
