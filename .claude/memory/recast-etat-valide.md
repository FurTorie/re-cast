---
name: recast-etat-valide
description: "re:cast — ce qui est validé sur le vrai matériel au 2026-08-07, et les deux chantiers d'interface qui restent"
metadata:
  type: project
---

Au 2026-08-07, **tout le cœur est validé sur le vrai matériel** : DLNA et Chromecast fonctionnent sur les deux TV (55" Crystal UHD `192.168.1.222`, 85" QLED `192.168.1.13`), la détection de la bonne vidéo est confirmée, et les trois moitiés se publient seules depuis GitHub.

Ce fichier remplace une note qui listait des correctifs « en attente de test ». Elle est devenue fausse sur le point le plus important, au point d'être dangereuse : elle recommandait d'annoncer le **vrai** type MIME sur les segments HLS en DLNA. Testé sur la TV, ça **casse** la lecture. La fiction MP4 doit rester totale et uniforme — c'est documenté en détail dans `CLAUDE.md`, avec le tableau des quatre tentatives ratées.

Leçon à garder au-delà de ce projet : une hypothèse validée en simulation n'est pas un correctif. Sur ce matériel, le seul juge est la TV.

**Le popup a été entièrement refait le 2026-08-07**, d'après une maquette Claude Design déposée dans `design/` : cinq écrans qui se remplacent, gestion de plusieurs serveurs re:cast, thème clair et sombre. Le bouton flottant injecté dans les pages a été supprimé du même coup — le popup est désormais le chemin unique.

**Cette refonte n'a pas encore vu la TV.** C'est exactement le piège que ce fichier documente plus haut : tant que le matériel n'a pas tranché, elle est « écrite », pas « validée ». Le cœur du cast, lui, n'a pas bougé.

**Le chantier du bouton « Caster » est tranché** (2026-08-15, extension 0.1.14) : le pied de page est `sticky`, pas `fixed` — il se plaque au bas de l'écran seulement quand il y a de quoi défiler, et reste dans le flux sinon. Vérifié au banc d'essai dans les deux thèmes ; le détail et les chiffres sont dans `CLAUDE.md`.

Voir [[recast-cible-android]].
