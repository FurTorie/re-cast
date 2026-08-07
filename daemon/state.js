// re:cast - state.js
// État de lecture courant, pour que l'app de bureau puisse l'afficher sans
// interroger le réseau. Volontairement minimal : le daemon ne sait pas si la TV
// joue réellement, seulement ce qu'on lui a demandé de caster en dernier.

const listeners = new Set();

let current = null; // { deviceId, deviceName, protocole, titre, url, depuis }

function emit() {
  for (const fn of listeners) {
    try { fn(current); } catch {}
  }
}

function demarre({ deviceId, deviceName, titre, url }) {
  current = {
    deviceId,
    deviceName: deviceName || deviceId,
    protocole: (deviceId.split('-')[0] || '').toUpperCase(),
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
