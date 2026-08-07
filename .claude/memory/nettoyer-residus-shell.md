---
name: nettoyer-residus-shell
description: "Vérifier qu'aucun fichier vide n'a été créé par une redirection shell avant tout commit"
metadata:
  type: feedback
---

**Avant tout `git add` / `git commit`, vérifier qu'aucun fichier vide n'a été créé par une commande shell.**

**Pourquoi :** une redirection malheureuse — un `>` mal placé, un argument pris pour un nom de fichier, un `node -e` dont le code contient un chevron — crée un fichier de 0 octet au nom absurde (`0`, `HTTP`, `Le`, `a.version.localeCompare(b.version`). `git add -A` les emporte tous sans rien signaler. C'est arrivé plus de trente fois sur ce dépôt, et un fichier nommé `0` est resté sur `origin/main` jusqu'à ce que l'utilisateur le remarque. Le coupable est presque toujours ma propre commande, pas le projet.

**Comment l'appliquer :**

```bash
find . -type f -empty -not -path "./.git/*" -not -path "*/node_modules/*"
```

Un hook `pre-commit` versionné dans `.githooks/` refuse désormais ces commits. Il n'est actif que si le dépôt est configuré pour le lire — à faire après tout nouveau clone :

```bash
git config core.hooksPath .githooks
```

Ne pas s'y fier aveuglément : le hook ne couvre pas les fichiers vides déjà suivis, ni ceux créés hors de l'index. La vérification reste à faire.

Voir [[recast-etat-valide]].
