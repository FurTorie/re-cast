# Publier re:cast sur le catalogue public AMO

État actuel : l'extension est signée en canal **unlisted** (auto-hébergée). Le
`.xpi` est publié en release GitHub et Firefox se met à jour via `updates.json`.
Passer en **listed**, c'est confier la distribution à Mozilla.

Ce document existe parce que la bascule ne se réduit pas à changer un drapeau
dans le workflow : elle change le manifeste, rend `updates.json` inutile, et
impose une revue humaine.

## Par l'API ou par le site ?

**Par l'API, c'est possible** — contrairement à ce que dit le commentaire du
workflow, qui date. L'API v5 accepte une version listed à condition de fournir
quatre métadonnées : `name`, `summary`, `categories` et `license` (ou
`custom_license`, voir plus bas). Les clés vivant dans les secrets du dépôt,
l'appel doit partir d'un workflow.

**L'add-on existe déjà côté Mozilla**, créé par les signatures unlisted :
`GET /api/v5/addons/addon/recast@recast-extension/` répond `401` et non `404`.
Il ne s'agit donc pas d'une création mais de l'ajout d'une version listed.

Par le site, si on préfère la voie manuelle : <https://addons.mozilla.org/developers/>
→ le `.xpi` doit être construit **sans `update_url`** (voir plus bas), sinon la
validation le rejette en erreur.

Dans les deux cas, renseigner les **notes aux relecteurs** : c'est la partie qui
décide de la vitesse de la revue.

## Textes prêts à coller

**Nom** : re:cast

**Résumé** (250 caractères max)

> Caste la vidéo d'un onglet vers une TV Chromecast, DLNA ou AirPlay, en
> résolution native. Pas de partage d'écran : la TV va chercher le flux
> elle-même. Nécessite le serveur re:cast, libre et gratuit, sur un PC du réseau
> local.

**Description**

> Le partage d'écran d'un téléphone renvoie une image déjà décodée, redimensionnée
> et recompressée à la volée. On y perd la définition, la batterie fond, et le
> moindre appel coupe la vidéo.
>
> re:cast ne partage pas l'écran. Il repère l'URL du flux que le lecteur est en
> train de lire et donne cette adresse à la TV, qui va chercher la vidéo
> elle-même et la décode en pleine résolution. Le téléphone n'est plus qu'une
> télécommande : on peut le verrouiller, quitter Firefox ou sortir de la pièce,
> la lecture continue.
>
> Fonctionnement en deux morceaux : cette extension détecte le flux et sert de
> télécommande ; un serveur libre, à installer sur un PC du réseau local, parle
> aux téléviseurs (Chromecast, DLNA, AirPlay) et leur relaie le flux. Rien ne
> sort du réseau local, il n'y a ni compte, ni cloud, ni télémétrie.
>
> Le serveur, le code source et les instructions d'installation :
> https://github.com/FurTorie/re-cast

**Catégorie** : Photos, musique et vidéos — **Étiquettes** : cast, chromecast,
dlna, airplay, video

**Licence** : **PolyForm Noncommercial 1.0.0**, voir `LICENSE` à la racine.

Aucune licence prédéfinie d'AMO ne correspond — la liste se limite aux licences
libres classiques (MIT, GPL, MPL, Apache…) plus `all-rights-reserved`, et les
Creative Commons ne sont proposées que pour les thèmes. Il faut donc passer par
`custom_license`, avec `name` = « PolyForm Noncommercial License 1.0.0 » et
`text` = le contenu de `LICENSE`.

Ce que cette licence dit, et qui correspond à l'intention : usage, modification
et redistribution libres **tant qu'ils ne sont pas commerciaux**, et obligation
de transmettre les lignes `Required Notice:` — c'est le mécanisme, prévu par la
licence elle-même, qui force un fork à conserver la mention du dépôt d'origine.
Son texte n'est donc pas modifié ; seule la ligne `Required Notice` est ajoutée
en tête, comme la clause « Notices » le prévoit.

Deux conséquences à connaître : le projet **n'est pas open source** au sens de
l'OSI (une clause non commerciale l'exclut), et GitHub n'affichera pas de licence
reconnue dans l'encart du dépôt. La notion d'usage « non commercial » est par
ailleurs imprécise en droit — une entreprise qui s'en sert en interne, par
exemple, est un cas discutable.

**Collecte de données** : aucune. Le manifeste le déclare déjà
(`data_collection_permissions.required: ["none"]`).

## Notes aux relecteurs

À coller dans le champ prévu. Elles répondent d'avance aux deux questions que
posera la revue.

> **Pourquoi `<all_urls>` et `webRequest`**
>
> L'extension doit repérer l'URL du flux vidéo de la page consultée, quelle
> qu'elle soit — d'où la permission d'hôte universelle. `webRequest` est utilisé
> en lecture seule, sans `webRequestBlocking` : `onBeforeRequest` compare les URL
> qui passent à une liste de motifs (`.m3u8`, `.mpd`, `videoplayback`…) et garde
> uniquement la dernière retenue par onglet, en mémoire.
> `onBeforeSendHeaders` ne lit qu'un en-tête, `Referer`, indispensable pour que le
> CDN accepte la requête du serveur : sans lui, beaucoup répondent 403.
>
> Rien n'est modifié, bloqué ni redirigé. Aucune requête n'est émise vers un
> serveur distant : la seule destination réseau est le serveur re:cast, sur le
> réseau local de l'utilisateur, dont l'adresse est saisie ou détectée par
> balayage du sous-réseau privé. Aucune donnée n'est collectée ni transmise à un
> tiers, il n'y a ni compte ni télémétrie.
>
> **Code source** : https://github.com/FurTorie/re-cast — aucun code minifié ni
> généré, les fichiers du dépôt sont ceux du paquet.

## La bascule technique, une fois la fiche créée

Dans cet ordre, sinon la validation échoue :

1. **Retirer `update_url`** de `browser_specific_settings.gecko` dans
   `extension/manifest.json`. Mozilla le refuse sur un add-on qu'il héberge.
2. **Workflow** `.github/workflows/release-extension.yml` :
   - `--channel=unlisted` → `--channel=listed`
   - retirer `--self-hosted` du `web-ext lint` : ce drapeau n'existe que pour
     tolérer `update_url`, et il masquerait d'autres règles du catalogue
   - l'étape « Mettre à jour updates.json » et son commit n'ont plus d'objet
3. **`updates.json`** cesse d'être écrit. Le laisser en place tant que des
   installations unlisted existent : c'est leur seul chemin de mise à jour.

## Ce que la bascule coûte

- **La signature n'est plus immédiate.** En unlisted elle prend deux à trois
  minutes ; en listed, chaque version passe une revue, de quelques heures à
  plusieurs jours. Le rythme actuel — corriger, incrémenter, pousser — s'en
  trouve nettement ralenti.
- **Les installations existantes ne migrent pas toutes seules.** Elles pointent
  sur `updates.json`. Il faudra les réinstaller depuis AMO, ou garder les deux
  canaux le temps de la transition.
- **Le risque de refus est réel**, sans être élevé. Un add-on qui extrait des
  flux vidéo peut se voir demander des justifications ; les notes ci-dessus sont
  écrites pour ça. Un refus n'est pas définitif : on corrige et on resoumet.
