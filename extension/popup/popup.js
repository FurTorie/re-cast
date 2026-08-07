// re:cast - popup.js

const DEFAULT_DAEMON = 'http://192.168.1.14:7171';

// Envoyée à chaque requête : le daemon la journalise, pour qu'un rapport de bug
// indique quelle version de chaque moitié tournait.
const VERSION = browser.runtime.getManifest().version;
const ENTETES = { 'X-Recast-Extension': VERSION };

let DAEMON_URL = DEFAULT_DAEMON;
let currentStream = null;
let selectedId = null;
let editingId = null;   // appareil dont on édite le surnom, le cas échéant

// Appareils enregistrés en local dans l'extension (browser.storage.local).
// Ils survivent au redémarrage du daemon — c'est la source de vérité côté extension.
let saved = [];
// Appareils vus par le daemon lors de la dernière requête (volatiles)
let live = [];

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await browser.storage.local.get(['daemonUrl', 'savedDevices', 'lastDeviceId']);
  DAEMON_URL = stored.daemonUrl || DEFAULT_DAEMON;
  saved      = Array.isArray(stored.savedDevices) ? stored.savedDevices : [];
  selectedId = stored.lastDeviceId || null;

  document.getElementById('daemon-ip-input').value = DAEMON_URL;

  // Afficher immédiatement les appareils enregistrés : aucune attente réseau
  render();

  document.getElementById('btn-cast').addEventListener('click', onCast);
  document.getElementById('btn-stop').addEventListener('click', onStop);
  document.getElementById('btn-scan').addEventListener('click', onScan);
  document.getElementById('btn-add-manual').addEventListener('click', onAddManual);
  document.getElementById('btn-save-daemon').addEventListener('click', saveDaemonUrl);
  document.getElementById('daemon-ip-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveDaemonUrl();
  });

  await loadCurrentStream();
  const online = await checkDaemonStatus();
  if (!online) return;

  // Rafraîchissement rapide : le daemon répond depuis son cache, pas de scan de 4s
  await refreshFromDaemon({ scan: false });
  // Puis un vrai scan, sans bloquer : une TV allumée entre-temps apparaîtra seule
  backgroundScan();
});

// ─── Persistance locale ───────────────────────────────────────────────────────

function persistSaved() {
  return browser.storage.local.set({ savedDevices: saved });
}

function isSaved(id) {
  return saved.some(d => d.id === id);
}

async function toggleSave(device) {
  if (isSaved(device.id)) {
    saved = saved.filter(d => d.id !== device.id);
    if (editingId === device.id) editingId = null;
  } else {
    saved = [...saved, {
      id:   device.id,
      name: device.name,   // nom réseau, resynchronisé à chaque rafraîchissement
      type: device.type,
      host: device.host
      // nickname : ajouté seulement si l'utilisateur en définit un
    }];
  }
  await persistSaved();
  render();
}

// Nom affiché : le surnom prime, sinon le nom réseau
function displayName(device) {
  return device.nickname || device.name || device.host;
}

// Un surnom vide efface le surnom et fait réapparaître le nom réseau
async function renameDevice(id, value) {
  const device = saved.find(d => d.id === id);
  if (!device) return;

  const nickname = value.trim();
  if (nickname && nickname !== device.name) device.nickname = nickname;
  else delete device.nickname;

  editingId = null;
  await persistSaved();
  render();
}

// ─── Daemon ───────────────────────────────────────────────────────────────────

async function saveDaemonUrl() {
  let val = document.getElementById('daemon-ip-input').value.trim();
  if (!val) return;
  // Ajouter http:// si absent
  if (!val.startsWith('http')) val = 'http://' + val;
  // Ajouter :7171 si pas de port
  if (!val.match(/:\d+$/)) val = val + ':7171';

  DAEMON_URL = val;
  await browser.storage.local.set({ daemonUrl: val });
  document.getElementById('daemon-ip-input').value = val;

  await checkDaemonStatus();
  await refreshFromDaemon({ scan: false });
}

async function checkDaemonStatus() {
  const dot = document.getElementById('daemon-status');
  try {
    const res = await fetch(`${DAEMON_URL}/status`, { headers: ENTETES, signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error('status');
    dot.className = 'status-dot online';
    dot.title = 'Daemon connecté';
    return true;
  } catch {
    dot.className = 'status-dot offline';
    dot.title = 'Daemon hors ligne';
    return false;
  }
}

// Récupérer la liste du daemon. scan:false → réponse immédiate depuis son cache.
// scan:true → vraie découverte réseau (~4s), déclenchée par le bouton Rechercher.
async function refreshFromDaemon({ scan }) {
  const url = `${DAEMON_URL}/devices${scan ? '?scan=1' : ''}`;
  try {
    const res = await fetch(url, { headers: ENTETES, signal: AbortSignal.timeout(scan ? 15000 : 4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const devices = await res.json();
    live = Array.isArray(devices) ? devices : [];

    // Un appareil enregistré peut avoir été renommé côté réseau : on resynchronise
    // `name`, jamais `nickname` — sinon le surnom choisi serait écrasé à chaque scan.
    let changed = false;
    live.forEach(d => {
      const s = saved.find(x => x.id === d.id);
      if (s && d.name && s.name !== d.name) { s.name = d.name; changed = true; }
    });
    if (changed) await persistSaved();

    render();
    return true;
  } catch {
    // Échec réseau : on garde la dernière liste connue plutôt que de vider
    // l'affichage — les appareils enregistrés restent castables de toute façon.
    render();
    return false;
  }
}

// Scan complet lancé sans bloquer : la liste se complète toute seule quelques
// secondes après l'ouverture, sans que l'utilisateur ait à appuyer sur Rechercher.
function backgroundScan() {
  const btn = document.getElementById('btn-scan');
  btn.disabled = true;
  btn.textContent = '⏳ Recherche…';
  refreshFromDaemon({ scan: true }).finally(() => {
    btn.textContent = '🔍 Rechercher';
    btn.disabled = false;
  });
}

// ─── Rendu ────────────────────────────────────────────────────────────────────

// Fusion enregistrés + détectés, sans doublon. Les enregistrés passent en premier.
function mergedDevices() {
  const byId = new Map();
  saved.forEach(d => byId.set(d.id, { ...d, saved: true, live: false }));
  live.forEach(d => {
    const existing = byId.get(d.id);
    if (existing) existing.live = true;
    else byId.set(d.id, { ...d, saved: false, live: true });
  });
  return [...byId.values()].sort((a, b) => Number(b.saved) - Number(a.saved));
}

function render() {
  const list = document.getElementById('device-list');
  const devices = mergedDevices();

  list.innerHTML = '';

  if (!devices.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Aucun appareil — lancez une recherche';
    list.appendChild(li);
    updateCastButton();
    return;
  }

  // La sélection mémorisée peut pointer sur un appareil disparu
  if (selectedId && !devices.some(d => d.id === selectedId)) selectedId = null;

  devices.forEach(device => {
    list.appendChild(
      device.id === editingId ? renderEditRow(device) : renderRow(device)
    );
  });

  updateCastButton();
}

function renderRow(device) {
  const li = document.createElement('li');
  li.className = 'device' + (device.id === selectedId ? ' selected' : '');

  const info = document.createElement('div');
  info.className = 'dev-info';

  const name = document.createElement('span');
  name.className = 'dev-name';
  name.textContent = displayName(device);

  const meta = document.createElement('span');
  meta.className = 'dev-meta';
  const bits = [device.type, device.host];
  // Avec un surnom, rappeler le nom réseau pour ne pas perdre de vue l'appareil réel
  if (device.nickname && device.name) bits.push(device.name);
  bits.push(device.live ? 'en ligne' : device.saved ? 'enregistré' : '');
  meta.textContent = bits.filter(Boolean).join(' · ');

  info.append(name, meta);
  li.append(info);

  // Renommer n'a de sens que pour un appareil gardé en local
  if (device.saved) {
    const pencil = document.createElement('button');
    pencil.className = 'dev-btn';
    pencil.textContent = '✏️';
    pencil.title = 'Donner un surnom';
    pencil.addEventListener('click', (e) => {
      e.stopPropagation();
      editingId = device.id;
      render();
    });
    li.append(pencil);
  }

  const star = document.createElement('button');
  star.className = 'dev-star' + (device.saved ? ' on' : '');
  star.textContent = device.saved ? '★' : '☆';
  star.title = device.saved ? 'Oublier cet appareil' : 'Garder cet appareil en local';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSave(device);
  });
  li.append(star);

  li.addEventListener('click', () => selectDevice(device.id));
  return li;
}

// Édition en place plutôt qu'un prompt() : au tactile c'est la seule option correcte
function renderEditRow(device) {
  const li = document.createElement('li');
  li.className = 'device editing';

  const input = document.createElement('input');
  input.className = 'dev-edit';
  input.type = 'text';
  input.value = displayName(device);
  input.placeholder = device.name || device.host;
  input.setAttribute('aria-label', 'Surnom de l\'appareil');

  const commit = () => renameDevice(device.id, input.value);
  const cancel = () => { editingId = null; render(); };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());

  const ok = document.createElement('button');
  ok.className = 'dev-btn';
  ok.textContent = '✓';
  ok.title = 'Valider — vider le champ efface le surnom';
  ok.addEventListener('click', (e) => { e.stopPropagation(); commit(); });

  const ko = document.createElement('button');
  ko.className = 'dev-btn';
  ko.textContent = '✕';
  ko.title = 'Annuler';
  ko.addEventListener('click', (e) => { e.stopPropagation(); cancel(); });

  li.append(input, ok, ko);
  // Le focus doit venir après insertion dans le DOM
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return li;
}

function selectDevice(id) {
  selectedId = id;
  browser.storage.local.set({ lastDeviceId: id }).catch(() => {});
  render();
}

function updateCastButton() {
  document.getElementById('btn-cast').disabled = !(currentStream?.url && selectedId);
}

// ─── Stream ───────────────────────────────────────────────────────────────────

async function loadCurrentStream() {
  currentStream = await browser.runtime.sendMessage({ type: 'GET_STREAM' }).catch(() => null);
  const urlEl = document.getElementById('stream-url');
  if (currentStream?.url) {
    urlEl.textContent = currentStream.url;
    urlEl.className = 'detected';
  } else {
    urlEl.textContent = 'Aucun stream détecté';
    urlEl.className = '';
  }
  updateCastButton();
}

// ─── Recherche réseau ─────────────────────────────────────────────────────────

async function onScan() {
  const btn = document.getElementById('btn-scan');
  btn.disabled = true;
  btn.textContent = '⏳ Recherche…';

  const online = await checkDaemonStatus();
  const ok = online && await refreshFromDaemon({ scan: true });

  btn.textContent = ok ? '🔍 Rechercher' : '❌ Daemon injoignable';
  btn.disabled = false;
  if (!ok) setTimeout(() => { btn.textContent = '🔍 Rechercher'; }, 2500);
}

// ─── Ajout manuel par IP ──────────────────────────────────────────────────────

async function onAddManual() {
  const ipEl   = document.getElementById('manual-ip');
  const nameEl = document.getElementById('manual-name');
  const msg    = document.getElementById('manual-msg');
  const btn    = document.getElementById('btn-add-manual');

  const ip   = ipEl.value.trim();
  const name = nameEl.value.trim();
  if (!ip) return;

  btn.disabled = true;
  btn.textContent = '⏳ Sondage…';
  msg.className = '';
  msg.textContent = '';

  // L'appareil est enregistré en local quoi qu'il arrive : si la TV est éteinte le
  // daemon ne la trouvera pas maintenant, mais il resondera l'IP au moment du cast.
  const fallback = {
    id:   `dlna-${ip.replace(/\./g, '-')}`,
    name: name || `TV (${ip})`,
    type: 'DLNA',
    host: ip
  };

  let device = fallback;
  let warning = null;

  try {
    const res = await fetch(`${DAEMON_URL}/devices/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ENTETES },
      body: JSON.stringify({ ip, name }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    if (res.ok) device = body;
    else warning = body.error || `HTTP ${res.status}`;
  } catch {
    warning = 'daemon injoignable';
  }

  if (!isSaved(device.id)) {
    saved = [...saved, { id: device.id, name: device.name, type: device.type, host: device.host }];
    await persistSaved();
  }
  selectDevice(device.id);

  if (warning) {
    msg.className = 'warn';
    msg.textContent = `Enregistré en local, mais le daemon n'a pas confirmé (${warning}). Le cast resondera l'IP.`;
  } else {
    msg.className = 'ok';
    msg.textContent = 'Appareil trouvé et enregistré.';
    ipEl.value = '';
    nameEl.value = '';
  }

  btn.textContent = 'Ajouter et enregistrer';
  btn.disabled = false;
}

// ─── Cast ─────────────────────────────────────────────────────────────────────

async function onCast() {
  const device = mergedDevices().find(d => d.id === selectedId);
  if (!currentStream?.url || !device) return;

  const btn = document.getElementById('btn-cast');
  btn.disabled = true;
  btn.textContent = '⏳ Casting…';

  try {
    const res = await fetch(`${DAEMON_URL}/cast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ENTETES },
      body: JSON.stringify({
        deviceId:  device.id,
        streamUrl: currentStream.url,
        referer:   currentStream.referer,
        title:     're:cast stream',
        // host + name permettent au daemon de reconstruire l'appareil s'il l'a oublié
        host:      device.host,
        name:      device.name
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (res.ok) {
      btn.textContent = '✅ En lecture';
      document.getElementById('btn-stop').style.display = 'block';
    } else {
      const body = await res.json().catch(() => ({}));
      btn.textContent = '❌ ' + (body.error ? body.error.slice(0, 40) : 'Erreur');
      btn.disabled = false;
    }
  } catch {
    btn.textContent = '❌ Daemon hors ligne';
    btn.disabled = false;
  }
}

async function onStop() {
  try { await fetch(`${DAEMON_URL}/stop`, { method: 'POST', headers: ENTETES }); } catch {}
  document.getElementById('btn-cast').textContent = '📡 Caster';
  document.getElementById('btn-cast').disabled = false;
  document.getElementById('btn-stop').style.display = 'none';
  updateCastButton();
}
