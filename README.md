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

Rien ne part tant que le numéro de version n'a pas changé : un tag `extension-vX.Y.Z` ou `daemon-vX.Y.Z` marque ce qui est déjà publié.

La signature demande deux secrets GitHub, obtenus sur [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) :

- `AMO_API_KEY` (le *JWT issuer*)
- `AMO_API_SECRET` (le *JWT secret*)

Le canal est `unlisted` : signature en quelques minutes, sans revue éditoriale, distribution par les releases GitHub.

## Documentation technique

[CLAUDE.md](CLAUDE.md) décrit l'architecture en détail, et surtout les nombreux pièges déjà rencontrés — choix de l'interface réseau pour le multicast, contournements du firmware Samsung, performance du proxy lors des déplacements dans la vidéo. À lire avant toute modification du réseau ou du proxy.
