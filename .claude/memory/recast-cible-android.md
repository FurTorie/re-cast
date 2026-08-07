---
name: recast-cible-android
description: "re:cast vise Firefox Android en priorité, le daemon PC est un relais LAN assumé"
metadata:
  type: project
---

La plateforme cible principale de re:cast est **Firefox pour Android**. Le desktop est secondaire. iOS est écarté parce que le programme développeur Apple est payant.

L'architecture en deux morceaux est **volontaire**, pas de la dette technique : le PC fait tourner le daemon (proxy de flux + contrôle des appareils) et reste joignable sur le LAN, tandis que le téléphone porte l'extension et sert de télécommande. Le champ « IP du daemon » configurable dans le popup est donc une fonctionnalité centrale.

**Why:** Précisé par l'utilisateur le 2026-08-06, après que j'ai proposé de fusionner le daemon dans l'extension via native messaging — proposition à écarter définitivement (le native messaging n'existe d'ailleurs pas sur Firefox Android).

**How to apply:** Ne pas proposer de supprimer le daemon, de le fusionner dans l'extension, ni de retirer la configuration d'IP. Évaluer toute modification d'interface sous l'angle tactile d'abord.

L'interface principale est le **popup `browser_action`**, qui s'ouvre en plein écran sur Fenix. Le bouton flottant et le panel injecté de `extension/content/content.js` sont un confort desktop, pas le chemin principal — une version antérieure de cette note affirmait l'inverse, c'était faux et `CLAUDE.md` fait foi.

Voir [[recast-etat-valide]].
