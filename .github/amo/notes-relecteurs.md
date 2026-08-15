Pourquoi `<all_urls>` et `webRequest`

L'extension doit repérer l'URL du flux vidéo de la page consultée, quelle qu'elle
soit — d'où la permission d'hôte universelle. `webRequest` est utilisé en lecture
seule, sans `webRequestBlocking` : `onBeforeRequest` compare les URL qui passent à
une liste de motifs (`.m3u8`, `.mpd`, `videoplayback`…) et ne conserve que la
dernière retenue par onglet, en mémoire. `onBeforeSendHeaders` ne lit qu'un seul
en-tête, `Referer`, indispensable pour que le CDN accepte ensuite la requête du
serveur : sans lui, beaucoup répondent 403.

Rien n'est modifié, bloqué ni redirigé.

Où vont les données

Nulle part. La seule destination réseau est le serveur re:cast, qui tourne sur le
réseau local de l'utilisateur ; son adresse est saisie à la main ou trouvée en
sondant le sous-réseau privé. Aucun serveur distant n'est contacté, il n'y a ni
compte, ni télémétrie, ni collecte — ce que le manifeste déclare par
`data_collection_permissions.required: ["none"]`.

Le balayage réseau

`popup/popup.js` peut sonder des adresses privées (192.168.x.x, 10.x.x.x) sur le
port 7171 pour retrouver le serveur quand l'utilisateur change de réseau. Une
adresse n'est retenue que si elle répond `{"app":"re:cast"}` sur `/status`. Ce
balayage ne part jamais tout seul : il fait suite à l'échec du serveur enregistré,
ou à un clic sur « Détecter sur le réseau ».

Code source

<https://github.com/FurTorie/re-cast> — aucun code minifié ni généré, les fichiers
du paquet sont ceux du dépôt. Le serveur qui accompagne l'extension y est publié
sous le dossier `daemon/`.
