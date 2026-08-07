---
name: recast-etat-valide
description: "re:cast — ce qui est validé sur le vrai matériel au 2026-08-07, et les deux chantiers d'interface qui restent"
metadata:
  type: project
---

Au 2026-08-07, **tout le cœur est validé sur le vrai matériel** : DLNA et Chromecast fonctionnent sur les deux TV (55" Crystal UHD `192.168.1.222`, 85" QLED `192.168.1.13`), la détection de la bonne vidéo est confirmée, et les trois moitiés se publient seules depuis GitHub.

Ce fichier remplace une note qui listait des correctifs « en attente de test ». Elle est devenue fausse sur le point le plus important, au point d'être dangereuse : elle recommandait d'annoncer le **vrai** type MIME sur les segments HLS en DLNA. Testé sur la TV, ça **casse** la lecture. La fiction MP4 doit rester totale et uniforme — c'est documenté en détail dans `CLAUDE.md`, avec le tableau des quatre tentatives ratées.

Leçon à garder au-delà de ce projet : une hypothèse validée en simulation n'est pas un correctif. Sur ce matériel, le seul juge est la TV.

Deux chantiers d'interface restent ouverts, tous deux côté extension, aucun bloquant :

- le bouton `📡 Caster` à fixer en bas de l'écran en vue plein écran (question posée à l'utilisateur, jamais tranchée) ;
- le bouton flottant de `extension/content/content.js`, inutilisable au tactile — il naît en `opacity: 0` et n'apparaît qu'au survol souris. Confort desktop, pas le chemin principal, qui est le popup.

Voir [[recast-cible-android]].
