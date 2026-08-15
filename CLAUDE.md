# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mémoire du projet

Elle est **versionnée dans le dépôt**, sous `.claude/memory/`, et non dans le dossier de mémoire local de Claude Code. Ce dernier est indexé sur le chemin du dossier : re-cloner le dépôt ailleurs — via GitHub Desktop par exemple — repartirait d'une mémoire vide. Ici elle suit le code.

@.claude/memory/recast-cible-android.md
@.claude/memory/recast-etat-valide.md
@.claude/memory/nettoyer-residus-shell.md

Si ces imports ne sont pas résolus automatiquement, lire ces trois fichiers avant de commencer.

**En cas de contradiction, ce fichier-ci fait foi** : il est relu à chaque modification du code, là où une note de mémoire peut dater. C'est déjà arrivé — une note affirmait que le bouton flottant était l'interface principale sur mobile, alors que c'est le popup.

**Écrire en français**, y compris les réponses à l'utilisateur, les commentaires et les messages de commit.

### Avant tout commit

Vérifier qu'aucun fichier vide n'a été créé par une redirection shell malheureuse :

```bash
find . -type f -empty -not -path "./.git/*" -not -path "*/node_modules/*"
```

Un hook les refuse, mais il faut l'activer une fois par clone :

```bash
git config core.hooksPath .githooks
```

## Présentation

**re:cast** — caster une vidéo depuis Firefox vers une TV en résolution native. **Trois** morceaux, chacun avec sa version et sa publication :

- `extension/` — add-on Firefox **Manifest V2**. Détecte les URLs de stream dans le trafic réseau et propose un sélecteur d'appareil.
- `daemon/` — serveur Node + Express sur le port **7171**. Découvre les appareils du réseau local, proxifie les streams, parle Chromecast / DLNA / AirPlay.
- `app/` — app Windows en C# (icône de zone de notification) qui lance et surveille le daemon. **Elle l'embarque dans son installateur**, ce qui la rend dépendante de lui.

L'extension ne parle jamais directement à une TV : elle ne fait que POSTer vers le daemon.

Les commentaires et toutes les chaînes visibles par l'utilisateur sont en **français**. Respecter cette convention pour tout nouveau code.

### Les versions, et le piège du troisième morceau

Chaque morceau est publié par son propre workflow, piloté par son numéro de version — rien ne part tant que ce numéro n'a pas bougé, et un garde-fou **fait échouer le build** si les fichiers ont changé sans lui :

| Morceau | Version dans | Workflow | Déclenché par |
|---|---|---|---|
| Extension | `extension/manifest.json` | `release-extension.yml` | `extension/**` |
| Daemon | `daemon/package.json` | `release-daemon.yml` | `daemon/**` |
| App | `app/version.txt` | `release-app.yml` | `app/**` **et `daemon/**`** |

**Toucher à `daemon/` oblige donc à incrémenter DEUX versions** : `daemon/package.json` et `app/version.txt`. Oublier la seconde casse la publication de l'app — vécu en 0.1.11, où seules l'extension et le daemon avaient été bumpés. Le garde-fou a bien fait son travail : sans lui l'installateur aurait continué à livrer silencieusement un daemon périmé.

Ne jamais éditer `updates.json` ni `app-latest.json` à la main : les workflows les écrivent **après** la release, pour que le lien de téléchargement qu'ils contiennent soit déjà valide, puis les committent eux-mêmes. Il faut donc `git pull` après chaque publication.

## Plateforme cible

**Firefox pour Android est la cible principale**, le desktop est secondaire (iOS est écarté : programme développeur payant). Le téléphone porte l'extension et sert de télécommande ; le PC fait tourner le daemon et relaie le flux.

Ce découpage en deux est **volontaire** — ne pas proposer de fusionner le daemon dans l'extension ni de retirer le champ « IP du daemon » du popup : c'est ce champ qui permet au téléphone d'atteindre le PC. Avantage de conception : le cast étant délégué au daemon, la lecture survit au verrouillage du téléphone, à la mise en arrière-plan de Firefox et à la perte du Wi-Fi.

Conséquences pratiques :

- **L'interface principale est le popup `browser_action`** (`popup/popup.html`). Sur Fenix il ne s'affiche pas comme un petit panneau flottant mais comme une **vue plein écran** — la mise en page doit donc s'adapter à la largeur de l'écran, pas à une largeur de popup fixe.
- **Le popup est le chemin UNIQUE.** Le bouton flottant et le panneau de cast injectés dans les pages ont été supprimés : ils n'étaient utilisables qu'à la souris (`opacity: 0` révélé par `mouseenter` / `:hover`), donc morts sur la plateforme cible, et ils dupliquaient un popup qui fait tout ce qu'ils faisaient. `content/content.js` ne fait plus qu'une chose — remonter `currentSrc` — et n'injecte plus rien ; `content/content.css` n'existe plus. **Ne pas les réintroduire** sans une raison qui ne soit pas « c'était pratique sur desktop ».
- Toute interaction doit fonctionner **au tactile** : pas de dépendance à `:hover` seul, prévoir des états `:active`, cibles de 44 px minimum.
- `localhost` n'est jamais le daemon côté téléphone. `popup.js` fait bien un `await` sur le storage avant d'agir ; `content.js` non, et son défaut `localhost` est structurellement faux sur mobile.
- `manifest.json` déclare déjà `browser_specific_settings.gecko_android` — sans cette clé l'extension resterait desktop-only.

## Commandes

```bash
cd daemon && npm install
```

```bash
cd daemon && node index.js
```

Aucun build, lint ou test n'est configuré — `npm start` est un alias de `node index.js`. `daemon/recast.ps1` est un lanceur pratique mais son chemin `cd` est obsolète (`Desktop\daemon` au lieu de `Desktop\Re Cast\daemon`).

Chargement de l'extension : `about:debugging` → Ce Firefox → Charger un module temporaire → sélectionner `extension/manifest.json`.

**`extension/META-INF/` contient une signature AMO** (empreintes SHA1/SHA256 de chaque fichier). Toute modification sous `extension/` l'invalide. Le chargement temporaire ignore la signature ; une installation permanente exige une re-signature.

### Vérifications manuelles du daemon

```bash
curl http://localhost:7171/status
```

```bash
curl http://localhost:7171/devices
```

`/devices` bloque ~4 s par conception (fenêtre de découverte fixe) — les timeouts côté client doivent dépasser cette durée.

## Architecture

### Détection du stream (extension)

`background/background.js` est le seul endroit où une URL de stream est choisie. Il surveille `webRequest.onBeforeRequest` pour les types `xmlhttprequest` / `media` / `other`, compare aux motifs d'URL de `isStreamUrl()`, et conserve **un seul stream par `tabId`** dans un `streamStore` en mémoire.

`onBeforeSendHeaders` capture séparément le `Referer`, et **deux garde-fous y sont indispensables** :

- ne l'attacher que si `details.url` est exactement l'URL retenue ;
- ne jamais remplacer un `Referer` valide par une absence.

Sans eux, n'importe quelle requête ressemblant à un stream écrasait la valeur, y compris par `null`. Le daemon partait alors sans `Referer` et **beaucoup de CDN répondent 403** — cas mesuré sur Cloudflare, où la même requête passe de 403 à 200 par le seul ajout de l'en-tête. Symptôme : la lecture démarre sur la TV puis ne charge jamais rien.

Les URLs concurrentes sont arbitrées par `getPriority()` :

| Priorité | Motif |
|---|---|
| 5 | `.m3u8` |
| 4 | `.mpd` |
| 3 | `videoplayback` / `googlevideo` |
| 2 | le reste |
| **1** | **playlist audio seule** (`isAudioOnlyUrl()`) |
| **0** | **aperçus de vignettes** (`isPreviewUrl()`) |

Les deux rangs du bas ne sont pas cosmétiques. La comparaison se faisant sur `>=`, **à priorité égale le dernier vu gagne** — d'où deux façons de caster la mauvaise chose :

- Sur les sites de streaming, survoler une miniature charge un vrai fichier MP4 d'aperçu par vignette. Tous les `.mp4` étant à égalité, le dernier survolé écrasait la vraie vidéo et on castait la bande-annonce d'une suggestion.
- En HLS, une page charge sa playlist vidéo **puis** sa playlist audio. Les deux étant des `.m3u8`, la seconde écrasait la première : le cast démarrait normalement mais **il n'y avait que le son**. Cas réel observé sur `…/audio/audio.m3u8`.

Dans les deux cas c'est une dépriorisation, pas une exclusion : si la page n'offre rien d'autre, ça reste castable.

**Deux règles de départage à ne pas inverser :**

- `content/content.js` lit `video.src` / `currentSrc` et le remonte via `REPORT_VIDEO_SRC`. Il l'emporte **à priorité égale** (`>=`), car il sait ce que le lecteur joue réellement, là où le trafic réseau ne fait que passer.
- Réciproquement, une URL vue sur le réseau ne remplace **jamais** une entrée `source: 'video'` à priorité égale.

Les URLs `blob:` et `data:` sont rejetées partout — elles ne peuvent pas être re-téléchargées depuis une autre machine. C'est aussi pourquoi le content script n'aide que sur les MP4 progressifs : en HLS/DASH via MSE, `currentSrc` est un `blob:`.

### La limite infranchissable : les manifestes chiffrés

**Certains sites servent un manifeste chiffré**, déchiffré côté client par leur propre lecteur JavaScript avant d'être passé à la balise vidéo. re:cast ne peut rien en faire, et aucune TV non plus : le proxy ne reçoit qu'un bloc opaque, là où un récepteur attend du HLS standard.

Cas mesuré sur `fetch.flixcloud.cc` — la réponse est annoncée `application/vnd.apple.mpegurl`, répond bien `200`, et contient :

```
alphabet base64 pur : oui
décodé              : 25 982 octets
magic               : 34 ee 71 76 …   → aucun format connu
entropie            : 7,77 bits/octet (8,00 = aléatoire pur)
```

Une entropie pareille ne laisse pas de doute : c'est du chiffré, pas du compressé — vérifié en forçant `Accept-Encoding: identity`, qui renvoie exactement les mêmes octets sans en-tête `Content-Encoding`. Sur ce site précis, seule la playlist **audio** est en clair, ce qui donne un cast qui « démarre » sans image.

**Ne pas chercher à contourner** : il faudrait réimplémenter le déchiffrement du site, ce qui casserait à sa première mise à jour et reviendrait à défaire une protection délibérée.

Le proxy détecte et signale ce cas plutôt que de s'acharner : un corps annoncé HLS qui ne commence pas par `#EXTM3U` n'est **pas réécrit**, il est servi tel quel et son début est journalisé. Auparavant, `rewriteM3u8()` s'appliquait à ces octets et produisait des « URLs proxifiées » tirées du bruit, ce qui masquait complètement la cause.

`popup/popup.js` et `content/content.js` récupèrent le résultat de la même façon : `runtime.sendMessage({type: 'GET_STREAM'})`, qui résout sur l'onglet *actif*, pas sur l'émetteur.

Le store est vidé lors d'une vraie navigation (`changeInfo.status === 'loading' && changeInfo.url`) — volontairement pas sur le `pushState` des SPA.

### Identité des appareils, et qui se souvient de quoi

Les IDs d'appareil suivent le format `{protocole}-{ip-avec-tirets-au-lieu-de-points}`, par ex. `dlna-192-168-1-10`. `server.js` route d'après ce préfixe (`chromecast-` / `dlna-` / `airplay-`) via la table `MODULES`.

Chaque module de `daemon/cast/` expose la **même interface** — respecter ce contrat en ajoutant un protocole :

| Méthode | Rôle |
|---|---|
| `ping()` | émet une requête de découverte, ne rend pas la main sur une réponse |
| `discover()` | `ping()` + fenêtre de 4 s, résout avec **tout le cache** |
| `cached()` | contenu du cache, immédiat, sans réseau |
| `has(id)` | l'appareil est-il connu du processus courant |
| `resolveByHost(host, name)` | reconstruit un appareil depuis son IP, retourne son ID |
| `cast()` / `stop()` | lecture |

**La mémoire est à deux étages, et c'est volontaire :**

- Le daemon ne persiste **rien**. Son cache meurt avec le processus.
- **L'extension est la source de vérité** : elle garde les appareils choisis dans `browser.storage.local` (clé `savedDevices`), les affiche instantanément à l'ouverture, et envoie `host` + `name` avec chaque `POST /cast`. Si le daemon ne connaît plus l'appareil, il le **réhydrate** depuis `host` via `resolveByHost()` au lieu d'échouer. Sans `host`, `/cast` répond 409.

Une entrée de `savedDevices` porte **deux noms distincts, à ne pas fusionner** : `name` est le nom réseau, resynchronisé à chaque rafraîchissement depuis le daemon, et `nickname` est le surnom choisi par l'utilisateur, que rien ne doit jamais écraser. L'affichage prend `nickname || name`. C'est aussi `name` — jamais le surnom — qui part dans `POST /cast`, sinon le daemon renverrait le surnom comme nom réseau au rafraîchissement suivant et les deux champs finiraient par se confondre.

**Deux pièges de découverte, tous deux corrigés — ne pas les réintroduire :**

1. `discover()` doit résoudre avec `cached()`, jamais avec un tableau local rempli seulement par les événements reçus pendant la fenêtre de 4 s. Sinon un appareil déjà détecté disparaît de la réponse HTTP dès qu'il ne se réannonce pas, alors qu'il est bien en cache (la console du daemon le montrait, l'extension ne le voyait pas).
2. **`chromecast-api` n'émet ses requêtes de découverte que dans son constructeur.** Il faut rappeler `client.update()` explicitement à chaque `ping()`, sinon aucun appareil allumé après le démarrage du daemon n'est jamais trouvé. Ne **pas** re-créer le client pour forcer un nouveau scan : cela invalide les objets `device` en cache, qui sont précisément ceux qui servent à caster. `client.update()` re-déclenche mDNS + SSDP sans détruire le client. (Chromecast reste soumis au problème d'interface décrit plus haut, puisque ses sockets ne sont pas configurables — c'est une limite connue.)

`POST /devices/add` contourne complètement SSDP : il sonde une IP donnée sur les ports `SAMSUNG_PORTS` (9197, 7676, 52235, 49152, 1234) et plusieurs chemins de description XML, puis injecte l'appareil dans le cache DLNA. À utiliser quand la découverte multicast est bloquée sur le réseau.

### Le contrat de `GET /devices`

- `GET /devices` → réponse **immédiate depuis le cache** (~0,3 s), et relance un `ping()` en tâche de fond pour que le prochain appel soit à jour. C'est le chemin par défaut : ouvrir l'extension ne doit jamais imposer 4 s d'attente.
- `GET /devices?scan=1` → vraie découverte réseau, ~4 s. C'est le bouton « Rechercher », et le rafraîchissement de fond que le popup lance après son premier affichage.
- Cache vide → scan quand même, sinon on répondrait une liste vide au démarrage.

### Pourquoi le daemon ne meurt jamais sur une exception

`index.js` installe des gardes `uncaughtException` / `unhandledRejection` qui **loguent sans quitter**. Ce n'est pas de la négligence : les librairies UPnP/mDNS parsent du XML fourni par la TV et lèvent depuis leurs propres callbacks asynchrones, hors de portée des `try/catch` des modules de cast. Un cas réel et reproductible : `upnp-device-client` casse sur un `SCPDURL` absent et tuait tout le processus — donc le proxy, donc la lecture en cours, donc tout le cache d'appareils.

Corollaire : `castViaLibrary()` a un **timeout** (6 s). Quand la librairie meurt dans un callback interne, elle ne rappelle jamais son callback ; sans ce timeout la requête reste pendue et le fallback SOAP n'est jamais atteint.

### `daemon/discovery.js` — le multicast et le choix d'interface

Module central, et la raison d'être de la découverte qui fonctionne. À lire avant de toucher à quoi que ce soit de réseau.

**Le piège du multicast multi-interfaces.** SSDP et mDNS émettent vers une adresse multicast. Un socket lié à `0.0.0.0` laisse la table de routage choisir l'interface d'émission — et sur une machine avec des adaptateurs VMware / Hyper-V, elle choisit souvent un adaptateur virtuel. La requête n'atteint alors jamais le réseau de la TV, silencieusement. `dlnacasts2` (`new SSDP()`) et `chromecast-api` (`mdns()`, `new Ssdp()`) instancient leurs sockets **sans options** : impossible de leur imposer une interface.

D'où `discovery.search()` : il émet le M-SEARCH **depuis chaque interface**, socket lié par `bind({address})` + `setMulticastInterface()`. Pas de liste noire à maintenir — seule la bonne interface reçoit des réponses. `cast/dlna.js` n'utilise donc plus `dlnacasts2` pour découvrir ; il lit directement le `LOCATION` de la réponse SSDP, ce qui évite au passage de sonder les ports. `cast/airplay.js` ouvre un socket `multicast-dns` **par interface** pour la même raison.

Symptôme si on régresse là-dessus : ça marche sur une machine à interface unique (un portable en Wi-Fi) et pas sur un poste avec VMware ou Hyper-V, avec exactement le même code.

**Le choix de l'IP annoncée.** `localIpFor(host)` retourne l'adresse de l'interface dont le sous-réseau **contient réellement** l'appareil visé (comparaison masquée). Sans cible, il utilise l'interface de sortie par défaut de l'OS, obtenue en « connectant » un socket UDP (aucun paquet émis, simple résolution de route) — `resolvePreferred()`, appelé au démarrage.

Cela remplace les deux copies divergentes de `getLocalIp()` qui vivaient dans `index.js` et `proxy.js`. Leur liste noire d'adaptateurs virtuels était structurellement incomplète : le « vEthernet (Default Switch) » d'Hyper-V n'était filtré ni par nom (pas de `hyper-v` littéral) ni par plage (`172.20.` n'était pas couvert), et passait donc pour une interface réelle. Il suffisait que l'OS l'énumère en premier pour que la TV reçoive une URL de proxy injoignable.

`registerStream(url, referer, { target })` prend donc l'IP de l'appareil consommateur. `cast/dlna.js` passe `device.host` ; pour les segments HLS, `rewriteM3u8()` passe l'IP du client qui vient chercher le manifest (`req.socket.remoteAddress`), c'est-à-dire la TV elle-même.

### Pourquoi le daemon écoute sur 0.0.0.0

C'est la TV qui va chercher la vidéo sur le daemon : `localhost` ne suffit donc pas.

Piège à ne pas réintroduire : `server.js` exporte l'**app Express**, pas le serveur HTTP. Il faut s'abonner à `'error'` sur l'objet **retourné par `listen()`** — un `app.on('error')` ne se déclenche jamais, et l'EADDRINUSE ressortait alors en exception non gérée.

### La chaîne de contournements Samsung DLNA

`proxy.js` + `cast/dlna.js` n'existent presque que pour contourner le firmware des TV Samsung. Les couches, toutes indispensables :

1. Samsung DLNA refuse HTTPS → tout stream `https://` est réenregistré derrière le proxy HTTP du daemon (`registerStream`).
2. Samsung s'étouffe sur les URLs longues ou percent-encodées → chaque stream reçoit un ID aléatoire de 4 octets hex et un chemin court (`/stream/<id>`), stocké dans un `streamStore` (distinct de celui de l'extension, qui porte le même nom).
3. Samsung déduit le type depuis l'extension du fichier → **toutes** les URLs proxy se terminent par `.mp4`, segments compris. `streamHandler` retire l'extension avant la recherche : elle n'est qu'un indice pour la TV, jamais une donnée d'identification.
4. Samsung rejette les MIME HLS → le proxy annonce `Content-Type: video/mp4` et le profil `contentFeatures.dlna.org` **sur tout**, manifeste comme segments. Le corps peut être du vrai MPEG-TS ; la TV ne vérifie que ce qu'on lui déclare.

   **⚠ La fiction doit être TOTALE et UNIFORME. Ne pas la « réparer ».**

   J'ai tenté quatre fois de corriger cette incohérence apparente en disant la vérité sur les segments. Chaque tentative a **cassé une lecture qui fonctionnait** :

   | Ce que j'ai « corrigé » | Résultat |
   |---|---|
   | `Content-Type` du segment → `video/mp2t` | cassé |
   | Extension de l'URL du segment → `.ts` | cassé |
   | En-têtes DLNA retirés des segments | cassé |
   | `DLNA.ORG_PN` retiré du manifeste | cassé |

   La raison, mise au jour en journalisant les requêtes **entrantes** : cette TV ne parse pas le HLS. Elle demande `HEAD`, puis `GET Range: bytes=0-`, puis `Range: bytes=8192-` — elle traite le manifeste comme **un fichier MP4 binaire** et y cherche par plages d'octets. Son démuxeur s'accommode d'une charge utile MPEG-TS tant que *rien* ne contredit la fiction MP4 ; un seul élément véridique suffit à la rompre.

   Corollaire : le `Range` doit être honoré **sur le manifeste lui-même**. Comme son corps est réécrit par nos soins, on ne relaie pas la plage vers la source — on découpe notre propre corps (`servirCorps()`) et on répond `206` avec le bon `Content-Range`. Tant qu'on répondait `200` depuis l'octet 0, la TV redemandait la même plage sans jamais progresser.
5. Les manifests HLS sont réécrits ligne par ligne par `rewriteM3u8()` — chaque URL de segment est résolue en absolu puis réenregistrée avec son propre ID court, pour que les entrées de playlist passent aussi par le proxy avec le `Referer` d'origine.
6. Le cast se fait en deux niveaux : `castViaLibrary()` (fork jaruba de `upnp-mediarenderer-client`, qui gère la particularité EUPNP de Samsung) d'abord, puis `castViaSoap()` écrit à la main en secours.
7. `castViaSoap()` essaie **quatre** variantes de metadata `SetAVTransportURI` dans l'ordre (protocolInfo DLNA complet → simplifié → sans metadata → MIME HLS), le comportement variant selon le firmware.
8. Les codes d'erreur SOAP **704** (restriction PrepareForConnection) et **705** (TransportLocked) sont traités comme des succès — la TV joue généralement quand même.

Toucher au forçage du MIME, au suffixe `.mp4` ou au schéma d'IDs courts casse la lecture Samsung.


### Performance du proxy : cinq pièges déjà payés

La navigation dans la vidéo est le cas critique — **la TV relit le manifeste à chaque déplacement validé**, puis réclame plusieurs segments d'un coup. Cinq coûts y ont été supprimés, à ne pas réintroduire :

1. **Les IDs de flux sont DÉTERMINISTES** — `sha1(url|referer|mode)` tronqué à 12 hex, jamais `randomBytes`. Avec des IDs aléatoires, chaque relecture du manifeste réinventait une URL par segment : la TV ne pouvait réutiliser **aucun** des segments qu'elle venait de télécharger, et `streamStore` grossissait de 300 entrées par saut. C'était la cause principale du « ça recharge toutes les 5 s ».
2. **Les manifestes réécrits sont mis en cache** (`manifestCache`, clé `mode|ip client|url`). Sans cela, chaque saut payait un aller-retour vers le CDN avant même de charger le premier segment. TTL long si `#EXT-X-ENDLIST` est présent (VOD figée), très court sinon (direct). Mesuré : 143 ms → ~1 ms par saut, 1 seul appel CDN pour 10 relectures.
3. **Ne jamais logger par segment.** `registerStream()` écrivait deux lignes de console par URL. Sur un manifeste de 300 segments, cela faisait 600 écritures **synchrones** (la console Windows bloque), soit ~1,4 s à chaque relecture. D'où l'option `quiet`, utilisée par `rewriteM3u8()`, et un unique log de synthèse. Mesuré : 1476 ms → 23 ms.
4. **Résoudre l'IP locale une seule fois par manifeste.** `discovery.localIpFor()` interroge `os.networkInterfaces()` ; l'appeler par ligne ajoutait un appel système par segment. `rewriteM3u8()` la calcule une fois et la passe via l'option `localIp`.
5. **Réutiliser les connexions vers le CDN.** Sans agent `keepAlive`, chaque segment repayait une poignée de main TCP + TLS complète vers un serveur distant. Vérifié : 12 segments consécutifs ouvrent désormais **zéro** nouvelle connexion.

### Résilience du proxy : ne jamais laisser un lecteur suspendu

Un lecteur (Chromecast comme DLNA) ne redémarre pas tout seul quand la réponse qu'il attend ne se termine jamais. Trois règles en découlent :

1. **`pipe()` ne propage pas les erreurs vers la destination.** Sans handler explicite sur `proxyRes` (`'error'` *et* `'aborted'`), un flux amont coupé en cours de transfert laisse la réponse cliente ouverte à jamais — le lecteur « perd le fil » et ne repart pas. Vérifié : le client est désormais libéré en ~55 ms au lieu de ne jamais l'être.
2. **Réessayer les erreurs transitoires.** Le `keepAlive` a un revers : le CDN peut fermer une connexion inactive, et Node rend alors un socket mort — la requête échoue en `ECONNRESET` sur un segment parfaitement valide. `fetchAndProxy()` réessaie jusqu'à `MAX_ATTEMPTS`, mais **uniquement tant que les en-têtes ne sont pas partis** : au-delà on ne peut plus rejouer la réponse, il faut couper avec `res.destroy()`.
3. **Ne jamais servir ni cacher un manifeste tronqué.** Le drapeau `aborted` court-circuite le handler `'end'` : un manifeste incomplet mis en cache resterait valable une minute et casserait toute la lecture.

4. **Le délai amont ne doit couvrir QUE l'établissement de la réponse.** `proxyReq.setTimeout(0)` est appelé dès que la réponse arrive, et ce n'est pas une négligence. Un délai d'inactivité maintenu pendant le transfert **coupe la lecture en cours** : quand le client a rempli son tampon il cesse de lire, la contre-pression TCP remonte jusqu'au proxy qui arrête de tirer depuis le CDN, et le socket amont devient inactif — c'est le fonctionnement *nominal*, pas une panne. Sur un MP4 progressif, la vidéo s'arrêtait exactement à la taille du tampon (~36 s observées). Vérifié : un transfert de 8 Mo survit désormais à une inactivité de 25 s.

La fin de vie est couverte autrement, sans délai : `res.on('close')` coupe la requête amont si le client s'en va (saut, arrêt), et les handlers d'erreur de `proxyRes` traitent la mort de l'amont.

### Le seek, dans les deux modes

`DLNA.ORG_OP=01` annonce à la TV que le seek par octets est possible. On l'annonçait **sans l'implémenter** : la TV tentait un saut, le proxy ignorait le `Range` et renvoyait le flux depuis le début, la TV rechargeait tout. D'où des sauts limités à quelques secondes, chacun suivi d'un long rechargement.

Le `Range` est donc relayé dans les deux modes, avec le statut `206` et le `Content-Range` transmis tels quels. **Exception : jamais sur un manifeste** — son corps est réécrit par nos soins et ne correspond plus à celui de la source, une plage d'octets dessus n'aurait aucun sens. La détection se fait avant la requête (`.m3u8` ou `index-v` dans l'URL).

### Les deux modes du proxy

Le mensonge sur le MIME est indispensable à Samsung et **fatal à Chromecast**, qui se fie au type annoncé. `registerStream()` prend donc un `mode` :

| | `'samsung'` (défaut) | `'strict'` |
|---|---|---|
| `Content-Type` | `video/mp4` sur le **manifeste** seulement ; le vrai type sur les segments | le vrai type partout, via `guessContentType()` |
| En-têtes DLNA | présents | absents |
| Requêtes `Range` | ignorées | relayées, `206` et `Content-Range` transmis |
| En-têtes CORS | `Allow-Origin` seul | `Allow-Headers` + `Expose-Headers` |
| Suffixe d'URL | `.mp4` | aucun |

`rewriteM3u8()` propage le mode aux segments. `guessContentType()` retire la query string avant de regarder l'extension : c'est elle qui fait échouer les détections naïves sur `master.m3u8?token=…`.

### Chromecast : pourquoi `chromecast-api` n'est plus utilisé

Trois défauts cumulés, qui expliquent que le cast Chromecast n'ait jamais fonctionné :

1. Sockets mDNS/SSDP non configurables → le problème d'interface décrit plus haut.
2. Son `DefaultMediaReceiver` réécrit `application/vnd.apple.mpegurl` en **`video/mp2t`** — le type d'un segment MPEG-TS, pas d'une playlist. Le récepteur tente de lire le manifeste comme un flux binaire.
3. Il déduit le type par `mime.getType()` sur l'URL complète, query string comprise, donc `master.m3u8?token=…` n'est pas reconnu et retombe sur `video/mp4`.

`cast/chromecast.js` fait donc sa propre découverte mDNS (`_googlecast._tcp.local`, un socket par interface, nom convivial lu dans la clé `fn` du TXT) et caste via `castv2-client` en direct. Le type est calculé sur l'URL **d'origine**, jamais sur l'URL proxy qui est volontairement neutre. Le flux passe par le proxy en mode `strict` dès qu'un `Referer` est nécessaire, sans quoi le CDN répond 403 — le Chromecast n'enverra jamais cet en-tête lui-même.

Subtilité mDNS : le SRV pointe vers un nom `.local` dont l'adresse arrive dans un enregistrement A, **pas forcément dans le même paquet**. Le handler mémorise donc les adresses vues et garde les services en attente, au lieu d'exiger que tout arrive ensemble.

**À savoir sur le matériel de test :** le Samsung Q70F répond *à la fois* en DLNA et en Google Cast (port 8009, `md=Q70F`). Il apparaît donc deux fois dans la liste, une entrée par protocole. La voie Chromecast est la plus saine des deux — HLS nativement supporté, pas de mensonge MIME, pas de roulette de variantes SOAP.

### Le port 7171 est codé en dur à plusieurs endroits

`daemon/index.js` (`PORT`), `daemon/proxy.js` (valeur par défaut de `registerStream` *et* une const `port` locale séparée dans `rewriteM3u8`), `extension/popup/popup.js` (`DEFAULT_DAEMON`), `extension/content/content.js` (`DAEMON_URL`). Aucune configuration partagée.

### L'extension gère PLUSIEURS daemons

Ce n'est plus une adresse mais **une liste**, sous la clé `servers` de `browser.storage.local`, plus `activeServerId`. Un serveur par lieu ou par machine — maison, bureau, portable. Le daemon, lui, n'en sait toujours rien : il ne connaît pas ses pairs et ne persiste rien. La liste vit là où vit déjà celle des appareils.

Une entrée porte **deux noms distincts, à ne pas fusionner** — exactement la même règle que pour les appareils :

| Champ | Origine | Écrasable ? |
|---|---|---|
| `nomReseau` | `os.hostname()`, lu dans `GET /status` | oui, à chaque sonde |
| `nom` | surnom saisi par l'utilisateur | **jamais** |

L'affichage prend `nom || nomReseau || hôte de l'URL`.

**`GET /status` renvoie `nom` pour ça.** C'est la seule identité stable d'un daemon : après un bail DHCP son adresse change, son nom de machine non. `integrerDetection()` s'en sert pour **recoller l'entrée existante sur la nouvelle IP** au lieu d'ajouter une ligne morte à chaque changement d'adresse.

**La bascule automatique** (`connecter()`, à l'ouverture du popup) : le serveur actif d'abord ; s'il ne répond pas, tous les autres **en parallèle** — les sonder en série ferait payer un délai d'attente par serveur, alors qu'ils sont tous injoignables en même temps quand on change de réseau ; on retient le premier de la **liste** qui répond, pas le plus rapide, parce que l'ordre de la liste est celui que l'utilisateur a choisi. En dernier recours seulement, le balayage réseau.

**Un appareil enregistré appartient au serveur qui l'a vu**, via un champ `serverId` dans `savedDevices`. Ce n'est pas du rangement : deux daemons sur un même réseau voient les mêmes TV, parfois sous des **adresses différentes** — l'un par le Wi-Fi, l'autre par un partage de connexion Windows, dont le sous-réseau `192.168.137.0/24` est fixe. Comme l'ID d'appareil est bâti sur l'IP (`dlna-192-168-1-13`), la même TV donne alors deux entrées. Une liste commune les empilait toutes, sans moyen de savoir laquelle venait d'où.

Toutes les lectures passent donc par `appareilsDuServeur()` et `trouverEnregistre()` — lire `saved` directement réintroduit le mélange. Deux exceptions volontaires : `sousReseaux()`, qui veut au contraire **toutes** les IP connues puisqu'il cherche un daemon, n'importe lequel ; et `oublierServeur()`, qui emporte les appareils du serveur supprimé — rattachés à un serveur disparu, ils ne pourraient plus jamais réapparaître.

Ce découpage ne traite que la moitié du problème. L'autre est côté daemon : **un seul daemon voit la même TV sur deux de ses interfaces** dès que plusieurs chemins mènent à elle. Voir « Un appareil, plusieurs adresses » ci-dessous.

### Un appareil, plusieurs adresses

Émettre la découverte depuis **toutes** les interfaces est nécessaire (raison plus haut), mais a une contrepartie : quand plusieurs chemins mènent au même appareil, il répond sur chacun, avec l'adresse propre à ce chemin. Le partage de connexion Windows crée exactement ce cas — son sous-réseau `192.168.137.0/24` est fixe — et une TV devient joignable en `192.168.1.13` par le Wi-Fi *et* en `192.168.137.247` par le partage.

Les caches étant indexés sur l'IP (`dlna-192-168-1-13`), la même TV occupait alors une entrée par adresse **et par protocole**. Mesuré sur un poste avec partage actif : `4 appareil(s) mis en cache: [ '85" QLED', '85" QLED', '85" QLED', '85" QLED' ]` — un seul téléviseur.

Chaque module tient donc une table `identites` : **identité stable → id en cache**. L'identité ne dépend pas de l'interface qui a reçu la réponse, contrairement à l'adresse.

| Protocole | Identité stable | Origine |
|---|---|---|
| DLNA | l'UDN | en-tête `USN` de la réponse SSDP, repli sur `<UDN>` du description.xml |
| Chromecast | le nom d'instance mDNS | le `name` de l'enregistrement SRV |
| AirPlay | le nom de service mDNS | la donnée du PTR |

**Deux points à ne pas défaire :**

- `discovery.search()` déduplique par `LOCATION`, ce qui ne suffit pas : l'URL contient l'IP, donc deux réponses du même appareil ont deux locations. Et l'en-tête `USN`, qui porte l'identité, n'était pas extrait du tout de la réponse SSDP.
- `adresseMeilleure()` ne remplace une adresse connue **que** pour gagner le réseau principal — celui de l'interface de sortie par défaut. À égalité, la première vue reste. Une règle qui bascule à chaque découverte ferait changer l'ID de l'appareil d'un scan à l'autre, et l'extension perdrait ses appareils enregistrés à chaque fois.

On garde l'adresse du réseau principal parce que c'est celle que le téléphone et la TV ont en commun, et la seule qui survive à l'extinction du partage de connexion. `POST /devices/add` n'est pas concerné : un ajout manuel est explicite, il enregistre l'IP demandée.


`daemonUrl`, l'ancienne clé, n'est plus **écrite** : son seul autre lecteur était le panneau injecté, supprimé depuis. Elle est encore **lue une fois**, dans `chargerServeurs()`, quand `servers` est absent — c'est la reprise des installations antérieures, et rien d'autre. Ne pas la remettre à jour « au cas où » : une clé écrite que personne ne lit finit par diverger sans que rien ne le signale.

**Détection automatique.** `detecterDaemon()` sonde des adresses candidates et n'en retient une que si `GET /status` répond `app: "re:cast"`. Un simple HTTP 200 ne suffit pas : n'importe quel appareil peut écouter sur 7171. Ordre : adresses directes (toutes celles de la liste, `localhost`, `127.0.0.1`), puis balayage de `/24`.

Le choix des `/24` à balayer vient d'indices qu'on a déjà sous la main : **les IP des appareils enregistrés** — une TV castée un jour est forcément sur le réseau du daemon — puis celles des serveurs enregistrés, qui désignent des réseaux qu'on fréquente. Les plages génériques (`192.168.1`, `192.168.0`, `10.0.0`, `192.168.2`) ne servent qu'au premier lancement.

Deux points à ne pas défaire :

- `sousReseaux()` distingue **deux** entrées, une pour les IP complètes et une pour les préfixes. Une seule fonction exigeant quatre octets rejetait silencieusement toutes les plages de repli, et le premier lancement — le cas où le balayage sert le plus — ne sondait rien.
- La détection se déclenche **sur échec**, jamais à chaque ouverture. Balayer le réseau systématiquement serait long et inutile alors que l'adresse enregistrée est bonne presque toujours. Le bouton « Détecter sur le réseau » permet de la forcer.

Pas de mDNS ici : une extension n'a aucune API de socket UDP. Ce qui rend le balayage possible, c'est que la permission d'hôte universelle exempte `fetch()` du CORS.

### Le popup : cinq écrans qui se remplacent

`popup.js` tient une `vue` unique parmi `principale`, `serveurs`, `ajoutServeur`, `ajoutAppareil`, `lecture`, et `rendre()` n'affiche que celle-là. Les écrans secondaires **remplacent** la vue principale au lieu de s'empiler dessous : en vue plein écran sur Fenix, un formulaire poussé sous une liste d'appareils naît hors de l'écran.

Trois conséquences de forme :

- **Rien n'est construit en `innerHTML`.** Les noms d'appareils et de serveurs viennent du réseau ; les lignes sont assemblées en DOM, et les icônes SVG par `createElementNS`. C'est la même fonction qui sert aux deux, mélanger balisage et données n'aurait jamais été sûr.
- **La valeur d'un champ d'édition vit dans l'état, pas dans le DOM** (`editValeur`, `editServeurValeur`). Un rendu déclenché pendant la frappe — fin d'un scan, réponse d'une sonde — recrée le champ, et la saisie serait perdue. Le drapeau `focusAPrendre` évite au passage de reprendre le focus à chaque rendu : sans lui, `select()` rejouait à chaque fois et la frappe suivante effaçait tout.
- **L'état de lecture est restauré depuis `/status`.** `state.js` y joint désormais `host` et un `protocole` lisible (`Chromecast`, pas `CHROMECAST`) : c'est tout ce que le popup a pour réafficher « En lecture · DLNA · 192.168.1.222 » après une fermeture de Firefox.

**Le pied de page est `sticky`, jamais `fixed`.** Le bouton d'action — « Caster » en tête — se retrouvait sous la ligne de flottaison dès que la liste d'appareils s'allongeait, donc hors de portée du pouce en vue plein écran. `position: fixed` le ramènerait en bas, mais au prix d'une sortie du flux : le popup desktop se dimensionne sur son contenu, il réserverait une bande vide en permanence et le bouton flotterait au-dessus des dernières lignes même sans rien à faire défiler. `sticky` ne s'active que lorsqu'il y a effectivement de quoi défiler. Mesuré sur un banc d'essai à 360 × 560 px :

| | Position du pied |
|---|---|
| 6 appareils (document 726 px) | `478..560` — plaqué au bas de la fenêtre, contre `644..726` sans la règle, soit hors écran |
| 1 appareil (document 381 px) | collé à la dernière ligne, aucune bande vide sous lui |

Deux conditions à ne pas défaire : le pied doit avoir un fond **opaque** (`var(--fond)`), puisque les lignes défilent dessous, et `#app` ne doit **pas** porter de `padding-bottom` — cet espace resterait au bas du document sans jamais servir. Et pas de dégradé de raccord au-dessus : essayé, retiré. Il suppose que la zone juste au-dessus du pied soit vide quand rien ne défile, or sur les écrans secondaires le texte d'aide s'y trouve et ressortait grisé en permanence.

**La largeur de `#app` est fixe (`width: 360px`), pas un simple `max-width`.** Tant que c'était un plafond, la largeur préférée dépendait encore du contenu et changeait d'un écran à l'autre — le popup desktop s'élargissait dès qu'on ouvrait « Ajouter un appareil » ou la gestion des serveurs. Mesuré, avant correctif :

| Vue | Largeur préférée |
|---|---|
| principale, lecture | 360 px — aucun texte long, on tombe sur le plancher `min-width` du body |
| serveurs, ajout serveur, ajout appareil | 420 px — le texte d'aide vient buter sur l'ancien plafond |

Après : 360 px sur les cinq écrans, y compris avec l'URL de flux dépliée, et largeur minimale égale à la préférée (donc aucun débordement possible). Le `max-width: 100%` reste pour les écrans plus étroits que 360.

**Thème clair et sombre** : un seul jeu de règles, toutes les couleurs derrière des variables CSS, `prefers-color-scheme` bascule l'ensemble. Pas d'interrupteur — la maquette montre les deux côte à côte pour les comparer, ce n'est pas un réglage du produit.

La maquette est dessinée en Archivo / IBM Plex Mono. Le popup reste sur la **pile système** : la CSP interdit une police distante, et le popup doit s'ouvrir hors ligne. Roboto sur Android, Segoe UI sur Windows — deux grotesques proches du dessin d'Archivo.

### CORS : deux régimes, à ne surtout pas unifier

`server.js` sépare volontairement deux familles de routes, et **l'ordre de déclaration fait partie du correctif** :

1. **Routes média** (`/stream/:id`, `/proxy`), déclarées **avant** le middleware `cors` et donc hors de son champ. Leur client n'est pas l'extension mais la TV ou le récepteur Chromecast. Ce dernier est une page web et envoie une origine `googleusercontent.com` / CloudFront : la politique stricte la rejetait, et la lecture restait bloquée avec pour seul symptôme une barre de chargement infinie côté TV. Elles répondent `Access-Control-Allow-Origin: *`, exposent les en-têtes de Range, et gèrent le préflight `OPTIONS` que Chromecast envoie avant ses requêtes partielles.

2. **API de contrôle** (`/status`, `/devices`, `/cast`, `/stop`, `/devices/add`), derrière la politique restrictive : `moz-extension://`, `chrome-extension://`, `http(s)://localhost`, ou origine absente. Les origines d'extension Firefox portent un UUID propre à chaque installation, d'où la regex plutôt qu'une liste blanche fixe. **Cette restriction est la seule chose qui empêche un site visité par l'utilisateur de piloter le cast** — élargir cette politique pour « régler un problème CORS » ouvrirait cette porte. Si le blocage concerne une TV, c'est une route média, pas celle-ci.

Un handler d'erreur final transforme un refus d'origine en `403` avec une ligne de log, au lieu d'une stack trace répétée à chaque requête.

### Le pare-feu Windows fait partie du montage

C'est la TV qui ouvre une connexion TCP entrante vers le port 7171. Sur un réseau classé **Private**, Windows la bloque par défaut — et les règles installées par Node.js ne couvrent souvent que le profil **Public**. Symptôme caractéristique : le cast « démarre » (le récepteur se lance sur la TV) mais **aucune ligne `Proxy fetch` n'apparaît dans les logs**, car la TV n'atteint jamais le daemon. La découverte, elle, continue de fonctionner : les réponses SSDP/mDNS sont de l'UDP sollicité, que le pare-feu laisse passer. Piloter l'extension depuis le PC lui-même masque le problème, tout passant alors par la boucle locale.

```powershell
New-NetFirewallRule -DisplayName "re:cast daemon (7171)" -Direction Inbound -Protocol TCP -LocalPort 7171 -Action Allow -Profile Private
```
