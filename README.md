# re:cast

Caster une vidéo depuis Firefox vers une TV, en résolution native, sans passer par le partage d'écran.

Le projet a deux moitiés indépendantes qui communiquent en HTTP :

| | Rôle |
|---|---|
| `extension/` | Add-on Firefox (Manifest V2). Détecte l'URL du flux et sert de télécommande. |
| `daemon/` | Serveur Node local. Découvre les appareils, proxifie le flux, parle Chromecast / DLNA. |

**La cible principale est Firefox pour Android.** Le téléphone porte l'extension, le PC fait tourner le daemon et relaie le flux. Ce découpage n'est pas un accident : le cast étant délégué au daemon, la lecture survit au verrouillage du téléphone, à la mise en arrière-plan de Firefox et à la perte du Wi-Fi.

## Installation

### Daemon (sur le PC)

Node.js 18 ou plus est requis.

```bash
cd daemon && npm install
```

```bash
cd daemon && node index.js
```

Le daemon écoute sur le port **7171**, sur toutes les interfaces — c'est la TV qui vient chercher la vidéo, `localhost` ne suffit donc pas.

**Sur Windows, une règle de pare-feu est nécessaire.** La TV ouvre une connexion entrante, que Windows bloque par défaut sur un réseau classé *Private*. Sans elle, le cast démarre mais la vidéo ne charge jamais. Dans une PowerShell **en administrateur** :

```powershell
New-NetFirewallRule -DisplayName "re:cast daemon (7171)" -Direction Inbound -Protocol TCP -LocalPort 7171 -Action Allow -Profile Private
```

### Extension (sur le téléphone ou le PC)

Version signée : télécharger le `.xpi` depuis les [releases](../../releases) et l'ouvrir dans Firefox.

Pour développer : `about:debugging` → Ce Firefox → Charger un module temporaire → `extension/manifest.json`.

Au premier lancement, renseigner **l'adresse IP du PC** dans le champ en haut du popup (par exemple `192.168.1.16:7171`). Le daemon l'affiche au démarrage.

## Utilisation

1. Ouvrir une vidéo dans Firefox.
2. Ouvrir le popup de l'extension. L'URL détectée s'affiche sous « Stream détecté ».
3. Choisir un appareil, puis « Caster ». L'étoile ★ garde l'appareil en mémoire, le crayon ✏️ lui donne un surnom.

Un même téléviseur peut apparaître deux fois, une entrée par protocole. **Quand les deux sont proposées, préférer Chromecast** : HLS y est géré nativement, là où la voie DLNA repose sur des contournements du firmware Samsung.

## Vérifier que le daemon répond

```bash
curl http://localhost:7171/status
```

```bash
curl http://localhost:7171/devices
```

## Publication

Les deux moitiés se versionnent séparément, et chacune déclenche sa propre publication :

| Fichier modifié | Effet |
|---|---|
| `extension/manifest.json` → `version` | signature par Mozilla, puis release GitHub du `.xpi` |
| `daemon/package.json` → `version` | archive du daemon en release GitHub |

Rien ne part tant que le numéro de version n'a pas changé : un tag `extension-vX.Y.Z` ou `daemon-vX.Y.Z` marque ce qui est déjà publié. Republier une version déjà connue d'AMO échouerait de toute façon côté Mozilla.

Le lancement manuel fait exactement la même chose, si besoin :

```bash
gh workflow run release-extension.yml
```

> Le déclenchement par `push` n'a pas fonctionné pendant la première demi-heure d'existence du dépôt : les `PushEvent` arrivaient bien chez GitHub mais aucun run n'était créé, y compris sans filtre de chemins. Il s'est armé de lui-même ensuite. À garder en tête si tu recrées un dépôt un jour — ce n'est pas la configuration qui est en cause, et `gh workflow run` dépanne en attendant.

**Le dépôt doit rester public.** Firefox interroge `update_url` et télécharge le `.xpi` **sans authentification** : sur un dépôt privé, `raw.githubusercontent.com` comme les assets de release répondent 404 à un client anonyme, et la mise à jour automatique cesse silencieusement de fonctionner.

La signature demande deux secrets GitHub, obtenus sur [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) :

- `AMO_API_KEY` (le *JWT issuer*)
- `AMO_API_SECRET` (le *JWT secret*)

Le canal est `unlisted` : signature en quelques minutes, sans revue éditoriale, distribution par les releases GitHub.

### Mises à jour automatiques

Une extension *unlisted* ne passe pas par addons.mozilla.org pour ses mises à jour : Firefox interroge l'URL déclarée dans `browser_specific_settings.gecko.update_url`, ici le fichier [`updates.json`](updates.json) à la racine du dépôt. Le workflow le réécrit après chaque release, une fois le `.xpi` publié pour que le lien qu'il contient soit déjà valide.

Ce commit automatique ne touche qu'`updates.json`, hors du filtre `paths` du workflow : il ne peut donc pas déclencher une exécution en boucle.

**À savoir si tu passes un jour en `listed`** : AMO refuse un `update_url` sur les extensions publiées chez lui, puisqu'il gère lui-même les mises à jour. Il faudra retirer la clé du manifeste à ce moment-là.

## Documentation technique

[CLAUDE.md](CLAUDE.md) décrit l'architecture en détail, et surtout les nombreux pièges déjà rencontrés — choix de l'interface réseau pour le multicast, contournements du firmware Samsung, performance du proxy lors des déplacements dans la vidéo. À lire avant toute modification du réseau ou du proxy.
