# OpenViking Cloudflare — relecture de sécurité de la parité

**Contre-relecture : PAR-01 à PAR-05 sont levés en source aux empreintes ci-dessous.** Le constat élevé concernait les ACL des descendants ; les trois moyens concernaient les watches, OAuth et DAV ; le faible concernait les métadonnées de snapshots. Aucun nouveau critique/élevé corroboré dans les chemins ciblés d’audit, de file, de Gateway ou d’accès anonyme ; une réserve de disponibilité SSE reste à trancher. **Audit non clôturé :** les témoins locaux sont attribués par lot et le verdict intégré attend les preuves du candidat final.

## Périmètre et preuve

Début à 16:14:53 UTC le 21 novembre 2026, racine `/home/agent/workspace/openviking-cloudflare`. Version déclarée `0.1.0-alpha.1` (`package.json:2–3`, `src/worker.ts`, constantes `version` et `upstream`) ; le SHA cité par le Worker est celui de l’amont, pas une révision du port. Pas de HEAD Git local à la racine. La source évolue : Gateway, métriques et traitement d’import stagé ont été montés pendant la passe. Les SHA-256 par fichier ci-dessous identifient les preuves ; ce n’est ni un gel atomique ni une preuve d’exécution.

Hors ligne, lecture seule sauf ce rapport : Worker / Durable Objects, auth/Control/ACL/OAuth, archives, audit, jobs et watches de texte, MCP et Gateway. Aucun secret ni configuration privée consultés ; aucun test, build, navigateur, appel aux instances du parent, accès réseau applicatif, exploit, commit, push ou déploiement effectué. Confinement OS complet non établi pour une exécution par l’auditeur ; aucune exécution revendiquée. **WAF/Access distant non vérifié**, ni affirmé présent ni absent. L’ancien [audit](SECURITY-REVIEW.md) reste historique et intact.

## Constats initiaux et contre-relecture des corrections

### PAR-01 — Élevé à l’ouverture · Garde ACL des descendants corrigée en source

**Frontière et résultat.** Un non-admin qui gère un répertoire partagé n’est pas nécessairement autorisé à gérer un descendant `restricted`. Pourtant, des opérations d’arbre peuvent effacer un descendant protégé, ou retirer un descendant dont l’appelant ne détenait qu’un droit de lecture. L’intégrité et la disponibilité du contenu d’un autre utilisateur sont en jeu dans le **même compte** ; pas de lecture de données privées intercompte démontrée.

**Preuve historique.** `ResourceAcl.compose` remplace les droits hérités en mode `restricted` (`src/acl.ts:107–123,125–142`). Avant correction (`src/fs/store.ts` SHA-256 `3c621a856d9e7d8850d3e7998cbafe6ac4cd9f992bc6e4a6461bc63d768982af`, `:249–258,348–394,398–416`), `remove` ne contrôlait que la racine ; le déplacement ne demandait que `read` aux descendants et l’écrasement ignorait les nœuds de destination absents du nouvel arbre avant de supprimer l’ancien. REST (`src/filesystem.ts:109–130,185–196`), DAV (`src/archives/webdav.ts:139–163`) et MCP `forget` en mode écriture (`src/mcp/tools.ts:236–243`) rejoignent le même stockage, pas trois défauts distincts. Le plan OVPack/snapshot dispose d’un contrôle distinct par suppression (`src/fs/subtree.ts:154–168,239–257`).

**Delta du writer relu.** `src/fs/store.ts:358–365,367–422` vérifie chaque descendant avec `manage` avant suppression/déplacement, contrôle toute la destination d’un écrasement d’arbre avant le `DELETE`, et utilise un `UPDATE` préservant ACL et incarnation pour le simple fichier de destination, avec `write`. Le déplacement contrôle toujours `manage` à la source ; la copie n’y exige que `read`. REST et DAV héritent de la transaction de stockage ; le delta MCP interdit en plus la suppression récursive partagée par un non-admin (`src/mcp/tools.ts:236–248`). `tests/filesystem.test.mjs:154–221` contrôle les refus, l’invariance de l’arbre/ACL/index, les cas autorisés et le remplacement de feuille. **Témoin du lot Filesystem : 1/5 avant, 5/5 après**, dont quatre refus passés de `200` à `403` (`docs/FILESYSTEM.md:80`). Pas de SHA du bundle dans ce reçu ; aucune exécution revendiquée par l’auditeur.

### PAR-02 — Moyen à l’ouverture · Vue de groupes du watch corrigée en source

**Frontière et résultat.** Une identité avec clé toujours valide, mais dont le droit d’écriture de groupe est retiré pendant un traitement déjà lancé, peut encore publier dans la ressource partagée via `runWatch`. Le contrôle de révision et la révocation de la clé sont distincts et ne ferment pas ce cas. Effet limité à un watch admis sur source autorisée, déjà en cours au retrait d’un groupe ; pas d’extension aux montes d’un autre compte.

**Preuve historique.** Dans `Workspace.workspaceContext`, la fermeture `reauthorize` renouvelle `groups` et `aclPrincipals` sur le contexte d’origine. L’ancien `runWatch` copiait les champs par valeur (`src/watches.ts` SHA-256 `c869a4b8b423c660ca1ac076402144701cd1e8d23b3d823041d42376a4ef5450`, `:261–273`). Malgré les réautorisations après attente, cette copie gouvernait l’ACL finale (`src/watches.ts:135–145`, `src/fs/store.ts:126–151`, `src/acl.ts:107–111,140–142`). Même chemin au déclenchement en job et à l’alarme récurrente (`src/worker.ts`, `consumers` et `Workspace.alarm`), pas à l’import immédiat qui ne dérive pas le contexte.

**Delta du parent relu.** `src/watches.ts:261–285` hérite du contexte via `Object.create`, sans écraser les champs d’autorité. Le garde vérifie le job, la révision et le marqueur du run avant publication ; `ingest` et `putText` lisent désormais les groupes rafraîchis. **Témoin workerd attribué au parent :** le même test de retrait de groupe a d’abord observé que le fichier existait (`200`), puis qu’il n’existait plus (`404`) après correction. L’assertion et le binding de texte fictif sont présents (`tests/watches.test.mjs:85–105`), distincts de la suppression de watch (`:70–83`). Empreintes source/test mesurées ci-dessous ; le parent n’a pas remis le SHA du bundle du rouge/vert. Ce témoin ne qualifie ni l’alarme récurrente à froid ni un bundle ultérieur.

### PAR-03 — Moyen à l’ouverture · Allocation anonyme par intention OAuth retirée en source

**Frontière et résultat.** Lorsque OAuth et son Studio sont configurés et joignables, un démarrage sans clé pour un client public enregistré réserve une place avant toute approbation. Dès saturation du plafond commun au client ou à l’objet OAuth, un autre utilisateur légitime ne peut plus commencer son consentement tant que les places ne sont pas libérées. Disponibilité du démarrage OAuth seulement, pas accès aux comptes, arrêt global ni contournement de PKCE. Exposition effective derrière Access/WAF non vérifiée.

**Preuve historique.** `src/oauth.ts` SHA-256 `ac6d62183dff08e77bba73d6281517e906031f5ffb5f992b3ee14596cf058cb2` (`:28–30,79–121,170–179`), et `src/oauth/store.ts` SHA-256 `3f446a3566dad0addb96acad16d60e61761921aadbb3aea28d3cb990e5316239` (`:60–79`) : allocation de pending à durée bornée, avant clé, dans le quota commun de l’objet et du client. L’usage d’un jeton actif n’en dépendait pas.

**Delta du writer relu.** Le démarrage crée un handle et un cookie scellé, mais aucune ligne par intention anonyme. Le sceau AES-GCM lie l’intention courte à l’émetteur, à la ressource et au handle du navigateur ; une seule écriture de clé par époque, aucune création de clé à la lecture (`src/oauth.ts:172–189`, `src/oauth/intents.ts:16–19,39–87`, `src/oauth/store.ts`, `intentKey`). La décision exige une clé gérée valide ; reçu transactionnel, quotas par utilisateur/compte/global et marqueur conservé contre le rejeu jusqu’à expiration (`src/oauth.ts:192–240`, `src/oauth/store.ts`, `admit`, `decide`, `issueCode`, `issueToken`). Le défaut initial est levé, sans garantie contre la saturation volumétrique. **Témoin du lot OAuth/Privacy : 14/14**, dont 9 OAuth, et passage de deux écritures à zéro pour deux démarrages après initialisation du trousseau, avec tests de cookie, rejeu, rotation et redémarrage (`docs/POLICIES.md:50`, `tests/oauth.test.mjs:156–254`). Pas de SHA du bundle dans ce reçu ; pas de recette navigateur ni de déploiement attestés.

### PAR-04 — Moyen à l’ouverture · Préconditions WebDAV transmises par le Worker corrigé

**Frontière et résultat.** Une mutation DAV par un utilisateur déjà autorisé doit refuser une précondition périmée ou un verrou non pris en charge. La façade écarte ces signaux : une mutation ordinaire peut alors passer et écraser une version plus récente, alors que le client avait explicitement demandé un refus. C’est une atteinte à l’intégrité dans une ressource partagée éditable, pas une élévation de privilège.

**Preuve historique.** Sur le `src/worker.ts` SHA-256 `6a196ead704e1550164afa117098bf8bcb5fcc7e91aba1aee60538265077dd83`, `route` ne complète la liste d’en-têtes que pour Gateway et MCP (`:197–218`). La liste générale garde `If-Match` et `If-None-Match` mais pas les conditions de date, ni `If`/`Lock-Token` (`src/auth.ts:128–135`). Le code DAV sait les contrôler/refuser (`src/archives/webdav.ts:51–63,75–96,139–162`), mais recevait la requête déjà filtrée.

**Delta intégré relu.** Le Worker choisit les en-têtes supplémentaires uniquement sur une route DAV, avec le même prédicat que l’adaptateur ; les clés et les en-têtes d’identité restent exclus (`src/worker.ts:199–220`, `src/archives.ts:10–16,24–29`, `src/auth.ts:128–135`). Les conditions de date atteignent le contrôle et les deux conditions de verrou sont refusées avant mutation. La présence de la liste seule dans `archives.ts` ne suffisait pas à 16:32:58 ; le raccord effectif dans `worker.ts`, constaté à 16:33:39, reste présent dans l’entrée avec Schedule et SSE. `tests/archives/dav-preconditions.test.mjs:25–74` contient les refus, la comparaison des octets et la voie positive. Reçu workerd du lot ci-dessous, sans l’assimiler au dernier bundle intégré.

### PAR-05 — Faible à l’ouverture · Métadonnées de révision filtrées en source

**Frontière et résultat.** Un membre qui lit un fichier partagé peut apprendre l’identité et l’heure du HEAD sélectionné, même si cette révision porte sur d’autres fichiers dont l’ACL lui refuse la lecture. Pas de fuite des octets, noms, message ou auteur des fichiers cachés établie par ce chemin ; il révèle une activité et un identifiant d’historique dans le même compte.

**Preuve historique.** Politique : masquer la métadonnée d’une révision dont une partie des changements est illisible (`docs/ARCHIVES.md:28–40`). Avant correction, `history` filtre, mais `show` et `diff` exposent les attributs de révision avec un contrôle limité au fichier demandé (`src/archives/snapshot.ts` SHA-256 `2add3414f29689778dd3f8de54bb14fb70ef37fddaedc7cd81ea9da727345164`, `:125–150,161–208,230–265`). Un fichier lisible peut rester dans le HEAD autrement invisible.

**Delta du writer relu.** `canReadRevisionMetadata` autorise séparément les révisions ; `show` et `diff` préservent le blob autorisé sans OID/heure de révision filtrée. Le filtre s’applique aussi aux liens parents de `log`/`versions` et aux champs des reçus de restauration (`src/archives/snapshot.ts:161–211,233–299`, `src/archives/snapshot-store.ts:64–67`, `src/archives/restore.ts:52–77,137–155`). Ce delta ne promet pas d’indistinguabilité des erreurs de résolution de ref. Les assertions du témoin `tests/archives/metadata.test.mjs` conservent la lecture autorisée, contrôlent les champs masqués et vérifient que l’admin les voit toujours.

## Frontières examinées et limites

| Frontière | Ce que montre le code relu, pas une recette runtime |
| --- | --- |
| Worker → Control → SQLite | Clés en entrée résolues en rôle et triplet ; pas d’autorité dérivée des en-têtes d’identité. Workspace choisi par le compte authentifié, root exclu du plan de données. Mutations Control avec revérification dans la transaction, clés gérées conservées par digest, révocation par registre et réservation des IDs (`src/auth.ts:63–125`, `src/worker.ts`, `workspace`, `route`, `workspaceContext` ; `src/control.ts:96–114,171–200,311–330`, `src/control/registry.ts:122–152,212–246`). Le filesystem refuse explicitement les montes d’un autre utilisateur et les sessions portent le triplet, pas seulement l’ID de session (`src/fs/contract.ts:132–174`, `src/session/flight.ts:6–13`). |
| OAuth → appels délégués | Émetteur et redirections exacts, nonce navigateur, PKCE S256, codes consommés en transaction et clé gérée active revérifiée ; liste explicite lecture/grep/glob et rôle data ramené à `user`, pas de provider sémantique, administration, jobs, MCP ou Gateway via ce grant (`src/oauth/protocol.ts`, `configuration`, `intent`, `pkceMatches` ; `src/oauth.ts:46–57,132–139,192–240` ; `src/worker.ts`, `delegated`, `workspaceContext`). Capacité de consentement : PAR-03 corrigé. Réception du Studio OAuth et du cookie réel non vérifiée. |
| Archives → ACL / index | Lecture des octets historiques partagés liée au fichier courant, aux droits historiques et à son incarnation, avec exemption admin de compte ; métadonnées distinctes (PAR-05). OVPack : staging par triplet, limites sur le ZIP et sa sortie, pas d’extraction sur disque ; commit/restore clôturés par contrôle de révision et transaction (`src/archives/snapshot.ts:41–49,142–158`, `src/fs/subtree.ts:93–113,212–270`, `src/archives/pack.ts:30–66,87–137`, `src/archives/zip.ts:44–123`, `src/archives/restore.ts:140–147`). DAV réutilise le filesystem ; PAR-01 et PAR-04. |
| Audit / jobs / alarmes | Audit Workspace : routes normalisées, pas de corps ni de query, filtrage par compte et, pour un membre, par utilisateur ; `/metrics` demande admin du compte. Télémétrie locale à rétention bornée, pas un journal inviolable ou exhaustif de Control/OAuth : ces branches sortent avant l’audit Workspace (`src/observability.ts:27–66,89–101,156–189,213–241`, `src/worker.ts`, `route` et `Workspace.dispatch`). Les jobs sont scopés par triplet, consommateur fixe, clé et rôle revérifiés à l’alarme, payload/digest retirés à la terminaison (`src/tasks.ts:57–72,101–119,185–248,322–337`, `src/worker.ts`, `consumers` et `Workspace.alarm`). Exercice des alarmes, reprises et interruptions non fait ici. |
| Watches / sorties texte | Allowlist exacte HTTPS du déploiement, pas de crédentiels transférés, redirection demandée en mode manuel, MIME/UTF-8/taille bornés ; repli de code vers `fetch` sans binding `TEXT_SOURCE` (`src/watches.ts:20–54`). Ni choix d’hôte arbitraire par l’appelant ni suivi explicite de `Location` observés ; DNS et comportement d’un binding/réseau réel hors preuve. Retrait de groupe en vol corrigé : PAR-02. Conversion documentaire opt-in, types et quotas bornés avant la liaison. Le parent rapporte un import PDF validé **à part** avec `toMarkdown` factice ; ni conversion réelle ni politique fournisseur attestée (`src/worker.ts`, `workspaceContext` ; `src/documents.ts:8–15,23–56`, `tests/filesystem.test.mjs`, cas « opt-in conversion »). |
| MCP → filesystem | `/mcp` derrière auth/origine ; transport stateless, notifications sans effet, mutations d’outils seulement en `read-write`, registre de cibles locales et invocation de catalogue lecture seule. Les appels remontent aux contrôles du filesystem, dont le garde revu en PAR-01. Le résolveur de manifestes ajouté est une analyse locale bornée, sans résolution d’include ni appel à Git ; préflight refusé (`src/mcp.ts:12–20`, `src/mcp/transport.ts:44–104`, `src/mcp/registry.ts:33–61,145–164`, `src/mcp/tools.ts:29–42,236–279`, `src/mcp/common.ts:24–56`, `src/mcp/assets.ts:55–76,102–124`, `src/mcp/manifest.ts:70–120`). Les textes retournés restent des données non fiables pour les clients MCP ; l’opt-in serveur ne remplace pas leur confirmation des écritures sensibles. |
| Gateway → modèle et capture | Le module, d’abord non monté, est raccordé sur l’empreinte Worker retenue (`src/worker.ts`, `route`, `Workspace.initialize`, `Workspace.dispatchScoped`). Administration mutante limitée à admin du compte, refus des URL/clés d’egress client, liaison et modèles allowlistés, outils refusés. Profil/rappel/capture désactivés par défaut ; rappel revalidé via ACL/révisions et session de capture par triplet (`src/gateway.ts:42–47,85–147,167–222,230–259`, `src/gateway/providers.ts:28–41,65–119`, `src/gateway/profiles.ts:9–22,93–111`, `src/gateway/wire.ts:51–97`, `src/gateway/recall.ts:43–61,110–124`, `src/gateway/store.ts:98–113,141–155`, `src/gateway/capture.ts:32–47`). Le garde tardif est conservé sur timeout sur la seconde lecture de `providers.ts:134–168`, contrairement à la première version ; ne pas compter ce delta comme défaut ouvert. L’annulation effective d’un appel fournisseur déjà parti et l’effacement de sessions capturées ne sont pas attestés par la suppression d’état/logs Gateway (`src/gateway/store.ts:212–219`). |
| Artefact / Cloudflare | Config versionnée : `workers_dev` et previews désactivés, sourcemaps non téléversées, Worker devant les assets, DO déclarés et migrations SQLite (`wrangler.jsonc:4–19`). En-têtes et téléchargement inerte relus en source (`src/worker.ts`, `finish` et `studio`). Ni artefact Studio courant ni réglages WAF/Access/TLS, politique fournisseur, routes de compte, secrets ou config privée vérifiés. Le lock racine résout workerd `1.20261119.1` et Wrangler `4.166.0` (`package-lock.json:2045–2046,2066–2085`) ; ce ne sont pas des versions d’exécution attestées. |

## Passe ciblée du delta Schedule / SSE et frontière anonyme

- **Requêtes anonymes et inspection de données.** Avant auth : redirection, assets Studio, sondes minimales `/health`/`/ready`, protocole OAuth à contrôles dédiés. `/health` ne renvoie compte/utilisateur/rôle qu’après authentification ; `/ready` n’émet que des états de capacité, même si la sonde peut initialiser un DO. Les routes de données, tâches, métriques, MCP et Gateway passent par validation de clé/portée puis `requireDataGrant` (`src/worker.ts`, `ready`, `route`, `Workspace.dispatchScoped` ; `src/auth.ts:110–122`). Consistency/vector count/scroll interrogent la vue ACL du filesystem ; scroll ne retourne pas les vecteurs ou le texte, et le curseur ne remplace pas le filtrage (`src/storage-inspection.ts:10–29,32–62`). `tests/runtime-parity.test.mjs:87–104` contient les contrôles admin/membre ; ajouter la matrice sans clé et à grant OAuth sur le bundle final. Inventaire des assets publics réellement empaquetés non attesté.
- **Audit et file.** `/metrics` est réservé à l’admin du compte et n’émet que des agrégats ; audit/console appliquent les ensembles compte ou compte-utilisateur, les tâches le triplet (`src/observability.ts:89–101,156–189,213–241`, `src/tasks.ts`, `taskFor`, `jobAccess`, `routeTasks`, `jobCounts`). Le journal Workspace décrit l’admission HTTP, pas la réussite à la fin d’un SSE ; le journal Gateway reporte sa ligne à la fin du flux, avec indicateur d’erreur distinct du statut HTTP (`src/worker.ts`, `Workspace.dispatch` ; `src/gateway.ts`, `modelRoute`, `routeGateway` ; `src/gateway/stream.ts`, `finish`). Vérifier la corrélation et l’isolation des reçus ; ne pas prendre `200` seul pour une publication réussie.
- **Planification Compile.** Le digest géré vient du Worker ; l’alarme reconstruit l’identité et réautorise, vérifie la révision et les ACL avant admission. Avance du créneau et création du job passent dans la transaction d’admission ; à l’exécution, garde de job, de créneau et de révision, avec contexte d’autorité hérité plutôt que copié (`src/worker.ts`, `Workspace.alarm` ; `src/compile.ts:67–105,107–147,284–304`, `src/compile/schedule.ts:114–143`, `src/compile/artifacts.ts:66–77`). Reprise à froid, chevauchement/retard de jobs, retrait de groupe et non-publication après annulation doivent être exercés sur **le delta monté** ; les cas de `tests/compile.test.mjs:350,384` ne prouvent pas leur résultat par leur seule présence.
- **Flux Gateway SSE.** Accès authentifié, pas de flux opérateur arbitraire ni de paramètres d’egress client. Source limitée en durée, octets et frames ; données resérialisées en JSON SSE, fin sans marqueur valide incapable de déclencher un succès ou une capture. Le garde de rappel (ACL/révisions), l’époque de configuration et le créneau suivent le flux ; réautorisation forcée à l’ouverture et à la publication, périodique entre les deux (`src/gateway.ts`, `modelRoute` ; `src/gateway/stream.ts`, `streamTurn` ; `src/gateway/sse-source.ts:27–77,84–138`, `src/gateway/sse-wire.ts`, `sseWire` ; `src/generation.ts:63–110`). **Fraîcheur à trancher :** le contrôle Control entre deltas réutilise la dernière vue pendant environ une seconde ; ne pas promettre de révocation instantanée d’un flux admis. Si cette garantie est requise, réautoriser juste avant l’émission. Vérifier retrait de groupe/clé, annulation avant écriture et annulation après publication durable séparément. Les cas d’erreur/coupure/config apparaissent dans `tests/gateway.test.mjs:349,399,429` ; aucun résultat de ce delta n’est déduit de l’ancien lot JSON Gateway.

**PAR-06 — À valider, disponibilité SSE (pas de sévérité attribuée à ce stade).** Le relais d’annulation transmet au DO par RPC privé un identifiant créé par le Worker, après authentification, pas un identifiant librement choisi par le client (`src/worker.ts`, `route`, `fetch`, `Workspace.cancelGateway`). Dans l’état relu, une annulation sans inscription active alimente néanmoins une réserve commune au Durable du compte, et son débordement bloque l’admission de tout nouveau SSE de ce compte, pas seulement celle du principal à l’origine des annulations (`src/gateway/stream.ts:11–41`). Le refus partagé est établi en source ; la possibilité pour un membre ordinaire d’atteindre cet état depuis HTTP dépend du signal d’abandon et de l’ordre des événements au runtime. Aucun effet intercompte ou anonyme établi. **Correctif minimal :** lier la notification à une admission authentifiée et bornée par utilisateur, et empêcher le débordement des marqueurs de bloquer les autres utilisateurs. Valider avec un petit registre factice à capacité réduite, puis un seul abandon de transport sur deux identités synthétiques en workerd confiné ; pas de charge réelle.

**Responses, branche apparue en fin de lecture.** Le stockage est opt-in ; lecture, suppression et continuation sur triplet authentifié, même liaison/modèle/règle, avec contrôle de présence de l’objet avant nouvelle publication (`src/gateway.ts`, `modelRoute` ; `src/gateway/wire.ts:87–95`, `src/gateway/responses.ts:7–18,24–57,60–83`). Les messages stockés passent avant l’ajout du rappel ; le texte généré peut néanmoins refléter des sources alors autorisées. L’expiration de lecture ne prouve pas l’effacement physique : le code nettoie lors d’une nouvelle écriture. Inclure isolation et suppression en cours de continuation, ainsi que rétention réelle, dans la recette intégrée. Témoins présents (`tests/gateway.test.mjs:482,527`), non exécutés ici.

## Preuves de tests et validation finale à organiser

- **Reçus ciblés du lot Archives, non rejoués :** `docs/ARCHIVES.md:158–188` annonce **11/11** sur `d3976d5766f7692d77f958d2e52591dbd64869adf7ffe4cc7723d55629c2e926`, puis **12/12** après montage et ajout du refus backup/restore global sur `7038d9f9ec83b7c7208645c68b1d4adc644e401918813e2b2df30123de42cac8`. Node 26.10.0/workerd 2026-11-19, SQLite jetable. Pour PAR-04, lecture `200 → 304`, mutation périmée `204 → 412`, conditions de verrou `204 → 501`, octets inchangés, témoin curl sur socket Unix ; pour PAR-05, champs de révision omis et contenu autorisé conservé. `tests/archives/receipt.mjs:6–8` associe le bundle au harnais. Les runs ne s’additionnent pas. Le TypeScript vert initial et l’erreur SSE ultérieure mentionnée par ce lot ne constituent ni vert ni rouge sur un nouveau build Schedule/SSE.
- **Autres résultats attribués, non rejoués.** Le lot MCP rapporte 52/52 sur son rejeu conjoint MCP/Filesystem/Worker, dont le garde de suppression récursive (`docs/MCP.md:34`) ; Control rapporte 12/12 (`docs/CONTROL.md:48–52`) et Archives 32/32 sur une version antérieure de ses suites (`docs/ARCHIVES.md:134–141`). Le dernier rejeu strict amont communiqué sur les instances locales du parent annonce **41/43**, un succès pytest refusé par l’oracle strict et un échec pytest autour du `task_id` du commit ; les anciens `502` ne sont plus observés sur ce rejeu. Le binaire exact et le SHA du bundle ne sont pas attestés (`docs/ORIGINAL-REPLAY.md:1–18`). C’est une preuve de parité attribuée au rejeu, pas un verdict de sécurité du candidat courant.
- **Schedule : 13/13 et TypeScript vert rapportés par le lot Compile** (`docs/COMPILE.md:50`) : alarme après redémarrage, idempotence, annulation et retraits de droits/clé. Pas de SHA de bundle dans ce reçu. Le **7/7** de `docs/GATEWAY.md:51` est antérieur aux flux SSE ; ne pas le compter comme témoin de la déconnexion au bord ou de PAR-06. Aucun de ces tests n’a été rejoué par l’auditeur.

**Condition de levée du blocage :** le parent gèle les corrections critiques/élevées, fournit SHA-256 du bundle et des sources/tests/lock/config publics, versions effectivement exécutées, périmètre des assertions, résultats frais et provenance. QA sur le Worker monté avec les DO SQLite, deux comptes et plusieurs rôles/agents fictifs, bindings simulés, réseau externe bloqué, environnement vide, sources/outils en lecture seule, écritures jetables et CPU/RAM/processus/durée bornés. Pas de navigateur ni d’instance parent utilisés par l’auditeur. Priorité aux refus ACL et aux cas positifs API/DAV/MCP ; suites à conserver en second passage :

1. **Identité/ACL** : indices d’identité ignorés, root isolé, rotation/révocation de clé, perte de groupe avant publication ; annuler tout lot après un refus et vérifier l’état du FS, de l’index et de l’ACL. Revoir séparément le rafraîchissement après lecture du corps des mutations courtes (`src/filesystem.ts:98–120`, `src/acl.ts:216–233`) : ne pas présumer une révocation atomique entre deux DO, ni l’étendre aux chemins synchrones sans attente.
2. **OAuth, jobs et watches** : consentement/expiration/usage unique/portée ; annulation et reprise après arrêt autour de la publication et du reçu ; aucun import après retrait du groupe, changement/rotation de la clé ou suppression du watch. Avec binding factice, vérifier le refus de redirection et l’absence de transfert de credentials ; mesurer la politique de débit hors tests de charge.
3. **Archives, audit, MCP et Gateway** : pas de blob ou de métadonnée interdite, échec DAV sans changement d’octets, scope `/metrics` et filtrage des journaux ; mêmes cibles et limites pour MCP, aucun outil sur notification ni en lecture seule si mutateur. Pour Gateway, refus des overrides d’egress, absence de données d’un autre utilisateur dans rappel/capture, ACL/config modifiées pendant un appel, arrêt avant effet tardif et distinction entre purge des logs localement et archives de sessions.

Après réception, contre-lire le delta et attribuer les preuves reçues sans les revendiquer ; garder séparés source, runtime workerd local avec fixtures et Cloudflare distant. Ne pas accorder de feu vert sur une trace d’un autre build ni sans nouvelle validation des constats bloquants.

## Empreintes SHA-256 de la relecture

Empreintes relevées entre **16:23:10 et 16:45:51 UTC** sur les fichiers cités ou sur les témoins référencés. Toutes les entrées du manifeste ont été revérifiées à **16:46:42 UTC** sans écart, y compris l’ancien audit. Ce contrôle fixe les octets de la passe, pas l’arbre de travail en cours d’intégration. L’empreinte d’un fichier de test n’identifie pas le Worker exécuté.

```text
c354f433d9bd2b698fc324e9bfcf88cada37071bbcacd6bc8b09860f45155692  src/worker.ts
43d007aaf10c285979a97c6fbf1db3141443250ccad619a675bcba4f6498682b  src/auth.ts
5e0e2faad5bef2262c22bc7817ca001fce1abb4059eb8a9ec116cc3f00915af4  src/control.ts
05a7f2ac82cde2d82852fee07dd1676423dc5c15bd4e9f4b3017f6ad01698fa4  src/control/registry.ts
ab07e57a9d904130d2d91c01304ba83254445f216a51788e9d4a2baa92ba16f4  src/acl.ts
d36f88f0e8a1dae53c32bb3b3c0351aaef50130d453bb15ab4a33171257056fd  src/oauth.ts
7150757de5ad2c91f40027714f1b5ff2e44061e35cc24b4b984cea72f6291942  src/oauth/intents.ts
0917d7567e8cd4a6dce435e44fa42dfca0a5006fe99c32205e10875f1251adf9  src/oauth/protocol.ts
642f5cd7246e09b355a4309376141cd0f79fde8f87c2ad76d15283faa31fa391  src/oauth/store.ts
260a9e2b96ed5efd80af781f2e51d3a536ccad5e4e295033eddb96b3e5eefc36  src/filesystem.ts
2c754236a72ea4a61a2345c12f111bd744d77e6157242639e9c82992c67eafdd  src/fs/contract.ts
b4329495893368b99ee7983da6796531935a09d1885f5d0da8398848d7928799  src/fs/store.ts
97a0d247d9c6e2c19db7cc064782b6f50f53c31b02bd6edb26f0f03546d410f2  src/fs/subtree.ts
0088e0e2e2486b0b8916dd77f195f339f8a2f83c102711f4c269b0f103ecd7c8  src/session/flight.ts
9921dd5c5d32bc3b21fb147e5fcb6aae5f6f20e04f51e8848dba409e6ee58695  src/archives.ts
5e3e216e54317a10be12dd12408a82959c6b029f52612e82141274237e98bbe3  src/archives/snapshot.ts
facaa30e2b63a55970f6a52d748d5b7ad40774b2015cc8f472607fa58a710aad  src/archives/snapshot-store.ts
bc82fb5154f5fc29a7ab7abd95c9c287b71e9b55e8d995eae460cce6a813c6c2  src/archives/restore.ts
a275710fb4240cf85d673ef03338cb976e9dd32179aeed8b94fce02e995d8b32  src/archives/pack.ts
3665354d750719c0d2d4e6d3463434f984ed101535c818fcdce7df5d9cc8c5d3  src/archives/webdav.ts
915111f91eeb77c8d52bec856c559032ebde9e110b72660d2e593980a4072e11  src/archives/zip.ts
b5d62c0f97da921642b50fce165b3fc0742c631005f982b4d54b482f92c69ae3  src/tasks.ts
4f50163ca35775dd8fd260569e11b4b5d639d6b91691af7b7411e6f26941022d  src/watches.ts
b951b91bfa728bedc6fc147bd678b7afb193bcefa90cc75b6fb292265b1e4cff  src/observability.ts
4ea4f38605379c6d602189081f8968216d38b334550e5265e577a7d21457e0fc  src/documents.ts
e30166a4be0cece60e597d6f2151a3e1c862ad8c27cb1d15be4745ab94b50859  src/mcp.ts
736d51bf84747f09f05bb5d0dfc1bf4282e9f291a5d749d239d6223001009e03  src/mcp/common.ts
b6bcdd47df59acd878cd4071c78f7e9d85b8766d0e5e4c90fa92f3c230eaa93e  src/mcp/transport.ts
9774a4bf2c9498b6dffa689a327e7768ee522ea45a51fb089c1b4366faaba8e5  src/mcp/registry.ts
5cad8b289bccbaff5a42cb62f14971b7dc1733021e13754d39036c80194e7e33  src/mcp/tools.ts
802b8e7b1c015e0c05501102617530fa3591b2cabd559941a302775052a17732  src/mcp/assets.ts
94b772a91e51c239e8bd7adc0ef7ce4f4db690e9a34403d998e113ffcc467bbf  src/mcp/manifest.ts
3d611aee8d4d61ca56b19854dbb817c503c7ab1af38309c5223e32fa9b439e45  src/gateway.ts
8e53a916cebc587acab4d2ebc843c71dfb755c466745483544052d50ecdf14d2  src/gateway/providers.ts
d069f3505395c7ab4768a9596cd342d41ef01bb7dffe5869dcb01dd967995932  src/gateway/profiles.ts
dc054a69a227a9ebbcb641f3298a2784ef729d68ff658848111a396eccbe5438  src/gateway/wire.ts
fe62c0e7e9a011923b013fffd63542f88616db134387ab1741fff6e6e076251c  src/gateway/recall.ts
0eb9df12e443538c95e2876c618ac180f57f1f89290c2550ab1f6e5c56734621  src/gateway/store.ts
7739c4210f435ad76e5fffefb7f503e7b3d90cde88cbd0f58e0443a40a7bec90  src/gateway/capture.ts
c4e181ad471b7998740d0ef0c0ff9d14bbf099ed1f8647cd7cb3290b4e44364b  src/gateway/responses.ts
aca3b8046a2726cdb84d846d1815f855c7afff9bb82af6828e3e09ba69132598  src/gateway/stream.ts
d2aedf3f6f0d710e48fd2579b689e74ce5405f3cb22d12094bc8974352917ac5  src/gateway/sse-source.ts
0c02d916fb90b12095a72d991eea9088eb594ad19289fd4c82f8e325ac00541d  src/gateway/sse-wire.ts
42382008bb1c53540df1ff6b5a1839a91b448cf354088d58eb40b160c3e0488a  src/generation.ts
24b84f2c561ad98d38d588053317cd73d539960ba86e393956ba7e7a02882e29  src/context.ts
a4e2c8a9c99402792c6be346431428b00a2af644cb7a0b9aa8e3d6618d11a9ec  src/compile.ts
2c0840227e8dd41ecaaed43e79bb8609ef9c34b7c464fee2ccfe5e6908c4f153  src/compile/schedule.ts
d5599413f8188793068df253b7676a1010df814818e86832da275df364537a7d  src/compile/artifacts.ts
1a7332b0634394af8ad374ba9227560dc1d6e02f6bc45721e99551a3aa743261  src/storage-inspection.ts
ed246ae54d01cf161055697ec244f39e96a7900e3d6f42609cf0842bbefae1e6  tests/filesystem.test.mjs
0a7bcf955fb7db3c48ba63b53a3005c979401ac051fbaee0aae56fe38fd9e03d  tests/archives.test.mjs
a7b3703903c6c908fdb17f18061e039a58450dff7e4dcb6703d0885167d36cbd  tests/archives/dav-preconditions.test.mjs
064190e3bf22b9ab2282b3a7ec9ed80b02f6a4d072f4e9e4f38983cd202aee22  tests/archives/metadata.test.mjs
ef2f2fd9babc52e3b16ee5bca116de3d22de62e251fd615af9bac94ee88dff82  tests/archives/receipt.mjs
ac80dc12cad0c7ead3aa6fae4b857c6bbe9117dba348d7e52a11812587be525a  tests/oauth.test.mjs
7655b33d699a2b668ebc0ac8c20c24526fc65b82a6a203848e29d2d5d62b2e7f  tests/watches.test.mjs
06c781f557324574047caf14eda2892fc6fd100f7dc4b3d07fb25b8587bb9c08  tests/gateway.test.mjs
7cbbf855e5b6fe4df0838f590c8d864f06674876ced73972797cb9c8fc7cae75  tests/mcp.test.mjs
3e2992df24b35aff23ed58673c921626e91da475aeac9336f32530005622de1a  tests/runtime-parity.test.mjs
08252705053aa44ee8d27de20d43409dc899f4a115397adaf5b5924aa91e9258  tests/compile.test.mjs
04d92d9a540ac204c12461bddc8b6947bed8588059c2ecb19b9152eda1f1da1f  tests/archives/backup-scope.test.mjs
0e37ebf4762c4978f8dce641d368dbf173714cee8069a106d7d98ef077471ea9  docs/ARCHIVES.md
0170646ae6c00d723e56af3a45009105d2443f1af315fabfc853a2ef948d98cf  docs/GATEWAY.md
c8e709a3d92d1f1c0d3a4992219b0b2145f4899af671ee1c3d2e24854d363e49  docs/COMPILE.md
9f4f109b1a932ebe025cbce25a0406c8b9f0056ee32d17e1547bdc0888d930e6  docs/FILESYSTEM.md
ca79cd743dca7b1cf33535ed4cb82591726ec45abdcb18e69ed960cbe6c8899b  docs/POLICIES.md
feab707d98157dcf42a8aa6ae1186c13de91939aee0ba3aa58fc8ed7378d998d  docs/MCP.md
c579f04a67bb7eca7e038460cbf1666bd19086e346e98278bf69cfc0a32b1afe  docs/CONTROL.md
b4c1950e2a77698f7379c1291fa4171f340f9a3ea28beb595ab213150965d574  docs/ORIGINAL-REPLAY.md
f7ae8aa4c2377d292ca5b246bd30825178a03d274fbb4f3cbea0795e36f755aa  docs/SECURITY-REVIEW.md
d732121f4f3d78879545936323b30fbad3fcf89df15fb6dadf7386f8d240bdc0  package.json
ad1994c9b1569a8f2a1074f73545dafdf4de0b51d3cc44240dce2867c13e5dcf  package-lock.json
d1c9b49e0fcd2c778b58e66baf0c546b43eb0b27774cda7e76188bd81e4b6d8b  wrangler.jsonc
```
