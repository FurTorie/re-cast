<p align="center">
  <img src="docs/logo.png" alt="re:cast" width="112">
</p>

<h1 align="center">re:cast</h1>

<p align="center">
  <b>Caster une vidéo depuis Firefox vers une TV, en résolution native.</b><br>
  Sans partage d'écran, sans compte, sans cloud — tout reste sur le réseau local.
</p>

<p align="center">
  <!-- sort=semver est indispensable : par défaut shields trie les tags dans
       l'ordre alphabétique, et annonçait donc app-v0.1.9 alors que la dernière
       version publiée était app-v0.1.20. -->
  <a href="../../releases"><img alt="App Windows" src="https://img.shields.io/github/v/release/FurTorie/re-cast?filter=app-*&sort=semver&label=app%20Windows&color=E74C3C"></a>
  <a href="../../releases"><img alt="Extension Firefox" src="https://img.shields.io/github/v/release/FurTorie/re-cast?filter=extension-*&sort=semver&label=extension&color=E74C3C"></a>
  <img alt="Plateformes" src="https://img.shields.io/badge/cast-Chromecast%20%C2%B7%20DLNA%20%C2%B7%20AirPlay-2C3E50">
</p>

---

## Le problème

Le partage d'écran d'un téléphone renvoie ce que l'écran affiche : une image déjà décodée, redimensionnée, recompressée à la volée. On y perd la définition, la batterie fond, et le moindre appel coupe la vidéo.

re:cast ne partage pas l'écran. Il **repère l'URL du flux** que le lecteur est en train de lire et **donne cette adresse à la TV**, qui va chercher la vidéo elle-même. La TV décode son flux d'origine, en pleine résolution. Le téléphone n'est plus qu'une télécommande : on peut le verrouiller, quitter Firefox, ou sortir de la pièce — la lecture continue.

## À quoi ça ressemble

<p align="center">
  <img src="docs/en-situation.webp" alt="re:cast ouvert sur une page en lecture dans Firefox" width="880">
</p>

Une vidéo en cours de lecture, le popup ouvert par-dessus : re:cast a déjà repéré le flux HLS de la page — l'URL complète est dépliée — et n'attend plus que le choix de l'appareil.

<p align="center">
  <img src="docs/popup-appareils.png" alt="Le popup : flux détecté et appareils du réseau" width="250">
  &nbsp;
  <img src="docs/popup-serveurs.png" alt="Le popup : les serveurs re:cast enregistrés" width="250">
  &nbsp;
  <img src="docs/popup-lecture.png" alt="Le popup : la lecture en cours sur la TV" width="250">
</p>

Le popup de l'extension est la seule interface : le flux repéré sur la page, les appareils trouvés sur le réseau, puis l'état de la lecture. Un même téléviseur apparaît **une fois par protocole qu'il annonce** — ici la 85" QLED répond en Chromecast *et* en DLNA. L'écran du milieu gère les serveurs re:cast, un par lieu ou par machine : quand tu changes de réseau, re:cast bascule seul sur celui qui répond.

<p align="center">
  <img src="docs/menu.png" alt="Le menu de l'app Windows" height="250">
  &nbsp;&nbsp;
  <img src="docs/console.png" alt="La console de l'app Windows" height="250">
</p>

Côté PC, une icône dans la zone de notification garde le serveur vivant. Sa console montre en couleurs ce qui entre et ce qui sort — c'est là qu'on lit pourquoi un cast échoue.

## Comment c'est fait

Trois morceaux indépendants, qui se parlent en HTTP :

| | Rôle |
|---|---|
| `extension/` | Add-on Firefox (Manifest V2). Détecte l'URL du flux et sert de télécommande. |
| `daemon/` | Serveur Node local. Découvre les appareils, proxifie le flux, parle Chromecast / DLNA / AirPlay. |
| `app/` | App Windows de barre des tâches. Garde le daemon vivant en arrière-plan. |

**L'extension ne parle jamais directement à une TV.** Elle ne fait que poster vers le daemon, qui s'occupe du reste.

**La cible principale est Firefox pour Android.** Le téléphone porte l'extension, le PC fait tourner le daemon et relaie le flux. Ce découpage n'est pas un accident : le cast étant délégué au daemon, la lecture survit au verrouillage du téléphone, à la mise en arrière-plan de Firefox et à la perte du Wi-Fi.

Le daemon fait plus que transmettre une adresse. Il se met **entre la TV et le CDN** parce que ni l'un ni l'autre ne se comprennent directement : il ajoute le `Referer` sans lequel beaucoup de CDN répondent 403, sert en HTTP un flux qui n'existe qu'en HTTPS, raccourcit des URLs qu'un firmware n'avale pas, et réécrit les playlists HLS pour que chaque segment repasse par lui. C'est l'essentiel du code, et [CLAUDE.md](CLAUDE.md) explique pourquoi chaque couche existe.

## Ce qu'il faut

- **Node.js 18+** sur le PC — le daemon en dépend, l'installateur le vérifie et le signale.
- **Firefox**, sur téléphone ou sur PC.
- **Une TV Chromecast, DLNA ou AirPlay** sur le même réseau.
- **Windows** pour l'app de barre des tâches. Le daemon, lui, tourne partout où Node tourne.

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

### App Windows (recommandé)

Plutôt que de garder un terminal ouvert, l'app place une icône dans la zone de notification et maintient le daemon en arrière-plan.

**Installation :** télécharger `recast-setup-X.Y.Z.exe` depuis les [releases](../../releases) et l'exécuter. Aucun droit administrateur n'est demandé. L'installateur contient l'app **et** le daemon avec ses dépendances — seul Node.js doit être présent sur la machine, ce qu'il vérifie et signale.

**Mise à jour automatique.** L'app consulte [`app-latest.json`](app-latest.json) 30 s après son démarrage puis toutes les 6 h, et à la demande via « Vérifier les mises à jour ». Quand une version plus récente existe, elle apparaît en gras dans le menu et une bulle le signale ; un clic télécharge et installe.

> **Le manifeste se lit via l'API GitHub, pas via `raw.githubusercontent.com`.** Ce dernier sert ses fichiers derrière un CDN avec `Cache-Control: max-age=300` : pendant cinq minutes après une publication, il renvoie encore l'ancienne version, et une vérification manuelle répondait « re:cast est à jour » alors qu'une mise à jour venait de sortir. Ajouter un paramètre anti-cache à l'URL n'y change rien — le cache est partagé, pas local. L'API plafonne à 60 s, honore `Cache-Control: no-cache`, et renvoie le fichier brut avec l'en-tête `Accept: application/vnd.github.raw`. Sa limite de 60 requêtes par heure est sans risque : quatre vérifications automatiques par jour.

Télécharger puis exécuter un `.exe` mérite des garde-fous, il y en a deux et ils ne sont pas négociables :

1. **L'URL doit commencer par `https://github.com/FurTorie/re-cast/releases/download/`.** Sans ce contrôle, un manifeste altéré ferait exécuter n'importe quel binaire.
2. **L'empreinte SHA-256 publiée par la CI doit correspondre au fichier téléchargé.** Sinon le fichier est supprimé et rien n'est lancé.

L'installation se fait en `/SILENT` et l'app se relance seule — d'où l'absence de `skipifsilent` sur l'entrée `[Run]` du script Inno Setup, sans laquelle elle ne redémarrerait jamais. Une lecture en cours est signalée avant, puisqu'elle sera interrompue.

### Instance unique et conflits de port

Un mutex nommé empêche un second lancement : deux apps démarreraient deux daemons qui se disputeraient le port 7171, et la seconde resterait inerte sans rien expliquer.

Reste le cas où le port est pris malgré tout. **Un daemon tué de force laisse son enfant `node` vivant** — c'est le cas le plus fréquent, après un arrêt brutal ou une désinstallation.

La distinction qui compte n'est pas « est-ce un daemon re:cast » mais **« son processus parent existe-t-il encore »** :

- **Parent disparu** → vrai orphelin, typiquement notre app tuée de force. Remplacé sans rien demander.
- **Parent vivant** → daemon lancé délibérément depuis un terminal. On n'y touche pas : le tuer en silence irait contre une décision explicite de l'utilisateur. Le menu propose « ⚠ Libérer le port 7171 et démarrer », et la confirmation affiche le nom du processus *et sa ligne de commande*.

Se fier au seul nom `node` serait une erreur : d'autres logiciels tournent sous Node. La ligne de commande et le parent se lisent via WMI, seul moyen de les obtenir pour un autre processus.

**Le bouton s'affiche dès que le serveur en place n'est pas le processus fils de l'app**, jamais sur « le serveur ne répond pas ». C'est une correction : le test portait d'abord sur l'absence de réponse, si bien que le bouton apparaissait une seconde puis disparaissait dès qu'un daemon étranger répondait à `/status` — exactement le cas qu'il devait traiter.

`GET /status` renvoie `app: "re:cast"` et l'`ip` LAN du serveur. L'app n'a donc plus à deviner l'adresse en relisant les logs, ce qui la faisait retomber sur `localhost` — une adresse inutilisable depuis le téléphone.

**Depuis les sources :**

```powershell
.\app\build.ps1
```

```powershell
.\app\Recast.exe
```

La compilation utilise le compilateur C# livré avec Windows — aucun SDK, aucune dépendance npm. L'exécutable pèse **79 Ko**, dont une bonne moitié d'icône multi-tailles embarquée. La version vient de `app/version.txt`, qui pilote aussi la publication ; `build.ps1` l'injecte dans les propriétés du fichier.

Le logo est **dessiné**, pas rééchantillonné : [`app/logo.cs`](app/logo.cs) compose chaque taille à partir des contours de la police, de 16 à 256 px, et écrit le conteneur `.ico` à la main. Une icône multi-tailles ne peut pas venir d'un seul bitmap, et une seule composition ne tient pas de 16 à 256 px — d'où trois variantes (`R:`, `RE:`, puis le bloc complet à partir de 48 px). Le générateur se compile avec le même `csc` que l'app, donc aucun outil supplémentaire, et les icônes de l'extension en sortent aussi : une seule source, sinon les deux logos finiraient par diverger.

Le menu, au clic sur l'icône, donne :

- l'état du serveur et **l'adresse IP à saisir dans l'extension**, cliquable pour la copier ;
- la lecture en cours (appareil et protocole), avec un bouton d'arrêt ;
- le redémarrage du serveur ;
- la console, qui affiche la sortie du daemon en couleurs et compte les erreurs ;
- une case « Démarrer avec Windows » (clé `Run` de l'utilisateur, sans droits administrateur).

**Pourquoi pas Electron :** l'app doit tourner en permanence. Electron coûterait ~180 Mo sur disque et ~150 Mo de RAM rien que pour afficher un menu. Les paquets npm de barre des tâches ont aussi été écartés : `tray-icon-node` tire 195 Mo de dépendances et son binding natif ne se charge pas sur Windows.

**L'empreinte mémoire est un objectif explicite.** Mesures réelles, échantillonnées sur plusieurs minutes plutôt qu'au démarrage — un instantané pris juste après `EmptyWorkingSet` est trompeur :

| | Avant | Après (stabilisé) |
|---|---|---|
| Working set (Gestionnaire des tâches) | 36,9 Mo | **6 à 9 Mo** |
| Octets privés | 25,2 Mo | 26,7 Mo |
| Threads | 11 | 10 à 13 |

Ce qu'il faut en retenir, sans se raconter d'histoires : **seul le working set baisse**. `EmptyWorkingSet` rend les pages à Windows sans réduire la mémoire réellement engagée, qui reste au plancher du .NET Framework avec WinForms. Le gain est néanmoins réel à l'usage — pour un processus qui dort, ces pages ne reviennent que très partiellement, comme le montre la remontée lente de 6 à 9 Mo puis la stabilisation.

Les mesures qui servent cet objectif, à ne pas défaire :

- `Memoire.Compacter()` appelle `EmptyWorkingSet` après le démarrage et à la fermeture de la console. Le démarrage — chargement des assemblies, JIT, création des contrôles — est de loin le plus gourmand, et ces pages ne resservent plus.
- Le **menu est libéré** à chaque remplacement. Sans ça, chaque rafraîchissement abandonnait un `ContextMenuStrip` complet avec ses handles. C'est la correction la plus utile des cinq : une fuite ne se voit pas dans un instantané, elle se voit au bout de trois jours. La libération est différée si le menu est ouvert, pour ne pas le détruire sous les doigts de l'utilisateur.
- Le **handle d'icône** de `GetHicon()` est détruit explicitement : le ramasse-miettes ne le libère pas.
- Le **sondage s'adapte** : 3 s pendant une lecture, 10 s au repos.
- `Recast.exe.config` désactive le GC concurrent. Mesuré : **aucun effet observable ici** ; conservé par principe, pas pour un gain démontré.

Descendre réellement sous les 26 Mo engagés demanderait d'abandonner WinForms pour du Win32 brut (`Shell_NotifyIcon` + `CreatePopupMenu`), soit environ 6 Mo, au prix d'un code bien plus verbeux. À relativiser : **le daemon Node pèse à lui seul près de 60 Mo**, donc l'app n'est plus le poste dominant.

La console lit la **sortie standard du processus Node**, pas une API : les erreurs de démarrage restent donc visibles même quand le serveur n'a jamais réussi à écouter — précisément le moment où on en a besoin.

### Extension (sur le téléphone ou le PC)

Version signée : télécharger le `.xpi` depuis les [releases](../../releases) et l'ouvrir dans Firefox.

Pour développer : `about:debugging` → Ce Firefox → Charger un module temporaire → `extension/manifest.json`.

Au premier lancement, renseigner **l'adresse IP du PC** dans le champ en haut du popup (par exemple `192.168.1.16:7171`). Le daemon l'affiche au démarrage.

## Utilisation

1. Ouvrir une vidéo dans Firefox.
2. Ouvrir le popup de l'extension. L'URL détectée s'affiche sous « Stream détecté ».
3. Choisir un appareil, puis « Caster ». L'étoile ★ garde l'appareil en mémoire, le crayon ✏️ lui donne un surnom.

Un même téléviseur peut apparaître deux fois, une entrée par protocole. **Quand les deux sont proposées, préférer Chromecast** : HLS y est géré nativement, là où la voie DLNA repose sur des contournements du firmware Samsung.

## Signaler un bug

La console de l'app a un bouton **« Copier le rapport »**. Il produit un texte prêt à coller, avec les versions des trois moitiés en tête :

```
═══ re:cast — rapport ═══
date       : 2026-08-07 16:33:38
app        : 0.1.20
daemon     : 0.1.10
extension  : 0.1.7
Windows    : 10.0.28000.0 64 bits
adresse    : 192.168.1.16:7171
lecture    : 85" QLED (CHROMECAST)
erreurs    : 0

═══ journal ═══
…
```

Sans cet en-tête, un log ne dit pas s'il porte sur du code déjà corrigé — c'est la première question devant un rapport. Les versions du daemon et de l'extension viennent de `GET /status` ; l'extension annonce la sienne via l'en-tête `X-Recast-Extension` à chaque requête.

Le log est **coloré par gravité** : rouge pour les erreurs, jaune pour les bannières de version, cyan pour les requêtes **entrantes** (ce que demande la TV), bleu pour les **sortantes** (ce qu'on va chercher au CDN), vert pour les succès. Distinguer entrant et sortant est le premier réflexe de diagnostic — c'est ce qui a permis de comprendre qu'une TV byte-seekait dans un manifeste.

## Ce que re:cast ne peut pas caster

Trois cas où l'échec vient du site, pas de l'outil. La console du daemon les signale explicitement.

**Manifeste chiffré.** Certains sites servent une playlist chiffrée, déchiffrée par leur propre lecteur JavaScript avant d'atteindre la balise vidéo. Le proxy ne reçoit qu'un bloc opaque, inexploitable par une TV. Signalé par :

```
⚠ Réponse annoncée HLS mais ce n'est pas une playlist : NO5xdnU2O+z0djTjSkJEAFto…
```

Contourner supposerait de réimplémenter leur déchiffrement — cassé à leur prochaine mise à jour, et ce n'est pas le rôle de cet outil.

**Refus du CDN.** Beaucoup de CDN exigent un `Referer`, parfois une IP correspondant à un jeton. Signalé par :

```
⚠ Le serveur distant refuse : HTTP 403 (text/html; charset=UTF-8)
  Aucun Referer transmis — beaucoup de CDN refusent sans lui.
```

**Lecture chiffrée par DRM** (Widevine, PlayReady). Hors de portée par conception.

## Vérifier que le daemon répond

```bash
curl http://localhost:7171/status
```

```bash
curl http://localhost:7171/devices
```

## Publication

Les trois moitiés se versionnent séparément, et chacune déclenche sa propre publication :

| Fichier modifié | Effet |
|---|---|
| `extension/manifest.json` → `version` | signature par Mozilla, puis release GitHub du `.xpi` |
| `daemon/package.json` → `version` | archive du daemon en release GitHub |
| `app/version.txt` | compilation, installateur Inno Setup, release GitHub du `.exe` |

Rien ne part tant que le numéro de version n'a pas changé : un tag `extension-vX.Y.Z`, `daemon-vX.Y.Z` ou `app-vX.Y.Z` marque ce qui est déjà publié. Republier une version déjà connue d'AMO échouerait de toute façon côté Mozilla.

**Et l'oubli du bump fait échouer la CI.** Si un push modifie des fichiers d'une moitié sans incrémenter sa version, le workflow s'arrête en erreur au lieu de dire « déjà publiée » et de laisser passer. C'est arrivé trois fois sur le daemon avant que ce contrôle n'existe : les correctifs n'atteignaient jamais la release standalone.

Le workflow de l'app surveille aussi `daemon/**`, puisque l'installateur embarque le daemon : corriger le daemon oblige donc à bumper **les deux** versions.

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

**Son push est réessayé avec rebase, et ce n'est pas une précaution gratuite.** La signature AMO prend plusieurs minutes, pendant lesquelles le dépôt reçoit sans mal d'autres commits — un dépôt à trois moitiés publiées séparément y invite. Le push partait alors d'une base périmée, se faisait rejeter, et `updates.json` restait en arrière **sans que rien ne le montre** : la release existait, le `.xpi` était signé et publié, seul le fichier que Firefox interroge ne bougeait pas. Les versions 0.1.6 et 0.1.7 ont été perdues ainsi avant que ce soit corrigé.

**À savoir si tu passes un jour en `listed`** : AMO refuse un `update_url` sur les extensions publiées chez lui, puisqu'il gère lui-même les mises à jour. Il faudra retirer la clé du manifeste à ce moment-là.

## Documentation technique

[CLAUDE.md](CLAUDE.md) décrit l'architecture en détail, et surtout les nombreux pièges déjà rencontrés — choix de l'interface réseau pour le multicast, contournements du firmware Samsung, performance du proxy lors des déplacements dans la vidéo. À lire avant toute modification du réseau ou du proxy.
