// Soumet une version LISTED à addons.mozilla.org via l'API v5.
//
// web-ext ne suffit pas ici : il sait signer, mais pas renseigner les
// métadonnées qu'AMO exige d'une fiche publique — catégories et licence. Or la
// fiche de re:cast est en statut « incomplete » précisément parce que ces deux
// champs manquent, héritage des signatures unlisted qui ne les demandent pas.
//
// Rien n'est écrit en clair : la clé et le secret ne sortent jamais de
// l'environnement, et le JWT n'est jamais journalisé.
//
// Variables attendues : AMO_KEY, AMO_SECRET, ZIP, RACINE

import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RACINE = process.env.RACINE || '.';
const API = 'https://addons.mozilla.org/api/v5';
const CATEGORIE = 'photos-music-videos';

// L'API attend un JWT de courte durée. On en forge un par requête plutôt qu'un
// seul pour toute la session : la validation d'un paquet peut prendre plusieurs
// minutes, et un jeton expiré en cours de route donnerait un 401 incompréhensible.
function jeton() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const maintenant = Math.floor(Date.now() / 1000);
  const entete = b64({ alg: 'HS256', typ: 'JWT' });
  const charge = b64({
    iss: process.env.AMO_KEY,
    jti: randomBytes(8).toString('hex'),
    iat: maintenant,
    exp: maintenant + 240
  });
  const sig = createHmac('sha256', process.env.AMO_SECRET)
    .update(`${entete}.${charge}`).digest('base64url');
  return `${entete}.${charge}.${sig}`;
}

async function appel(chemin, options = {}) {
  const r = await fetch(API + chemin, {
    ...options,
    headers: { Authorization: `JWT ${jeton()}`, ...(options.headers || {}) }
  });
  const brut = await r.text();
  let corps = null;
  try { corps = JSON.parse(brut); } catch { /* réponse non JSON : on garde le brut */ }
  return { ok: r.ok, statut: r.status, corps, brut };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function echouer(message, detail) {
  console.error(`::error::${message}`);
  if (detail) console.error(typeof detail === 'string' ? detail.slice(0, 4000)
    : JSON.stringify(detail, null, 2).slice(0, 4000));
  process.exit(1);
}

const manifeste = JSON.parse(
  await readFile(join(RACINE, 'extension/manifest.json'), 'utf8'));
const ID = manifeste.browser_specific_settings.gecko.id;
const VERSION = manifeste.version;

console.log(`Add-on ${ID}, version ${VERSION}`);

// ── 1. Téléverser le paquet ───────────────────────────────────────────────────

const zip = await readFile(process.env.ZIP);
const formulaire = new FormData();
formulaire.append('upload', new Blob([zip]), 'recast.zip');
formulaire.append('channel', 'listed');

const envoi = await appel('/addons/upload/', { method: 'POST', body: formulaire });
if (!envoi.ok) echouer('Téléversement refusé par AMO', envoi.corps || envoi.brut);

const uuid = envoi.corps.uuid;
console.log(`Paquet téléversé (${uuid}), validation en cours…`);

// ── 2. Attendre la validation automatique ────────────────────────────────────

let validation = null;
for (let essai = 0; essai < 60; essai++) {
  await pause(5000);
  const etat = await appel(`/addons/upload/${uuid}/`);
  if (!etat.ok) echouer('Impossible de lire l\'état de validation', etat.corps || etat.brut);
  if (etat.corps.processed) { validation = etat.corps; break; }
  if (essai % 6 === 5) console.log(`  …toujours en cours (${(essai + 1) * 5} s)`);
}
if (!validation) echouer('La validation n\'a pas abouti en 5 minutes.');

if (!validation.valid) {
  const messages = (validation.validation?.messages || [])
    .filter((m) => m.type === 'error')
    .map((m) => `  ${m.message} — ${(m.description || []).join(' ')}`)
    .join('\n');
  echouer('Le paquet est refusé par la validation AMO', messages || validation.validation);
}
console.log('Validation acceptée.');

// ── 3. Compléter la fiche : catégories ───────────────────────────────────────
// Sans catégorie, l'add-on reste « incomplete » et n'est jamais rendu public,
// même une fois la version acceptée.

const fiche = await appel(`/addons/addon/${ID}/`);
if (!fiche.ok) echouer('Fiche de l\'add-on illisible', fiche.corps || fiche.brut);

if (!fiche.corps.categories || fiche.corps.categories.length === 0) {
  const maj = await appel(`/addons/addon/${ID}/`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categories: [CATEGORIE] })
  });
  if (!maj.ok) echouer('Impossible de renseigner la catégorie', maj.corps || maj.brut);
  console.log(`Catégorie renseignée : ${CATEGORIE}`);
} else {
  console.log(`Catégorie déjà en place : ${fiche.corps.categories.join(', ')}`);
}

// ── 4. Créer la version listed ───────────────────────────────────────────────
// La licence voyage avec la version. Aucune licence prédéfinie d'AMO ne
// correspond — les Creative Commons sont réservées aux thèmes, et le reste est
// libre au sens OSI — d'où custom_license, alimenté par le LICENSE du dépôt.

const texteLicence = await readFile(join(RACINE, 'LICENSE'), 'utf8');
const notes = await readFile(join(RACINE, '.github/amo/notes-relecteurs.md'), 'utf8');

const creation = await appel(`/addons/addon/${ID}/versions/`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    upload: uuid,
    approval_notes: notes,
    // La locale doit être en-US : c'est la locale PAR DÉFAUT de l'add-on, et
    // l'API exige une valeur dans celle-là. Le nom affiché de re:cast est en
    // français, ce qui induit en erreur — la locale par défaut est un réglage
    // distinct de la langue des textes. Refus mesuré avec `fr` seul.
    custom_license: {
      name: { 'en-US': 'PolyForm Noncommercial License 1.0.0' },
      text: { 'en-US': texteLicence }
    }
  })
});

if (!creation.ok) echouer(`Création de la version ${VERSION} refusée`,
  creation.corps || creation.brut);

console.log(`Version ${VERSION} soumise en canal listed.`);
console.log(`Statut du fichier : ${creation.corps.file?.status || 'inconnu'}`);
console.log('Elle sera publique une fois la revue Mozilla passée.');
