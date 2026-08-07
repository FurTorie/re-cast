// re:cast - popup.js

// localhost plutôt qu'une IP de LAN codée en dur : c'est juste sur le poste qui
// fait tourner le daemon, et sans effet ailleurs — là où « 192.168.1.14 »
// désignait, chez quelqu'un d'autre, une machine au hasard de son réseau.
// Sur téléphone, la détection automatique prend le relais.
const DEFAULT_DAEMON = 'http://localhost:7171';
const PORT_DAEMON = 7171;

// Une adresse n'est retenue que si /status s'annonce re:cast. Un simple HTTP 200
// ne suffit pas : n'importe quel appareil peut écouter sur ce port.
const SIGNATURE = 're:cast';

// Envoyée à chaque requête : le daemon la journalise, pour qu'un rapport de bug
// indique quelle version de chaque moitié tournait.
const VERSION = browser.runtime.getManifest().version;
const ENTETES = { 'X-Recast-Extension': VERSION };

// ─── État ─────────────────────────────────────────────────────────────────────

// Les écrans secondaires REMPLACENT la vue principale au lieu de s'empiler
// dessous : sur la vue plein écran d'Android, un formulaire poussé sous une liste
// d'appareils naîtrait hors de l'écran.
const VUES = {
  principale:    'vue-principale',
  serveurs:      'vue-serveurs',
  ajoutServeur:  'vue-ajout-serveur',
  ajoutAppareil: 'vue-ajout-appareil',
  lecture:       'vue-lecture'
};

let vue = 'principale';

// Serveurs re:cast enregistrés. { id, nom, nomReseau, url, statut, latence }
// `statut` : 'inconnu' | 'enligne' | 'injoignable'
let serveurs = [];
let serveurActifId = null;

// Appareils enregistrés en local dans l'extension (browser.storage.local).
// Ils survivent au redémarrage du daemon — c'est la source de vérité côté extension.
let saved = [];
// Appareils vus par le daemon lors de la dernière requête (volatiles)
let live = [];

let currentStream = null;
let selectedId = null;
let lecture = null;          // état de lecture renvoyé par /status, s'il y en a un

let editingId = null;        // appareil dont on édite le surnom
let editValeur = '';
let editServeurId = null;    // serveur dont on édite le nom
let editServeurValeur = '';
// Le champ d'édition est recréé à CHAQUE rendu, et un rendu peut survenir pendant
// la frappe (fin d'un scan, réponse d'une sonde). Sans ce drapeau, il reprendrait
// le focus et sélectionnerait tout : la frappe suivante effacerait la saisie.
let focusAPrendre = false;

let testEnCours = null;      // id du serveur en cours de test
let detectionEnCours = false;
let scanEnCours = false;
let urlOuverte = false;
let flashTimer = null;

// ─── Icônes ───────────────────────────────────────────────────────────────────
// Construites en DOM plutôt qu'en innerHTML : la même fonction sert aux lignes
// d'appareils, dont le nom vient du réseau. Mélanger balisage et données là-dedans
// n'aurait jamais été sûr.

const NS = 'http://www.w3.org/2000/svg';

const ICONES = {
  'chevron-droite': { taille: 11, trait: 2.4, d: ['m10 6 6 6-6 6'] },
  'chevron-gauche': { taille: 12, trait: 2.4, d: ['m14 6-6 6 6 6'] },
  'chevron-bas':    { taille: 11, trait: 2.5, d: ['m6 9 6 6 6-6'] },
  'check':          { taille: 15, trait: 2.8, d: ['m5 13 4.5 4.5L19 7'] },
  'croix':          { taille: 15, trait: 2.4, d: ['M6 6l12 12M18 6L6 18'] },
  'plus':           { taille: 13, trait: 2.4, d: ['M12 5v14M5 12h14'] },
  'crayon':         { taille: 13, trait: 2,   d: ['M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z'] },
  'poubelle':       { taille: 15, trait: 2,   d: ['M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13'] },
  'etoile':         { taille: 15, trait: 1.8, d: ['m12 3 2.7 5.9 6.3.7-4.7 4.4 1.3 6.4L12 17.2 6.4 20.4l1.3-6.4L3 9.6l6.3-.7z'] },
  'loupe':          { taille: 12, trait: 2.2, d: ['M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0', 'm20 20-3.5-3.5'] },
  'cast':           { taille: 17, trait: 2.2, d: [
    'M3 17.5a3.5 3.5 0 0 1 3.5 3.5',
    'M3 12.5A8.5 8.5 0 0 1 11.5 21',
    'M11.6 3h7.8A1.6 1.6 0 0 1 21 4.6v5.8a1.6 1.6 0 0 1-1.6 1.6h-7.8A1.6 1.6 0 0 1 10 10.4V4.6A1.6 1.6 0 0 1 11.6 3Z'
  ] },
  // Pleines : pas de contour, la forme est le remplissage
  'points':         { taille: 15, plein: true, d: [
    'M7 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'M21 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0'
  ] },
  'stop':           { taille: 15, plein: true, d: ['M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z'] }
};

function icone(nom, options = {}) {
  const spec = ICONES[nom];
  const taille = options.taille || spec.taille;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', taille);
  svg.setAttribute('height', taille);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  // L'étoile bascule entre contour et plein selon que l'appareil est épinglé
  const plein = options.plein ?? spec.plein;
  svg.setAttribute('fill', plein ? 'currentColor' : 'none');
  if (!plein) {
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', spec.trait);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }

  spec.d.forEach(d => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

// Un bouton d'action de ligne : icône seule, cible tactile portée par le CSS
function boutonIcone(nom, titre, classe, onClick, options) {
  const btn = document.createElement('button');
  btn.className = 'ligne-btn' + (classe ? ' ' + classe : '');
  btn.title = titre;
  btn.setAttribute('aria-label', titre);
  btn.appendChild(icone(nom, options));
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return btn;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Icônes statiques déclarées dans le HTML
  document.querySelectorAll('[data-ico]').forEach(el => {
    const taille = el.dataset.taille ? Number(el.dataset.taille) : undefined;
    el.appendChild(icone(el.dataset.ico, { taille }));
  });

  const stored = await browser.storage.local.get([
    'servers', 'activeServerId', 'daemonUrl', 'savedDevices', 'lastDeviceId'
  ]);

  saved      = Array.isArray(stored.savedDevices) ? stored.savedDevices : [];
  selectedId = stored.lastDeviceId || null;
  chargerServeurs(stored);
  await rattacherAppareilsAnciens();

  brancherEvenements();

  // Afficher immédiatement ce qu'on sait déjà : aucune attente réseau
  await chargerFlux();
  rendre();

  // Puis se connecter — c'est le seul endroit qui a le droit d'être lent
  const status = await connecter();
  if (status?.lecture) {
    lecture = status.lecture;
    vue = 'lecture';
  }
  rendre();

  if (!serveurEnLigne()) return;

  // Rafraîchissement rapide : le daemon répond depuis son cache, pas de scan de 4s
  await rafraichirAppareils({ scan: false });
  // Puis un vrai scan, sans bloquer : une TV allumée entre-temps apparaîtra seule
  scanArrierePlan();
});

function brancherEvenements() {
  const clic = (id, fn) => document.getElementById(id).addEventListener('click', fn);

  clic('btn-serveurs',   () => aller('serveurs'));
  clic('btn-reparer',    () => { aller('serveurs'); lancerDetection(); });
  document.querySelectorAll('[data-retour]').forEach(btn => {
    btn.addEventListener('click', () => aller(btn.dataset.retour));
  });

  clic('btn-ouvrir-ajout-serveur', () => aller('ajoutServeur'));
  clic('btn-ajouter-serveur',      ajouterServeur);
  clic('btn-detecter',             lancerDetection);

  clic('btn-url', () => { urlOuverte = !urlOuverte; rendre(); });
  clic('btn-rechercher', onRechercher);
  clic('btn-ouvrir-ajout-appareil', () => aller('ajoutAppareil'));
  clic('btn-ajouter-appareil', ajouterAppareil);

  clic('btn-caster',  onCaster);
  clic('btn-arreter', onArreter);
  clic('btn-changer', () => { lecture = null; aller('principale'); });

  // Entrée valide le formulaire courant : au clavier comme au tactile, c'est le
  // geste attendu après avoir rempli le dernier champ.
  valideSurEntree(['serveur-nom', 'serveur-url'], ajouterServeur);
  valideSurEntree(['appareil-ip', 'appareil-nom'], ajouterAppareil);
}

function valideSurEntree(ids, fn) {
  ids.forEach(id => document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fn(); }
  }));
}

function aller(nouvelleVue) {
  vue = nouvelleVue;
  editingId = null;
  editServeurId = null;
  // Le compte rendu du dernier balayage ne doit pas survivre à la navigation :
  // relire « Aucun daemon trouvé » à la visite suivante décrirait un état passé.
  document.getElementById('detect-hint').hidden = true;
  rendre();
}

// ─── Serveurs re:cast ─────────────────────────────────────────────────────────
// L'extension gère plusieurs daemons — un par lieu, ou par machine. Le daemon,
// lui, n'en sait rien : il ne connaît pas ses pairs et n'a rien à persister.
// C'est l'extension qui garde la liste, comme elle garde déjà les appareils.

function chargerServeurs(stored) {
  serveurs = Array.isArray(stored.servers) ? stored.servers : [];

  // Reprise d'une installation antérieure, qui ne connaissait qu'une adresse.
  if (!serveurs.length) {
    const url = stored.daemonUrl || DEFAULT_DAEMON;
    serveurs = [creerServeur(url)];
  }

  serveurActifId = stored.activeServerId && serveurs.some(s => s.id === stored.activeServerId)
    ? stored.activeServerId
    : serveurs[0].id;
}

function creerServeur(url, nom) {
  return {
    id: 'srv-' + url.replace(/[^\w]+/g, '-'),
    nom: nom || null,      // surnom choisi par l'utilisateur — jamais écrasé
    nomReseau: null,       // nom de machine annoncé par /status, resynchronisé
    url,
    statut: 'inconnu',
    latence: null
  };
}

function serveurActif() {
  return serveurs.find(s => s.id === serveurActifId) || null;
}

function serveurEnLigne() {
  return serveurActif()?.statut === 'enligne';
}

function urlDaemon() {
  return serveurActif()?.url || DEFAULT_DAEMON;
}

// Comme pour les appareils : le surnom prime, sinon le nom réseau, sinon l'hôte.
function nomServeur(s) {
  return s.nom || s.nomReseau || s.url.replace(/^https?:\/\//, '');
}

function persisterServeurs() {
  // `daemonUrl` n'est plus écrite : plus personne ne la lit depuis la suppression
  // du panneau injecté, qui en était le seul autre consommateur. Elle est encore
  // LUE au premier chargement, et seulement là — c'est la reprise des
  // installations antérieures. Voir chargerServeurs().
  return browser.storage.local.set({
    servers: serveurs,
    activeServerId: serveurActifId
  });
}

function normaliserUrl(valeur) {
  // La barre finale est retirée avant le test de port : sans ça, « 192.168.1.20/ »
  // ne ressemblait pas à une adresse portée et devenait « …:7171/:7171 ».
  let v = valeur.trim().replace(/\/+$/, '');
  if (!v) return null;
  if (!/^https?:\/\//.test(v)) v = 'http://' + v;
  // Le port est ajouté s'il manque — sans lui, on interrogerait le port 80.
  if (!/:\d+$/.test(v.replace(/^https?:\/\//, ''))) v += ':' + PORT_DAEMON;
  return v;
}

// Sonde un serveur et met à jour son statut. Retourne le corps de /status, ou null.
async function sonderServeur(s, delai = 2500) {
  const debut = performance.now();
  try {
    const res = await fetch(`${s.url}/status`, { headers: ENTETES, signal: AbortSignal.timeout(delai) });
    if (!res.ok) throw new Error('status');
    const corps = await res.json();
    if (!corps || corps.app !== SIGNATURE) throw new Error('signature');

    s.statut = 'enligne';
    s.latence = Math.round(performance.now() - debut);
    if (corps.nom) s.nomReseau = corps.nom;
    return corps;
  } catch {
    s.statut = 'injoignable';
    s.latence = null;
    return null;
  }
}

// Bascule automatique : on essaie l'actif, puis tous les autres, puis le réseau.
// C'est ce qui fait qu'un aller-retour maison / bureau ne demande aucun réglage.
async function connecter() {
  const actif = serveurActif();
  if (actif) {
    const status = await sonderServeur(actif);
    if (status) return status;
  }

  const autres = serveurs.filter(s => s !== actif);
  if (autres.length) {
    // En parallèle : sonder en série ferait payer un délai d'attente par serveur
    // injoignable, alors qu'ils le sont tous en même temps quand on change de réseau.
    const reponses = await Promise.all(autres.map(s => sonderServeur(s)));
    // Le premier de la liste qui répond, pas le plus rapide : l'ordre de la liste
    // est celui que l'utilisateur a choisi.
    const i = reponses.findIndex(Boolean);
    if (i !== -1) {
      serveurActifId = autres[i].id;
      await persisterServeurs();
      return reponses[i];
    }
  }

  // Dernier recours : le daemon a peut-être simplement changé d'IP.
  const trouve = await lancerDetection({ silencieux: true });
  return trouve ? sonderServeur(serveurActif()) : null;
}

async function testerServeur(s) {
  if (testEnCours) return;
  testEnCours = s.id;
  rendre();
  await sonderServeur(s);
  testEnCours = null;
  await persisterServeurs();
  rendre();
}

// ─── Détection automatique du daemon ─────────────────────────────────────────
// Pas de mDNS ici : une extension n'a aucune API de socket UDP. Mais avec la
// permission d'hôte universelle, fetch() n'est pas soumis au CORS et peut donc
// interroger une IP du réseau local en HTTP. On sonde, et on identifie par la
// signature de /status.

async function sonder(url, delai) {
  try {
    const res = await fetch(`${url}/status`, {
      headers: ENTETES,
      signal: AbortSignal.timeout(delai)
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.app === SIGNATURE ? j : null;
  } catch {
    return null;
  }
}

// Les sous-réseaux à explorer, du plus probable au moins probable.
//
// Le meilleur indice n'est pas une plage standard mais les adresses déjà connues :
// une TV castée un jour est forcément sur le même réseau que le daemon, et un
// serveur enregistré désigne un réseau qu'on fréquente. Vient ensuite le
// sous-réseau du serveur actif, qui suffit quand seule la fin de l'IP a changé
// après un bail DHCP — de loin le cas le plus fréquent. Les plages génériques ne
// servent qu'au tout premier lancement.
function sousReseaux() {
  const vus = [];
  // Deux entrées distinctes, et c'est nécessaire : une IP d'appareil porte
  // quatre octets, une plage de repli n'en a que trois. Une seule fonction
  // exigeant quatre octets rejetait silencieusement TOUTES les plages de repli,
  // et le premier lancement — précisément le cas où le balayage sert — ne
  // sondait rien du tout.
  const ajouterPrefixe = (p) => { if (p && !vus.includes(p)) vus.push(p); };
  const depuisIp = (ip) => {
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip || '');
    if (m) ajouterPrefixe(m[1]);
  };

  // `saved` en entier, sans filtrer sur le serveur actif — contrairement à
  // l'affichage. Ici on cherche un daemon, n'importe lequel : une TV enregistrée
  // sous un autre serveur désigne justement un réseau qu'on fréquente, et c'est
  // exactement l'indice qui manque quand celui d'aujourd'hui ne répond pas.
  saved.forEach(d => depuisIp(d.host));
  serveurs.forEach(s => depuisIp((s.url.match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1]));
  ['192.168.1', '192.168.0', '10.0.0', '192.168.2'].forEach(ajouterPrefixe);

  return vus;
}

// Sonde un /24 par lots. Un port fermé sur le LAN est refusé en quelques
// millisecondes ; seules les IP inexistantes vont au bout du délai, d'où un
// délai court et beaucoup de requêtes en parallèle.
async function balayer(prefixe, delai = 1200, lot = 32) {
  for (let debut = 1; debut < 255; debut += lot) {
    const cibles = [];
    for (let i = debut; i < Math.min(debut + lot, 255); i++) {
      cibles.push(`http://${prefixe}.${i}:${PORT_DAEMON}`);
    }
    const resultats = await Promise.all(
      cibles.map(async url => {
        const status = await sonder(url, delai);
        return status ? { url, status } : null;
      })
    );
    const trouve = resultats.find(Boolean);
    if (trouve) return trouve;
  }
  return null;
}

// Retourne { url, status } ou null. `annoncer` sert à tenir l'utilisateur informé :
// un balayage peut prendre plusieurs secondes et un popup muet passerait pour figé.
async function detecterDaemon(annoncer = () => {}) {
  // 1. Les adresses directes d'abord : instantanées, et localhost suffit sur le
  //    poste qui héberge le daemon.
  annoncer('Recherche du daemon…');
  const directes = [...serveurs.map(s => s.url), DEFAULT_DAEMON, `http://127.0.0.1:${PORT_DAEMON}`];
  for (const url of [...new Set(directes)]) {
    const status = await sonder(url, 1500);
    if (status) return { url, status };
  }

  // 2. Balayage des sous-réseaux plausibles.
  const prefixes = sousReseaux();
  for (let i = 0; i < prefixes.length; i++) {
    annoncer(`Balayage ${prefixes[i]}.0/24  (${i + 1}/${prefixes.length})…`);
    const trouve = await balayer(prefixes[i]);
    if (trouve) return trouve;
  }
  return null;
}

// Enregistre le daemon détecté, ou recolle l'entrée existante sur sa nouvelle IP.
function integrerDetection(url, status) {
  const parUrl = serveurs.find(s => s.url === url);
  if (parUrl) {
    if (status.nom) parUrl.nomReseau = status.nom;
    return parUrl;
  }

  // Même machine, adresse différente : c'est un bail DHCP renouvelé, pas un
  // second serveur. Sans ce recollage la liste grossirait d'une ligne morte à
  // chaque changement d'IP.
  const parNom = status.nom && serveurs.find(s => s.nomReseau === status.nom);
  if (parNom) {
    parNom.url = url;
    return parNom;
  }

  const nouveau = creerServeur(url);
  nouveau.nomReseau = status.nom || null;
  serveurs.push(nouveau);
  return nouveau;
}

async function lancerDetection({ silencieux = false } = {}) {
  if (detectionEnCours) return null;
  detectionEnCours = true;

  const hint = document.getElementById('detect-hint');
  const annoncer = (t) => {
    if (silencieux) return;
    hint.hidden = false;
    hint.textContent = t;
  };

  rendre();
  try {
    const trouve = await detecterDaemon(annoncer);
    if (!trouve) {
      annoncer('Aucun daemon trouvé — vérifie qu\'il tourne, ou ajoute-le par son adresse.');
      return null;
    }

    const serveur = integrerDetection(trouve.url, trouve.status);
    serveur.statut = 'enligne';
    serveurActifId = serveur.id;
    await persisterServeurs();
    annoncer(`Daemon trouvé : ${nomServeur(serveur)}`);
    return serveur;
  } finally {
    detectionEnCours = false;
    rendre();
  }
}

async function ajouterServeur() {
  const champNom = document.getElementById('serveur-nom');
  const champUrl = document.getElementById('serveur-url');
  const msg = document.getElementById('serveur-msg');

  const url = normaliserUrl(champUrl.value);
  if (!url) {
    msg.hidden = false;
    msg.className = 'msg';
    msg.textContent = 'Saisis une adresse.';
    return;
  }

  let serveur = serveurs.find(s => s.url === url);
  if (!serveur) {
    serveur = creerServeur(url, champNom.value.trim() || null);
    serveurs.push(serveur);
  } else if (champNom.value.trim()) {
    serveur.nom = champNom.value.trim();
  }

  serveurActifId = serveur.id;
  champNom.value = '';
  champUrl.value = '';
  msg.hidden = true;

  await persisterServeurs();
  aller('serveurs');

  // Sonder tout de suite : une adresse saisie à la main est souvent une faute de
  // frappe, autant le dire maintenant plutôt qu'à la première tentative de cast.
  await sonderServeur(serveur);
  await persisterServeurs();
  rendre();
}

async function oublierServeur(s) {
  serveurs = serveurs.filter(x => x.id !== s.id);
  if (serveurActifId === s.id) serveurActifId = serveurs[0]?.id || null;
  if (editServeurId === s.id) editServeurId = null;

  // Ses appareils partent avec lui. Rattachés à un serveur qui n'existe plus,
  // ils n'auraient plus aucun moyen de réapparaître : ils grossiraient le
  // stockage à jamais sans jamais s'afficher.
  saved = saved.filter(d => d.serverId !== s.id);

  await Promise.all([persisterServeurs(), persisterAppareils()]);
  rendre();
}

async function choisirServeur(s) {
  if (serveurActifId === s.id) return;
  serveurActifId = s.id;
  live = [];
  await persisterServeurs();
  rendre();

  if (await sonderServeur(s)) await rafraichirAppareils({ scan: false });
  await persisterServeurs();
  rendre();
}

// Un nom vide efface le surnom et fait réapparaître le nom réseau
async function renommerServeur(s, valeur) {
  const nom = valeur.trim();
  s.nom = (nom && nom !== s.nomReseau) ? nom : null;
  editServeurId = null;
  await persisterServeurs();
  rendre();
}

// ─── Appareils : persistance locale ───────────────────────────────────────────

// Un appareil enregistré appartient AU SERVEUR QUI L'A VU, jamais à l'extension
// en général. Deux daemons sur un même réseau voient les mêmes TV, parfois sous
// des adresses différentes — l'un via le Wi-Fi, l'autre via un partage de
// connexion. Une liste commune affichait alors les deux jeux d'entrées empilés,
// et la même TV apparaissait plusieurs fois sans qu'on puisse démêler laquelle
// venait d'où. Toutes les lectures de `saved` passent donc par ces deux
// fonctions ; y accéder directement réintroduirait le mélange.
function appareilsDuServeur() {
  return saved.filter(d => d.serverId === serveurActifId);
}

function trouverEnregistre(id) {
  return saved.find(d => d.id === id && d.serverId === serveurActifId);
}

// Reprise des installations d'avant le multi-serveurs : ces entrées n'ont pas de
// serverId. Elles sont rattachées au serveur actif au chargement — c'est bien
// celui sous lequel elles ont été enregistrées, puisqu'il n'y en avait qu'un.
async function rattacherAppareilsAnciens() {
  let change = false;
  saved.forEach(d => {
    if (!d.serverId) { d.serverId = serveurActifId; change = true; }
  });
  if (change) await persisterAppareils();
}

function persisterAppareils() {
  return browser.storage.local.set({ savedDevices: saved });
}

function estEnregistre(id) {
  return !!trouverEnregistre(id);
}

function enregistrer(device) {
  if (estEnregistre(device.id)) return;
  saved = [...saved, {
    id:   device.id,
    name: device.name,   // nom réseau, resynchronisé à chaque rafraîchissement
    type: device.type,
    host: device.host,
    serverId: serveurActifId
    // nickname : ajouté seulement si l'utilisateur en définit un
  }];
}

async function basculerEnregistrement(device) {
  if (estEnregistre(device.id)) {
    saved = saved.filter(d => !(d.id === device.id && d.serverId === serveurActifId));
    if (editingId === device.id) editingId = null;
  } else {
    enregistrer(device);
  }
  await persisterAppareils();
  rendre();
}

// Nom affiché : le surnom prime, sinon le nom réseau
function nomAppareil(device) {
  return device.nickname || device.name || device.host;
}

// Un surnom vide efface le surnom et fait réapparaître le nom réseau
async function renommerAppareil(id, valeur) {
  // Nommer un appareil, c'est vouloir le garder : s'il n'était pas encore
  // enregistré, le surnom n'aurait nulle part où survivre.
  const vu = appareilsFusionnes().find(d => d.id === id);
  if (vu && !estEnregistre(id)) enregistrer(vu);

  const device = trouverEnregistre(id);
  if (device) {
    const nickname = valeur.trim();
    if (nickname && nickname !== device.name) device.nickname = nickname;
    else delete device.nickname;
  }

  editingId = null;
  await persisterAppareils();
  rendre();
}

async function oublierAppareil(id) {
  saved = saved.filter(d => !(d.id === id && d.serverId === serveurActifId));
  if (selectedId === id) selectedId = null;
  editingId = null;
  await persisterAppareils();
  rendre();
}

// ─── Appareils : daemon ───────────────────────────────────────────────────────

// Récupérer la liste du daemon. scan:false → réponse immédiate depuis son cache.
// scan:true → vraie découverte réseau (~4s), déclenchée par le bouton Rechercher.
async function rafraichirAppareils({ scan }) {
  const url = `${urlDaemon()}/devices${scan ? '?scan=1' : ''}`;
  try {
    const res = await fetch(url, { headers: ENTETES, signal: AbortSignal.timeout(scan ? 15000 : 4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const devices = await res.json();
    live = Array.isArray(devices) ? devices : [];

    // Un appareil enregistré peut avoir été renommé côté réseau : on resynchronise
    // `name`, jamais `nickname` — sinon le surnom choisi serait écrasé à chaque scan.
    let change = false;
    live.forEach(d => {
      const s = trouverEnregistre(d.id);
      if (s && d.name && s.name !== d.name) { s.name = d.name; change = true; }
    });
    if (change) await persisterAppareils();

    rendre();
    return true;
  } catch {
    // Échec réseau : on garde la dernière liste connue plutôt que de vider
    // l'affichage — les appareils enregistrés restent castables de toute façon.
    rendre();
    return false;
  }
}

// Scan complet lancé sans bloquer : la liste se complète toute seule quelques
// secondes après l'ouverture, sans que l'utilisateur ait à appuyer sur Rechercher.
function scanArrierePlan() {
  scanEnCours = true;
  rendre();
  rafraichirAppareils({ scan: true }).finally(() => {
    scanEnCours = false;
    rendre();
  });
}

async function onRechercher() {
  if (scanEnCours) return;
  scanEnCours = true;
  rendre();

  const actif = serveurActif();
  const enLigne = actif && await sonderServeur(actif);
  if (enLigne) await rafraichirAppareils({ scan: true });

  scanEnCours = false;
  await persisterServeurs();
  rendre();
}

// Fusion enregistrés + détectés, sans doublon. Les enregistrés passent en premier.
// Les enregistrés sont ceux DU SERVEUR ACTIF : `live` ne vient que de lui, mêler
// les deux sources reviendrait à comparer des appareils vus depuis deux réseaux.
function appareilsFusionnes() {
  const parId = new Map();
  appareilsDuServeur().forEach(d => parId.set(d.id, { ...d, saved: true, live: false }));
  live.forEach(d => {
    const existant = parId.get(d.id);
    if (existant) existant.live = true;
    else parId.set(d.id, { ...d, saved: false, live: true });
  });
  return [...parId.values()].sort((a, b) => Number(b.saved) - Number(a.saved));
}

function choisirAppareil(id) {
  selectedId = id;
  browser.storage.local.set({ lastDeviceId: id }).catch(() => {});
  rendre();
}

// ─── Flux ─────────────────────────────────────────────────────────────────────

async function chargerFlux() {
  currentStream = await browser.runtime.sendMessage({ type: 'GET_STREAM' }).catch(() => null);
}

function typeFlux(url) {
  const sansQuery = (url || '').split('?')[0].toLowerCase();
  if (sansQuery.endsWith('.m3u8')) return 'HLS';
  if (sansQuery.endsWith('.mpd'))  return 'DASH';
  if (sansQuery.endsWith('.mp4'))  return 'MP4';
  if (sansQuery.endsWith('.webm')) return 'WEBM';
  return 'FLUX';
}

// Les deux derniers labels de l'hôte : `prx-1559-ant.vmpx.online` se lit
// `vmpx.online`. C'est une approximation — l'URL complète est juste en dessous,
// dépliable, donc mieux vaut ici un repère lisible qu'une exactitude illisible.
function domaineFlux(url) {
  try {
    const hote = new URL(url).hostname;
    const parts = hote.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : hote;
  } catch {
    return url;
  }
}

// Dernier segment de chemin, sans extension : « index-v1-a1 »
function fichierFlux(url) {
  try {
    const chemin = new URL(url).pathname;
    const dernier = chemin.split('/').filter(Boolean).pop() || '';
    return dernier.replace(/\.[^.]+$/, '');
  } catch {
    return '';
  }
}

// ─── Rendu ────────────────────────────────────────────────────────────────────

function rendre() {
  Object.entries(VUES).forEach(([nom, id]) => {
    document.getElementById(id).hidden = (nom !== vue);
  });

  rendrePastille();

  // Le bandeau ne concerne que la vue principale : dans l'écran des serveurs, la
  // liste dit déjà lequel répond, et le répéter au-dessus n'apprendrait rien.
  document.getElementById('bandeau-injoignable').hidden = !(vue === 'principale' && !serveurEnLigne());

  if (vue === 'serveurs')   rendreServeurs();
  if (vue === 'principale') rendrePrincipale();
  if (vue === 'lecture')    rendreLecture();
}

function rendrePastille() {
  const actif = serveurActif();
  document.getElementById('pastille-point').className =
    'pastille-point' + (actif?.statut === 'enligne' ? ' enligne' : '');
  document.getElementById('pastille-nom').textContent =
    actif ? nomServeur(actif) : 'Aucun serveur';
}

// ── Vue : serveurs ──

function rendreServeurs() {
  const liste = document.getElementById('liste-serveurs');
  liste.textContent = '';

  if (!serveurs.length) {
    liste.appendChild(vide('Aucun serveur — lance une détection'));
  } else {
    serveurs.forEach(s => liste.appendChild(
      s.id === editServeurId ? ligneServeurEdition(s) : ligneServeur(s)
    ));
  }

  const btn = document.getElementById('btn-detecter');
  btn.disabled = detectionEnCours;
  document.getElementById('detect-label').textContent =
    detectionEnCours ? 'Balayage du réseau…' : 'Détecter sur le réseau';
}

function ligneServeur(s) {
  const li = document.createElement('li');
  li.className = 'ligne ligne-serveur' + (s.id === serveurActifId ? ' active' : '');
  li.addEventListener('click', () => choisirServeur(s));

  const puce = document.createElement('span');
  puce.className = 'puce';
  if (s.id === serveurActifId) puce.appendChild(icone('check', { taille: 9 }));

  const infos = document.createElement('div');
  infos.className = 'ligne-infos';

  const tete = document.createElement('div');
  tete.className = 'serveur-tete';

  const nom = document.createElement('span');
  nom.className = 'serveur-nom';
  nom.textContent = nomServeur(s);

  const statut = document.createElement('span');
  const enTest = testEnCours === s.id;
  statut.className = 'serveur-statut' + (enTest ? '' : ' ' + (s.statut === 'enligne' ? 'enligne' : s.statut === 'injoignable' ? 'injoignable' : ''));
  statut.textContent = enTest ? 'Test en cours…'
    : s.statut === 'enligne'     ? `En ligne · ${s.latence} ms`
    : s.statut === 'injoignable' ? 'Injoignable'
    : 'Non testé';

  tete.append(nom, statut);

  const url = document.createElement('span');
  url.className = 'serveur-url';
  url.textContent = s.url.replace(/^https?:\/\//, '');

  infos.append(tete, url);

  const test = document.createElement('button');
  test.className = 'btn-tester';
  test.textContent = enTest ? 'Test…' : 'Tester';
  test.disabled = !!testEnCours;
  test.addEventListener('click', (e) => { e.stopPropagation(); testerServeur(s); });

  li.append(
    puce,
    infos,
    test,
    boutonIcone('crayon', 'Renommer ce serveur', null, () => {
      editServeurId = s.id;
      editServeurValeur = nomServeur(s);
      focusAPrendre = true;
      rendre();
    }),
    boutonIcone('poubelle', 'Oublier ce serveur', 'oubli', () => oublierServeur(s), { taille: 13 })
  );
  return li;
}

function ligneServeurEdition(s) {
  const li = document.createElement('li');
  li.className = 'ligne-serveur ligne-edition';

  const input = champEdition(editServeurValeur, s.nomReseau || s.url, 'Nom du serveur', {
    onInput: (v) => { editServeurValeur = v; },
    onValider: () => renommerServeur(s, editServeurValeur),
    onAnnuler: () => { editServeurId = null; rendre(); }
  });

  li.append(
    input,
    boutonIcone('croix', 'Annuler', null, () => { editServeurId = null; rendre(); }, { taille: 14 }),
    boutonIcone('check', 'Valider', 'valider', () => renommerServeur(s, editServeurValeur), { taille: 14 })
  );
  return li;
}

// ── Vue principale ──

function rendrePrincipale() {
  rendreFlux();
  rendreAppareils();

  document.getElementById('rechercher-label').textContent = scanEnCours ? 'Recherche…' : 'Rechercher';
  document.getElementById('btn-rechercher').disabled = scanEnCours;

  const device = appareilsFusionnes().find(d => d.id === selectedId);
  const btn = document.getElementById('btn-caster');
  const label = document.getElementById('caster-label');

  if (!currentStream?.url) {
    label.textContent = 'Aucun flux détecté';
    btn.disabled = true;
  } else if (!device) {
    label.textContent = 'Choisis un appareil';
    btn.disabled = true;
  } else {
    label.textContent = 'Caster sur ' + nomAppareil(device);
    btn.disabled = false;
  }
}

function rendreFlux() {
  const badge   = document.getElementById('flux-type');
  const domaine = document.getElementById('flux-domaine');
  const brute   = document.getElementById('flux-url');
  const chevron = document.getElementById('url-chevron');
  const url     = currentStream?.url;

  badge.hidden = !url;
  if (url) badge.textContent = typeFlux(url);

  domaine.textContent = url ? domaineFlux(url) : 'Aucun flux détecté';
  domaine.className = 'flux-domaine' + (url ? '' : ' vide');

  document.getElementById('btn-url').hidden = !url;
  brute.hidden = !(url && urlOuverte);
  brute.textContent = url || '';
  chevron.className = 'ico' + (urlOuverte ? ' ouvert' : '');
}

function rendreAppareils() {
  const liste = document.getElementById('liste-appareils');
  const devices = appareilsFusionnes();
  liste.textContent = '';

  // La sélection mémorisée peut pointer sur un appareil disparu
  if (selectedId && !devices.some(d => d.id === selectedId)) selectedId = null;

  if (!devices.length) {
    liste.appendChild(vide('Aucun appareil — lance une recherche'));
    return;
  }

  devices.forEach(d => liste.appendChild(
    d.id === editingId ? ligneAppareilEdition(d) : ligneAppareil(d)
  ));
}

function ligneAppareil(d) {
  const li = document.createElement('li');
  const eteint = d.saved && !d.live;
  li.className = 'ligne ligne-appareil'
    + (d.id === selectedId ? ' active' : '')
    + (eteint ? ' eteint' : '');
  li.addEventListener('click', () => choisirAppareil(d.id));

  const puce = document.createElement('span');
  puce.className = 'puce';
  if (d.id === selectedId) puce.appendChild(icone('check', { taille: 11 }));

  const infos = document.createElement('div');
  infos.className = 'ligne-infos';

  const nom = document.createElement('span');
  nom.className = 'ligne-nom';
  nom.textContent = nomAppareil(d);

  const meta = document.createElement('span');
  meta.className = 'ligne-meta';
  const bouts = [d.type, d.host];
  // Avec un surnom, rappeler le nom réseau pour ne pas perdre de vue l'appareil réel
  if (d.nickname && d.name) bouts.push(d.name);
  if (eteint) bouts.push('éteinte');
  meta.textContent = bouts.filter(Boolean).join(' · ');

  infos.append(nom, meta);

  const etoile = boutonIcone(
    'etoile',
    d.saved ? 'Retirer des favoris' : 'Ajouter aux favoris',
    'etoile' + (d.saved ? ' on' : ''),
    () => basculerEnregistrement(d),
    { plein: d.saved }
  );

  li.append(
    puce,
    infos,
    etoile,
    boutonIcone('points', 'Renommer ou oublier cet appareil', null, () => {
      editingId = d.id;
      editValeur = nomAppareil(d);
      focusAPrendre = true;
      rendre();
    })
  );
  return li;
}

function ligneAppareilEdition(d) {
  const li = document.createElement('li');
  li.className = 'ligne-appareil ligne-edition';

  const input = champEdition(editValeur, d.name || d.host, 'Surnom de l\'appareil', {
    onInput: (v) => { editValeur = v; },
    onValider: () => renommerAppareil(d.id, editValeur),
    onAnnuler: () => { editingId = null; rendre(); }
  });

  li.append(input);
  // Oublier n'a de sens que pour un appareil gardé en local ; sur un appareil
  // simplement détecté, la corbeille ne ferait rien de durable — il reviendrait
  // à la recherche suivante.
  if (d.saved) {
    li.append(boutonIcone('poubelle', 'Oublier cet appareil', 'oubli', () => oublierAppareil(d.id)));
  }
  li.append(
    boutonIcone('croix', 'Annuler', null, () => { editingId = null; rendre(); }),
    boutonIcone('check', 'Valider — vider le champ efface le surnom', 'valider',
      () => renommerAppareil(d.id, editValeur))
  );
  return li;
}

// Édition en place plutôt qu'un prompt() : au tactile c'est la seule option correcte
function champEdition(valeur, placeholder, aria, { onInput, onValider, onAnnuler }) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = valeur;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', aria);

  // La valeur vit dans l'état, pas dans le DOM : un rendu déclenché pendant la
  // frappe recréerait le champ et perdrait la saisie.
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); onValider(); }
    if (e.key === 'Escape') { e.preventDefault(); onAnnuler(); }
  });

  // Une seule fois par édition, à l'entrée : le focus doit venir après insertion
  // dans le DOM, mais le reprendre à chaque rendu déplacerait le curseur.
  if (focusAPrendre) {
    focusAPrendre = false;
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  return input;
}

function vide(texte) {
  const li = document.createElement('li');
  li.className = 'liste-vide';
  li.textContent = texte;
  return li;
}

// ── Vue : lecture ──

function rendreLecture() {
  const url = lecture?.url || currentStream?.url;

  document.getElementById('lecture-nom').textContent = lecture?.deviceName || '—';
  document.getElementById('lecture-meta').textContent =
    [lecture?.protocole, lecture?.host].filter(Boolean).join(' · ');

  const badge = document.getElementById('lecture-type');
  badge.hidden = !url;
  if (url) badge.textContent = typeFlux(url);

  document.getElementById('lecture-source').textContent =
    url ? [domaineFlux(url), fichierFlux(url)].filter(Boolean).join(' · ') : '';
}

function flash(texte) {
  const el = document.getElementById('flash');
  el.hidden = !texte;
  el.textContent = texte;
  clearTimeout(flashTimer);
  if (texte) flashTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

// ─── Ajout manuel d'un appareil par IP ────────────────────────────────────────

async function ajouterAppareil() {
  const champIp  = document.getElementById('appareil-ip');
  const champNom = document.getElementById('appareil-nom');
  const msg      = document.getElementById('appareil-msg');
  const btn      = document.getElementById('btn-ajouter-appareil');
  const label    = document.getElementById('ajout-appareil-label');

  const ip  = champIp.value.trim();
  const nom = champNom.value.trim();
  if (!ip) {
    msg.hidden = false;
    msg.className = 'msg';
    msg.textContent = 'Saisis une adresse IP.';
    return;
  }

  btn.disabled = true;
  label.textContent = 'Sondage…';
  msg.hidden = true;

  // L'appareil est enregistré en local quoi qu'il arrive : si la TV est éteinte le
  // daemon ne la trouvera pas maintenant, mais il resondera l'IP au moment du cast.
  let device = {
    id:   `dlna-${ip.replace(/\./g, '-')}`,
    name: nom || `TV (${ip})`,
    type: 'DLNA',
    host: ip
  };
  let avertissement = null;

  try {
    const res = await fetch(`${urlDaemon()}/devices/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ENTETES },
      body: JSON.stringify({ ip, name: nom }),
      signal: AbortSignal.timeout(15000)
    });
    const corps = await res.json();
    if (res.ok) device = corps;
    else avertissement = corps.error || `HTTP ${res.status}`;
  } catch {
    avertissement = 'daemon injoignable';
  }

  enregistrer(device);
  await persisterAppareils();
  selectedId = device.id;
  browser.storage.local.set({ lastDeviceId: device.id }).catch(() => {});

  btn.disabled = false;
  label.textContent = 'Ajouter et enregistrer';

  if (avertissement) {
    // On reste sur le formulaire : l'avertissement porte sur ce qui vient d'y être
    // saisi, et le renvoyer à la liste le ferait disparaître avant d'être lu.
    msg.hidden = false;
    msg.className = 'msg';
    msg.textContent = `Enregistré en local, mais le daemon n'a pas confirmé (${avertissement}). Le cast resondera l'IP.`;
    rendre();
    return;
  }

  champIp.value = '';
  champNom.value = '';
  aller('principale');
  flash(`${nomAppareil(device)} enregistré et sélectionné.`);
  rendre();
}

// ─── Cast ─────────────────────────────────────────────────────────────────────

async function onCaster() {
  const device = appareilsFusionnes().find(d => d.id === selectedId);
  if (!currentStream?.url || !device) return;

  const btn   = document.getElementById('btn-caster');
  const label = document.getElementById('caster-label');
  btn.disabled = true;
  label.textContent = 'Envoi…';

  try {
    const res = await fetch(`${urlDaemon()}/cast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ENTETES },
      body: JSON.stringify({
        deviceId:  device.id,
        streamUrl: currentStream.url,
        referer:   currentStream.referer,
        title:     're:cast stream',
        // host + name permettent au daemon de reconstruire l'appareil s'il l'a oublié
        host:      device.host,
        // Le nom RÉSEAU, jamais le surnom : le daemon le renverrait comme nom
        // réseau au rafraîchissement suivant, et les deux champs finiraient par
        // se confondre.
        name:      device.name
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) {
      const corps = await res.json().catch(() => ({}));
      label.textContent = corps.error ? corps.error.slice(0, 40) : 'Échec du cast';
      btn.disabled = false;
      return;
    }

    lecture = {
      deviceId:   device.id,
      deviceName: nomAppareil(device),
      protocole:  device.type,
      host:       device.host,
      url:        currentStream.url
    };
    aller('lecture');
  } catch {
    label.textContent = 'Daemon hors ligne';
    btn.disabled = false;
  }
}

async function onArreter() {
  const btn = document.getElementById('btn-arreter');
  btn.disabled = true;
  try {
    await fetch(`${urlDaemon()}/stop`, { method: 'POST', headers: ENTETES });
  } catch {}
  btn.disabled = false;
  lecture = null;
  aller('principale');
}
