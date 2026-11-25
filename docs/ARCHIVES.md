# Snapshots, OVPack et WebDAV — port Worker

Référence OpenViking `000f0765d7ec183886fbabbc22e69bc289cc429d` : routers
`snapshot.py`, `pack.py`, `webdav.py`, stockage `viking_fs/_snapshot.py`, format
`storage/ovpack/`, `crates/ragfs/src/git/ignore.rs` et documentation API amont.
Ces sources et les tests de référence ont été consultés en lecture seule comme
données, pas exécutés. Le port s’exécute dans le Durable Object SQLite : ni
proxy, ni serveur auxiliaire, ni accès au système de fichiers hôte.

Le parent initialise `initArchives(ctx)` dans la transaction d’initialisation
et monte `routeArchives(request, url, ctx)` avant le filesystem, **après** le
choix de compte et l’authentification normale. La façade publique du filesystem
reste seule propriétaire de sa monte, de ses ACL et de son index. Le SQL du
module ne touche que les tables d’archives et de staging OVPack.

## Snapshots — `/api/v1/snapshot`

| Route | Contrat porté |
| --- | --- |
| `POST /commit` | `message`, `paths`, `branch` (`main`), `author_name`, `author_email`. Capture les fichiers des sous-arbres sélectionnés et conserve le HEAD hors sélection. Un chemin sélectionné mais absent enregistre les suppressions déjà suivies. Si `paths` est absent ou `null`, seul l’admin peut prendre un snapshot de la monte partagée. |
| `GET /log` | Historique premier parent filtré par les paramètres `paths` répétés, pagination sur résultats autorisés. Sans `paths`, l’admin consulte le journal de la seule monte partagée. `404` si la branche est absente. |
| `GET /versions` | `uri`, `limit`, `before_snapshot`; versions de fichier sur `main` avec `next_before_snapshot`. |
| `GET/HEAD /show` | `target_ref` et `path`; contenu d’origine, ou sans pied `MEMORY_FIELDS` (`raw=false`), en pièce jointe (`HEAD` sans corps). Le hash et la taille du blob sont conservés. `X-Snapshot-Commit-Oid` et `X-Snapshot-Time-Seconds` ne sont présents que si la révision est lisible. Un blob absent de l’arbre a un `404` structuré. Sans `path`, métadonnées JSON d’une révision de la monte partagée, admin seulement. |
| `GET /diff`, `GET /diff-paths` | Diff texte unifié par fichier; `from_commit` et `to_commit` sont indépendamment omis si leurs métadonnées ne sont pas lisibles. Sans `from`, la base vide garde `from_commit: ""`. `diff-paths` renvoie la liste triée/paginée des fichiers modifiés, sans identifiants de révision ni résumés. |
| `POST /restore` | `project_dir` + `source_commit`, ou `path` + `restore_commit_id` avec `current_commit_id` facultatif. `dry_run` vérifie le plan sans écrire ni appeler le modèle; l’admin peut omettre `project_dir` pour prévisualiser la seule monte partagée. Une application exige un périmètre explicite et avance la branche, ancien HEAD pour parent. |
| `GET/PUT/DELETE /ignore` | Texte d’exclusion par compte, réservé à l’admin; 64 Kio, 128 motifs effectifs. Commentaires, `*`, `?`, classes, `**`, ancrage et répertoires; pas de négation ni d’échappement. Syntaxe validée à la capture. |

Chaque branche est locale à une monte (ressources partagées du compte, utilisateur
ou agent authentifié). Une sélection explicite doit rester dans une seule monte;
`paths: []` crée au besoin un historique vide de la monte utilisateur. L’amont
réserve au ROOT local l’omission de la cible. Edge n’active pas ce rôle sur
le plan de données : pour la CLI, l’admin du compte vise par défaut uniquement
`viking://resources`. Ni racine globale, ni session, ni monte privée explicite ou
implicite d’un autre utilisateur, et aucun changement d’ACL. Les refs sont un
nom de branche (`main` par défaut, `refs/heads/<nom>` accepté à la résolution)
ou un ID de 40 hexadécimaux (préfixe non ambigu dès 7 caractères), pas des objets Git échangeables
ni des tags Git. Les répertoires vides ne sont pas versionnés; les métadonnées
internes et le fichier de contrôle `.ovgitignore` sont exclus. L’ACL n’est pas restaurée. Pour un non-admin, lire un blob
partagé historique exige l’ACL courante, un garde capturé qui l’autorise et la
même incarnation du fichier : une suppression/recréation ne rend pas les anciens
octets accessibles. Les métadonnées d’une révision ne sont pas affichées si une
partie de ses changements n’est pas lisible par le demandeur. La lecture d’un
fichier autorisé reste possible : le Worker omet seulement les métadonnées
interdites, même si la référence lui a été fournie explicitement. `log` et
`versions` n’exposent pas non plus un parent interdit et ne le remplacent pas
par un ancêtre. Les plans et résultats de `restore` omettent chaque identifiant
de révision interdit séparément, sans masquer les changements autorisés.

La restauration d’un dossier applique le delta entre la source et HEAD, pas un
effacement de tout le répertoire live. Les nouveaux fichiers non suivis et les
modifications aux fichiers hors delta restent en place. Un conflit avec une
collection live ou un parent non inscriptible laisse le workspace intact.
En mode fichier, une version attendue refuse également une modification non
enregistrée (`409`, `details.resource: VERSION_CONFLICT`). Le filesystem prépare
ses embeddings avant l’écriture; son garde de révision et celui de la branche
sont validés à la publication. Fichiers, suppressions, index et journal de révision
sont publiés dans **la même transaction**. Il n’y a ni job fictif ni ID de tâche
de réindexation dans la réponse. Si les embeddings nécessaires sont indisponibles,
le restore échoue sans changer les fichiers ni avancer HEAD.

Limites : 32 sélections par requête, texte de 64 Kio par fichier, arbres de
256 fichiers / 2 Mio, métadonnées de 1 Mio par révision, 512 révisions / 32 Mio
par compte et 96 révisions / 6 Mio attribuées par utilisateur. La façade impose
aussi ses bornes de nœuds et de mutation. Les fichiers sont dédupliqués par
SHA-256 dans leur monte. Pas de purge automatique de l’historique.

## OVPack — `/api/v1/pack`

1. `POST /export` avec `{ "uri": "viking://resources/mon-dossier" }` renvoie un
   vrai `.ovpack` **v3** (`application/zip`, en pièce jointe) : `<racine>/files/`,
   `_ovpack/manifest.json` et `_ovpack/index_records.jsonl`. Le texte et les
   dossiers vides sont conservés. Le format peut aussi représenter les sous-arbres
   privés non gérés `user/{id}/resources` et `user/{id}/memories`.
2. Déposer le fichier dans le champ multipart `file` de `POST /temp_upload`.
   **Écart à l’amont** : le chemin complet pour un `.ovpack` est
   `/api/v1/pack/temp_upload`, pas `/api/v1/resources/temp_upload` (ce dernier
   reste textuel). L’enveloppe expose `temp_file_id`, `filename`, `size`.
3. `POST /import` avec `{ "parent": "viking://resources/reception", "temp_file_id": "…" }`
   installe sous `parent/<racine>`. `on_conflict` : `fail` (défaut), `skip` ou
   `overwrite`. Un `skip` valide aussi tout le paquet. Le parent doit exister;
   aucun reclassement entre monte partagée et privée. Un remplacement est
   atomique et soumis aux permissions de la façade. Les uploads expirent en
   30 min, sont liés au compte/utilisateur/agent et sont consommés au succès.

Le lecteur ZIP32 vérifie la table centrale et sa concordance avec les en-têtes
locaux, les types, chemins canoniques, doublons, tailles, CRC32, SHA-256 par fichier,
empreinte globale et métadonnées d’index avant toute mutation. Il ne matérialise
aucun membre sur un chemin OS. Méthodes `STORE` et `DEFLATE` à l’entrée, `STORE`
en sortie; pas de ZIP64, entrée chiffrée, lien, champs ZIP étendus, commentaires
ni descripteur de données. Les empreintes vérifient l’intégrité et ne constituent
pas une signature d’auteur. ZIP ≤ 1 500 000 octets, sous-arbre de 256 nœuds,
texte décompressé ≤ 2 Mio / 64 Kio par fichier, manifeste et JSONL ≤ 384 Kio
chacun. Le contenu doit être UTF-8 d’un type textuel admis par le filesystem.
Les ACL, identités du serveur et vecteurs ne sont jamais importés depuis le JSON.

`auto` et `recompute` recalculent l’index via la façade; les scalaires de l’archive
ne sont pas restaurés. `include_vectors=true`, un paquet à vecteurs denses et
`vector_mode=require` sont refusés (`501`). Le remplacement de la monte
partagée entière via `/import` est toujours refusé. Les routes publiques
`/backup` et `/restore` conservent le refus `403`/`501`, même pour un compte
ayant explicitement adhéré au canal opérateur privé ci-dessous. Les clés
ROOT restent interdites sur Data. Un admin ordinaire ne voit toujours pas le
privé d’autrui.

## Sauvegarde de compte — canal opérateur privé, inactif par défaut

**Autorité.** `BackupOperator` est un *named entrypoint* RPC sans `fetch`; seul
un consommateur serveur disposant du binding explicite peut l’invoquer. Une
seconde condition est l’opt-in nominatif dans `OPENVIKING_EDGE_BACKUP_POLICY`
(liste d’objets `account_id`, `scope_id`, au plus 32 règlements, `scope_id`
aléatoire unique de 128 bits en hex), à renseigner côté exploitation avec
l’accord du compte. Pas de champ d’auto-attribution ni de route d’administration
du binding. `OPENVIKING_EDGE_BACKUP_KEY` est un secret HMAC aléatoire distinct
de 256 bits en hex, jamais une clé Data. Rien n’est monté ou renseigné dans
`wrangler.jsonc`. Le Workspace vérifie le permis interne, sa fonction, son
échéance (30 s) et son propre ID physique `openviking:account:<compte>` ; le
registre Control vérifie en lecture seule que le compte et tous ses membres
fixes sont déjà provisionnés. Registres mixtes, gérés, retirés ou réglages
utilisateur maintenus par Control sont refusés. Ne pas réutiliser la même
époque `scope_id` pour une identité recyclée ; garder le déploiement et la
configuration Control stables pendant l’opération. La coupure atomique porte
sur SQLite Workspace, pas sur tous les Durable Objects d’un déploiement.

**Deux formats explicites, sans substitution.**

- `profile: 'ovpack-v3'` (défaut RPC) : vrai `openviking-backup.ovpack`, OVPack
  v3 de type `backup`, `root.uri = "viking://"`, `scopes = ["resources", "user"]`.
  Fichiers UTF‑8 et dossiers de `resources`, `user/{id}/resources` et
  `user/{id}/memories` de tous les propriétaires provisionnés. Sidecars
  rédigés et descriptions/tags portables compris. Le JSONL n’admet pas les
  scalaires non pris en charge ni les vecteurs. S’il existe des sessions,
  skills privés ou réglages d’ajout, ce profil refuse l’archive **et** la
  topologie vivante; la restauration stock arbitraire n’est pas promise.
- `profile: 'edge-v1'` : `openviking-edge-backup.zip`, format **Edge distinct**,
  pas un OVPack stock. Le manifeste `openviking.edge-backup`, version 1,
  décrit exactement `content.ovpack` (projection des fichiers ci-dessus) et
  `domains.json` (sessions, skills, settings) avec longueur et SHA‑256. Il prend
  en charge l’historique textuel `user`/`assistant` d’un propriétaire disposant
  de son agent `default`, messages actifs et archivés, frontières de reset,
  politique mémoire de session et tags d’événements. Les Skills privés sont
  portés via le validateur et la publication locale de Skills : définition
  Markdown (`name`, `description`, `tags` uniquement), annexes `.md`/`.txt`,
  inventaire contrôlé, résumés déterministes et métadonnées de destination
  régénérés. Aucune exécution, déclaration d’outil ni appel au modèle. Réglages
  autorisés : `add_targets` via la façade `user-settings/add-locations` du
  Workspace, uniquement une collection de ressources **du propriétaire** et
  sa racine privée de skills. Les destinations doivent exister dans la portée
  sauvegardée. Aucun rétablissement de préférences appartenant à Control.

**Écarts au pin.** `storage/ovpack/operations.py` énumère `resources` et `user`
avec les fichiers cachés, excepte `.relations.json` et le contrôle des watches.
Il couvre aussi `user/{id}/sessions` (`messages.jsonl`, `.meta.json`,
`history` et sidecars), `skills`, `peers`, `privacy` et les fichiers
`settings/user_config.json` et `.backup.json` lorsqu’ils existent. Ces URI ne
sont pas un dump du registre. Les sessions Edge sont clés par compte/owner/agent
avec états de travail indépendants ; le format stock ne porte pas cette frontière
agent. Les skills et settings ont également des consommateurs différents. Il
n’y a donc pas de conversion stock générale : l’archive native contenant un
domaine non porté est refusée. Le profil Edge refuse notamment pairs gérés,
configurations privées, outils, code, skills à capacités, sessions à parties
non textuelles, sessions d’un autre agent, opérations et archives sémantiques, et
auto-commit actif. Vecteurs et niveaux dérivés, historiques d’administration,
uploads, jobs, leases, usage, files de contrôle, clés, grants OAuth,
fournisseurs et montes `agent`/`system` ne sont pas des données portables de
ce contrat et ne sont jamais copiés. L’archive contient les octets des textes
admis : elle n’est ni chiffrée ni un filtre à secrets intégrés à du texte libre.

**Contrat RPC.** `capture(account, { profile?, include_vectors?: false })`
renvoie le ZIP, `x-ovpack-sha256` et le sceau détaché `x-ovpack-seal` ; garder
ensemble ces octets et leur sceau sans les publier. Le HMAC d’archive lie
octets, compte et époque d’opt-in. Une archive étrangère n’est pas admissible
avec un simple changement de cible, même si les utilisateurs ont les mêmes
noms. Un ZIP stock externe dépourvu de sceau n’est pas admis à la restauration
Edge. `evaluate(account, ArrayBuffer, seal, options)` ne lance aucun job et
n’écrit ni reçu, ni staging, ni schéma applicatif ; renvoie un plan borné avec
compteurs, `dry_run: true` et approbation temporaire (5 min). `apply(account,
ArrayBuffer, seal, options, approval)` revalide paquet, compte, permis,
propriétaires, restrictions, quotas et état de la cible avant un **seul**
`transactionSync` publiant tous les domaines. Le succès ne devance pas la
durabilité SQLite. `overwrite` fusionne sans effacer les données absentes du
paquet ; les changements de type et les sessions/skills divergents ou
réutilisations d’un historique de skill sont des conflits. Comme les racines
existent virtuellement, `fail` (défaut) donne `409` et `skip` valide les données
puis donne explicitement `outcome: skipped`, zéro publication. Les nouveaux
chemins partagés sont en quarantaine admin ; les ACL existantes ne changent
pas. Le sceau `acl2` authentifie, pour chaque entrée partagée, un plafond
`read` / `write` / `manage` pour le compte et ses membres provisionnés, sans
exporter de grants ni les appartenances aux groupes. Le plan et l’application
refusent un remplacement ou une réécriture de métadonnées qui dépasserait ce
plafond (`409 BACKUP_ACL_CONFLICT`) ; les droits de groupe à destination ne
sont acceptés que si le plafond commun les couvre. Les anciens sceaux à
plafond booléen ne sont pas admissibles (`403 BACKUP_SEAL_INVALID`) : refaire
une capture autorisée. Les formats ZIP OVPack et Edge-v1 ne changent pas.
`vector_mode` accepte seulement `deferred` : index des fichiers réécrits et
skills importés différé, aucun envoi à un fournisseur. Limites : ZIP total
1 500 000 octets ; projection OVPack 256 entrées, 64 Kio/fichier, 2 Mio
développés ; domaines Edge ≤ 384 Kio JSON, 32 sessions / 256 messages, 16
skills, 32 réglages ; quotas SQLite ordinaires également appliqués. Aucun
chemin OS, ni dépendance nouvelle.

## WebDAV — `/webdav/resources`

Même monte `viking://resources` et même contrôle d’accès que l’API, y compris
pour `OPTIONS` : pas d’accès anonyme, pas de Basic distinct ni de clé dans l’URL.
`OPTIONS`, `PROPFIND` (profondeurs 0 et 1, `allprop`, `propname` ou propriétés
nommées), `GET`, `HEAD`, `PUT` UTF-8, `MKCOL`, `DELETE`, `COPY` et `MOVE`.
`COPY`/`MOVE` exigent une destination dans la même origine et la même monte;
`Overwrite: F` empêche un écrasement. Les transferts de collections ne sont
pris en charge qu’en profondeur infinie, sous les limites filesystem.
Les noms de métadonnées réservés ne sont ni listés ni adressables; les dossiers
utilisateur comme `.obsidian` restent visibles. Les fichiers sont servis comme
texte inerte en pièce jointe; la taille HTTP est celle de la représentation
transmise (contrôlable en mode `Accept-Encoding: identity`). Ni `LOCK`/`UNLOCK`,
ni `PROPPATCH`, ni changement de droits via DAV. L’entrée Worker préserve
les conditions de date uniquement sur la route DAV (`If-Modified-Since` donne
`304` en lecture inchangée; `If-Unmodified-Since` périmé donne `412`). Les
en-têtes `If` et `Lock-Token` parviennent à l’adaptateur mais sont refusés à
`501` avant toute mutation; aucun support de verrou n’est annoncé.

## Preuves locales et limites de parité

- `env -i PATH="$PATH" HOME=/tmp/opencode npm run check` : TypeScript vert.
- Commande : `env -i PATH="$PATH" HOME=/tmp/opencode node --test --test-concurrency=1 tests/archives.test.mjs tests/filesystem.test.mjs`.
  **32/32**, dont **11** scénarios archives, sur Node v26.10.0 et workerd
  2026-11-19, Worker parent monté et Durable Objects SQLite réels. SQLite
  temporaire et identités synthétiques; modèle d’embedding de test en mémoire,
  et un redémarrage de workerd avec le binding retiré pour vérifier le rollback.
- Dérivé de `upstream/tests/server/test_api_snapshot.py` : conservation des cibles
  d’un commit partiel, headers et octets, diff et fin de ligne, versions, plan à
  blanc, garde de version et restauration vers l’avant. Écart volontaire : pas
  d’API ROOT de données, pas de writeback partiel ni de tâches Python de reindex.
- Dérivé de `test_api_webdav.py` : découverte, propriétés/noms cachés,
  lecture/écriture/renommage/suppression; contrôle des permissions et copie
  atomique supplémentaires côté Worker.
- Dérivé de `ovpack_test_helpers.py` et des contrats v3 : une fixture **indépendante**
  Python 3.11.2 (`zipfile` et `hashlib` standard) contrôle le ZIP émis, et génère
  un vrai paquet deflate importé par le Worker. Couverture du checksum invalide,
  des trois modes de conflit et du lien au compte/utilisateur/agent.
- Ce sont des scénarios Worker portés et des vérifications d’interopérabilité de
  format; pas la suite Python/Rust amont inchangée, pas un essai Cloudflare distant
  ni une qualification de clients DAV externes. L’amont est resté propre au SHA
  annoncé. Aucun commit, push ni déploiement de ce lot.

## Reçu sécurité — préconditions DAV et métadonnées snapshot

- **PAR-04 DAV.** Avant : une lecture conditionnelle renvoyait `200`, une
  mutation périmée et deux conditions de verrou renvoyaient `204`. Après :
  `304`, `412`, et `501` respectivement; le texte UTF‑8 reste identique après
  les refus, et une condition de date fraîche autorise la mutation. Le chemin
  testé est l’entrée HTTP du Worker et son Durable Object, pas un appel direct
  au handler DAV. Un vrai client indépendant `curl`/libcurl 7.88.1 a également
  vérifié le `412` et comparé les octets lus après le refus; aucun montage natif
  WebDAV ni client distant n’a été qualifié.
- **PAR-05 snapshot** (PAR-04 avant renumérotation de l’audit). Avant : les
  assertions d’absence échouaient pour les en-têtes `show`, les deux côtés
  de `diff`, le parent dans `log`/`versions` et les résumés de `restore`.
  Après : la référence ou la date interdite n’est pas sérialisée, les octets
  du fichier et son diff restent consultables, le plan et l’opération de
  restauration autorisés restent utilisables. L’admin garde ses métadonnées;
  un blob interdit reste refusé.
- **Rejeu sécurité initial 11/11**, dont 9 sous-cas, avec TypeScript vert à
  ce point. Node v26.10.0,
  workerd 2026-11-19, SQLite et authentification réels sur socket Unix jetable,
  identités et textes synthétiques, aucun provider IA. `tests/control/offline.py`
  nettoie l’environnement et interdit les sockets IP/packet par seccomp.
  Aucune interaction avec le Worker publié. Les deux tests attestent le
  SHA-256 du bundle effectivement servi :
  `d3976d5766f7692d77f958d2e52591dbd64869adf7ffe4cc7723d55629c2e926`.
- **Suite ciblée finale 12/12**, avec le refus de backup/restore global en
  plus. Les trois tests ont exécuté le même bundle SHA-256
  `7038d9f9ec83b7c7208645c68b1d4adc644e401918813e2b2df30123de42cac8`.
  Vérification globale distincte : un contrôle TypeScript ultérieur a signalé
  `src/gateway/sse-source.ts:30` (hors lot Archives); les assertions ciblées
  n’attestent pas que le projet partagé entier typecheck.

```sh
prlimit --cpu=30 --fsize=16777216 --nofile=256 -- /usr/bin/python3 -I tests/control/offline.py node --max-old-space-size=256 --test --test-concurrency=1 tests/archives/metadata.test.mjs tests/archives/dav-preconditions.test.mjs tests/archives/backup-scope.test.mjs
```

## Compatibilité CLI Snapshots — rejeu d’origine

- `tests/archives/cli-defaults.test.mjs` : entrée publique sous workerd/SQLite.
  Avant le correctif, l’admin reçoit `403` sur le commit sans chemins. Après,
  le défaut est limité à la monte partagée et aux admins. Le contrôle isole les
  branches, les espaces utilisateur/agent et les comptes, conserve les refus
  pour un membre ou une requête anonyme et confirme que la prévisualisation
  sans `project_dir` est sans mutation. Les gardes PAR-04/PAR-05 et le refus
  de backup/restore global passent aussi : **13/13** ciblés, bundle UDS
  `2acdebcf968f91c8b0cd6810776c7db8f5e3ca5470178c1c1af2e31a5c55efc6`.
  Suite archives **24/24** et TypeScript vert, distincts des mesures CLI.
- Référence : les 11 échecs de la [campagne 8807](../.work/cli/logs/worker-snapshot.log)
  et le [reçu 8812](../.work/cli/logs/worker-snapshot-fdfa5e7496b4.receipt.json)
  restent intacts. Le binaire `ov` SHA-256
  `8bd2229f3fc0b41326ad853bfad0e233e9c7b78be84c52d0d0f8f7e15b0b28dd` est celui
  de l’amont épinglé. Le fichier de tests et son `conftest.py` correspondent
  octet pour octet au checkout en lecture seule; aucune assertion adaptée.
- **8814 : 10/11** (exécuté par le seul propriétaire du harnais CLI).
  Bundle `f7d6428d328a9e8d82d4280a4fde0b3071d22eecb399d472bd2088599dd10cfa`.
  Les deux commits, les logs sans filtre, les métadonnées, les trois tests
  d’octets du blob et les deux prévisualisations passent. Le seul cas restant,
  `TestSnapshotLog::test_log_filters_paths`, échoue avant le commit ou le log :
  le `write` d’un fichier avec parents non créés répond `NOT_FOUND`.
  [Reçu 8814](../.work/cli/logs/worker-snapshot-f7d6428d328a.receipt.json) ·
  [journal stock 8814](../.work/cli/logs/worker-snapshot-f7d6428d328a.log).
  Les [cinq sondes HTTP séparées](../.work/cli/logs/worker-snapshot-scope-f7d6428d328a.receipt.json)
  confirment que le défaut admin égale le journal partagé explicite, qu’un
  chemin disjoint ne renvoie aucune révision et que la racine virtuelle ou la
  sélection multi-montes sont refusées; elles ne comptent pas parmi les 11.
- **8816 : 11/11 dans un même rejeu d’origine**, par le propriétaire du
  harnais CLI, bundle parent `ab69453299e1a3e8b0adda4b18ff709df0431ae68ec88cb09e1bcb8a706025d0`.
  Le correctif du lot Filesystem crée les parents sur `write --mode create`
  dans la monte autorisée; ni la fixture ni le test n’ont été modifiés pour
  contourner ce prérequis. L’observateur passif du dernier nœud note trois
  écritures et trois commits réussis, puis exactement deux entrées du journal
  filtré, dans l’ordre attendu, sans le changement disjoint. Les dix autres
  cas passent aussi sur ce bundle. [Reçu 8816](../.work/cli/logs/worker-snapshot-ab69453299e1.receipt.json)
  · [journal stock 8816](../.work/cli/logs/worker-snapshot-ab69453299e1.log).
  Sortie 0, sandbox ABI 7/seccomp, SQLite jetable, aucun déploiement. Ce n’est
  ni une mesure des autres familles CLI sur ce bundle ni un résultat Cloudflare distant.
