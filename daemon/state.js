// re:cast - state.js
// État de lecture courant, pour que l'app de bureau puisse l'afficher sans
// interroger le réseau. Volontairement minimal : le daemon ne sait pas si la TV
// joue réellement, seulement ce qu'on lui a demandé de caster en dernier.

const listeners = new Set();

let current = null; // { deviceId, deviceName, protocole, host, titre, url, depuis }

// Le préfixe d'ID est en minuscules ; l'écrire tel quel en majuscules donnerait
// « CHROMECAST » et « AIRPLAY ». Ces libellés sont affichés à l'utilisateur.
const PROTOCOLES = {
  chromecast: 'Chromecast',
  dlna:       'DLNA',
  airplay:    'AirPlay'
};

// Les IDs d'appareil portent l'IP avec des tirets (`dlna-192-168-1-10`). C'est le
// seul endroit où on la reconstitue, pour les cas où l'appelant ne l'a pas jointe.
function hostDepuisId(deviceId) {
  const reste = deviceId.split('-').slice(1).join('-');
  return /^\d{1,3}(-\d{1,3}){3}$/.test(reste) ? reste.replace(/-/g, '.') : null;
}

function emit() {
  for (const fn of listeners) {
    try { fn(current); } catch {}
  }
}

function demarre({ deviceId, deviceName, titre, url, host }) {
  const prefixe = (deviceId.split('-')[0] || '').toLowerCase();
  current = {
    deviceId,
    deviceName: deviceName || deviceId,
    protocole: PROTOCOLES[prefixe] || prefixe.toUpperCase(),
    // Le popup réaffiche l'écran de lecture à sa réouverture, y compris après un
    // redémarrage de Firefox : il n'a alors plus que /status pour savoir sur quel
    // appareil ça joue. Sans `host`, la ligne « DLNA · 192.168.1.13 » serait vide.
    host: host || hostDepuisId(deviceId),
    titre: titre || null,
    url,
    depuis: Date.now()
  };
  emit();
}

function arrete() {
  current = null;
  emit();
}

function courant() {
  return current;
}

// Retourne une fonction de désabonnement
function surChangement(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { demarre, arrete, courant, surChangement };
