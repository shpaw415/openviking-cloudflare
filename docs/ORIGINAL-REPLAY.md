# Rejeu strict de la suite HTTP OpenViking

[Liste des nœuds, attendus et blocages, scellée avant admission](../.work/original/COHORTE-HTTP-SUIVANTE.md). Les Workers historiques 8809 (HTTP) et 8816 (CLI) n’ont pas été sollicités par cette nouvelle cohorte.

Référence **`000f0765d7ec183886fbabbc22e69bc289cc429d`**. Instances workerd locales distinctes remises par le parent, avec bindings de test. `/health` a répondu `200`, `healthy: true`, **API `0.1.0-alpha.1`** sur les instances rejouées. Le bundle de 8809 est identifié ci-dessous par le journal de lancement ; l’API de santé n’atteste ni le hash ni la version exacte de l’exécutable workerd. Aucun accès Cloudflare distant.

## Réception 8818 : trois imports d’origine, L0/L1 sans `to`

**3/3 stricts, une exécution, dix requêtes HTTP `200`** (trois téléversements, trois imports, quatre lectures), hors pré-vérification de santé `200`. Worker jetable `127.0.0.1:8818`, bundle avec fixture `bd6f048147618ba2b1e524afc0da8549099e3abb83bc19405e8dc3f2d6d2dc26` attesté dans le [journal `p-295322d2`](../.work/original/logs/strict-8818-launcher.json). Clé Admin de compte déjà fournie, pas de Root ni de création de compte. Aucun autre port sollicité. Le fichier d’origine au pin `000f0765d7ec183886fbabbc22e69bc289cc429d` est sans alerte medium+ ni troncature ; aucun autre fichier de tests n’a été collecté dans ce lot.

| Cas d’origine (`TestStatAbstractOverviewDeep`) | `root_uri` réelle et relue à l’identique | Réponse texte non vide |
|---|---|---|
| `test_abstract_content_consistency` | `viking://resources/abstract_consist_96d31338.md` | L0 : 52 octets |
| `test_overview_content_consistency` | `viking://resources/overview_consist_730e5557.md` | L1 : 110 octets |
| `test_abstract_and_overview_both_available` | `viking://resources/both_avail_01f5f2b8.md` | L0 : 52 octets ; L1 : 110 octets |

Le payload stock des trois imports était exactement `{temp_file_id, wait:true}` **sans `to`** ; les identifiants de transfert ne sont pas journalisés. Aucun contenu préalimenté ni sidecar injecté. Les lectures d’origine utilisent la `root_uri` réellement renvoyée, pas une URI fabriquée par le harnais. L’oracle exige HTTP 200, enveloppe de succès et chaîne non blanche, et consigne la taille et le SHA du texte sans en imprimer le contenu. La génération déterministe ne mesure pas la qualité d’un modèle réel. [Index par nœud, URI et SHA](../.work/original/logs/strict-8818-index.json) · [trace HTTP de l’unique exécution](../.work/original/logs/strict-8818-implicit-levels.jsonl).

`test_abstract_after_reindex` **n’a pas été lancé** : `regenerate:true` dans le client d’origine demande `mode: full`, explicitement refusé ; la branche stock peut sortir tôt sans avoir relu le L0. Les tests locaux de régénération `semantic_and_vectors` sont une preuve distincte, pas un vert pour ce nœud. Les anciens reçus 8817 sont inchangés et aucun score n’est cumulé entre ports ni entre tentatives.

## Historique 8817 : douze nouveaux nœuds

**12/12 stricts**, 22 requêtes de test : 17 `200`, trois `400 INVALID_ARGUMENT` et deux `404 NOT_FOUND` attendus. Ni saut ni nœud manquant. [Index 8817, par nœud et SHA](../.work/original/logs/strict-8817-index.json) ; indépendant des 52/52 HTTP sur 8809 et des 72/72 CLI sur 8816. Seul 8817 a été admis, déclaration du bundle `ab69453299e1a3e8b0adda4b18ff709df0431ae68ec88cb09e1bcb8a706025d0` [journal `p-1354e131`](../.work/original/logs/strict-8817-launcher.json) et API observée `0.1.0-alpha.1`.

| Lot exécuté | Résultat strict |
|---|---|
| L0 et L1 | **2/2** : lecture exacte des sidecars de fixture. Le L0 conditionnel a suivi la première racine effectivement retournée par le `ls` stock, sans tri ni réécriture. Ce lot ne prouve pas la génération automatique lors d’un import sans `to`. |
| Recherche contextuelle | **2/2** : vrai hit sur le corpus synthétique, marqué `cosine_similarity_session` avec la session ; `find` sans session garde `cosine_similarity`. Ne démontre pas la qualité d’un fournisseur réel ni le plan d’intention amont. |
| Snapshots | **2/2** : les corps d’origine du commit implicite et du journal sont seuls collectés depuis leur AST au SHA (fixtures et montage remplacés). Commit de l’Admin du compte sans `paths` ajouté ; le log retourne l’OID et le message du commit effectivement créé. |
| Skills et refus de lecture/entrée | **6/6** : Skill inert enregistré, deux Skills mal formés refusés 400, recherche vide refusée 400 et deux URI absentes refusées 404. Aucun skill exécuté. |

Les deux premiers reçus snapshot sont conservés : trois réponses HTTP conformes mais deux erreurs du **collecteur** dans le corps pytest. Le [témoin hors réseau](../.work/original/logs/strict-8817-carrier-red.log) isole le `NameError` sur les primitives Python ; le collecteur expose maintenant précisément `isinstance`, `str`, `list` et `len`, sans modifier les assertions, imports autorisés ni confinement. Les deux reprises vertes sur fixtures neuves ont les mêmes SHA des corps et les mêmes plans HTTP. Les tentatives ne sont pas additionnées au score. Cas non portables et alerte sur le module amont Skills conservés dans la liste scellée.

**Linux indépendant.** Passes ciblées hors réseau : gateway `None` au lieu du jeton de fixture et configuration bloquée par le chemin absolu `/tmp/new-workspace`. Les deux suites de templates ont expiré en import (124) ; leurs deux corps exacts rejoués isolément sur les vrais YAML au SHA échouent aux assertions textuelles d’origine. Voir [preuves et limites Linux](../.work/original/RESULTATS.md). Aucun vert Worker n’est attribué à Linux.

## Historique 8809 : tâches durables de commit et de batch FS

**43/43** sur la cohorte 8805 à requêtes et assertions inchangées ; énumération, plans de requêtes et empreintes des sources concordent avec 8805. **91 requêtes de test** : 87 `200`, quatre `404` attendus. **3/3** sur trois scénarios batch texte originaux supplémentaires (11 requêtes : dix `200`, un `409 RESOURCE_BUSY` attendu). Aucun saut. [Index SHA des reçus et schémas](../.work/original/logs/strict-8809-index.json). L’empreinte du bundle **`402aeb1a52dc1414c57c250386b7aa6efa4bb346014caafa95421dfb23347260`** est attribuée au [journal de lancement `p-0c56512d`](../.work/original/logs/strict-8809-launcher.json), pas déduite d’un build disque reconstruit. Les [rouges 8805](../.work/original/logs/strict-8809-8805-before.sha256) et [8803](../.work/original/logs/strict-8805-8803-before.sha256) passent leurs contrôles SHA sans réécriture.

**Commit de session.** Les deux appels originaux `{}` sur sessions non vides renvoient `200`, `status: accepted`, `archived: true` et un `task_id` non vide. Deux lectures de `/api/v1/tasks/{task_id}` ont recoupé l’ID, `task_type: session_commit` et la session. Ce contrôle ne leur attribue pas une fin réussie : les originaux suppriment aussitôt leurs sessions ; les lectures après nettoyage ont observé `failed` [sur une passe](../.work/original/logs/strict-8809-commit-task-follow.jsonl) et `pending` [sur la suivante](../.work/original/logs/strict-8809-commit-lifecycle.jsonl). Dans une **sonde séparée**, la même requête `{}` et les mêmes messages, en gardant la session jusqu’à la fin, ont donné une tâche `completed` et `archive_001` relue avec les deux textes exacts ; nettoyage ensuite. Les sondes et les répétitions ne gonflent pas les compteurs d’origine.

**Batch FS asynchrone.** `test_batch_write_api_upserts_files`, `test_batch_write_api_create_overwrites_and_batch_continues` et `test_batch_write_api_missing_append_creates_file` : [reçu final](../.work/original/logs/strict-8809-fs-batch-http-final.jsonl). `wait:false` est celui du code amont. L’import du module entier a dépassé la borne avant collecte ; un collecteur dédié compile **uniquement les trois corps AST d’origine à l’identique**, avec leurs décorateurs, emplacements et empreintes. Aucun fichier amont modifié ; la fixture `client_with_resource` est remplacée par le transport isolé et le `sample.md` d’origine dans des racines jetables. Pas de crédit pour le module entier ou pour les cas binaires et offensifs non lancés.

| Étape batch | Schéma effectivement observé |
|---|---|
| `POST /api/v1/content/batch-write` | Requête `{root_uri: string, operations: {uri: string, content: string, mode: "upsert"\|"create"\|"append"}[], wait: false}`. |
| Acceptation `200`, `status: ok` | Pour les quatre acceptations observées, `result` a exactement `root_uri: string`, `created: string[]`, `updated: string[]`, `unchanged: string[]`, `vector_status: "queued"`, `semantic_status: "skipped"`, `queue_status: null`, `task_id: string` non vide, `warnings: string[]`. |
| Réémission immédiate | `409`, `status: error`, `error.code: "RESOURCE_BUSY"`, `error.message: string` non vide. La même requête est acceptée après `/api/v1/system/wait`. Le [premier reçu](../.work/original/logs/strict-8809-fs-batch-http.jsonl) conserve le `weak_pass` dû au code non reconnu par le comparateur initial. |
| Jusqu’à la fin | Quatre IDs uniques suivis séparément : `GET /api/v1/tasks/{task_id}` → `200`, `task_type: "content_batch_write"`, `status: "completed"`, identité et racine corrélées ; `result` exactement `{root_uri: string, indexed_count: integer, vector_status: "complete"}` avec le nombre attendu par lot. |

Les deux cohortes représentent **102 requêtes d’origine** (97 `200`, quatre `404` attendus et un `409` attendu), hors pré-vérifications, fixture, contrôles de tâche et sondes. L’amont reste propre au SHA de référence ; CI et preuves antérieures inchangées.

### Première extension du même 8809 : admin, Skills, Watches et archive

**6/6 nouveaux tests d’origine**, neuf requêtes (sept `200`, deux `202`), aucun saut. Même Worker monté, pas de nouveau port ni transfert de résultat ancien. [Index indépendant de première exécution](../.work/original/logs/strict-8809-first-surfaces-index.json) ; l’index précédent 43+3 n’a pas été réécrit.

| Lot | Première exécution et limite |
|---|---|
| [Admin fixture](../.work/original/logs/strict-8809-first-admin-fixture.jsonl) — 2/2 | Le test crée lui-même chaque utilisateur synthétique dans `default`. Promotion d’un de ces seuls utilisateurs en `admin`. Les deux `DELETE` d’origine rendent `202`, `status: revoked`, `data_retained: true` : révocation de fixtures, pas de suppression de données ni modification d’une identité existante. |
| [Skills inline](../.work/original/logs/strict-8809-first-skills-inline.jsonl) — 2/2 | Enregistrement du dictionnaire et du descripteur de format MCP dans un compte de fixture distinct, `200`, `result.status: success` ; pas d’exécution d’outil ni de skill. |
| [Watches](../.work/original/logs/strict-8809-first-watches-local.jsonl) — 2/2 | Liste vide exacte, et page vide avec `has_more: false`, `next_cursor: null`, sur identité neuve. Collecteur isolé : seuls les deux corps AST d’origine sont compilés avec leurs signatures et assertions. Aucun watcher distant créé ou déclenché. |
| [Archive historique et OVPack natifs](../.work/original/logs/strict-8809-first-watches-local.jsonl) — **hors score d’origine** | Onze `200`. Deux commits à chemins explicites ; lecture historique de la V1 octet pour octet après écriture de V2. Export ZIP de V2 (1 382 octets), stage des **mêmes octets**, import vers un parent neuf avec `on_conflict: fail` et relecture exacte de V2. Pas de réinjection d’une archive externe, ni écrasement d’un montage existant. |

**Cas conservés, non admis sur 8809.** Les originaux `test_commit_creates_snapshot` et `test_log_returns_recent_commits` utilisent un commit sans `paths`, que ce contrat Worker n’admet pas ; ne pas ajouter `paths` à ces tests pour les déclarer verts. `test_pack_export_import_consistency` ne transmet ni requête export ni requête import : son intitulé ne vaut pas preuve de pack. Le watch de mise à jour demande une source distante autorisée et une fixture dédiée ; aucune connexion de ce type n’a été ouverte. Rotation des clés et suppression de données exclues. Le module d’administration signalé par le filtre de contenu n’a pas été exécuté. Si un changement du Worker ou de ses bindings est nécessaire pour ajouter ces cas, demander un nouveau port et un nouveau SHA plutôt que modifier 8809.

## Historique 8805 : fixture de génération corrigée

**41 réussites strictes sur 43 nœuds d’origine**, 1 échec pytest et 1 succès pytest refusé par le contrôle strict (`weak_pass`). Aucun saut ni résultat manquant. **91 requêtes de test** : 87 `200` et 4 `404` attendus, aucun `502`. Les 32 nœuds et leurs parcours de 8803 ont tous été rejoués sans changer leurs requêtes ni leurs assertions. **Les 11 nouveaux nœuds passent**. [Index SHA des reçus](../.work/original/logs/strict-8805-index.json) ; il atteste les fichiers de preuve, pas le SHA du bundle servi.

| Ajout | Nœuds | Requêtes de test | Reçu |
|---|---:|---:|---|
| Observer queue, VikingDB, système et modèles ; attente système | 5/5 | 5 | [JSONL](../.work/original/logs/strict-8805-observer-wait.jsonl) |
| Contexte : budget 1 000 et statistiques | 2/2 | 8 | [JSONL](../.work/original/logs/strict-8805-context-more.jsonl) |
| Import de fixtures TXT et JSON | 2/2 | 4 | [JSONL](../.work/original/logs/strict-8805-resources-more.jsonl) |
| Déplacement et suppression après attente | 2/2 | 7 | [JSONL](../.work/original/logs/strict-8805-files-more.jsonl) |

**Le 502 est levé, pas le contrat `task_id`.** L’intégrateur a confirmé que l’ancienne fixture de génération renvoyait `{summary,memories}` là où l’extracteur attend le DTO `events`. Avec la fixture corrigée, les deux requêtes originales de commit non vide, `POST .../commit` avec `{}`, répondent `200`, `status: completed`, `archived: true`, **`task_id: null`**. `test_session_commit_flow` accepte nativement ce champ nul, mais notre oracle strict préexistant exige un ID non vide et le classe `weak_pass`. `test_session_commit_returns_task_id` échoue sur sa propre assertion. Le point à trancher est le mode par défaut du commit non vide et le suivi d’une tâche réelle, pas la correction de la fixture ; ni `wait:false` injecté, ni ID fictif. [Rejeu original](../.work/original/logs/strict-8805-commit.jsonl) et [confirmation expurgée](../.work/original/logs/strict-8805-commit-detail.jsonl) sont distincts ; un seul reçu est compté par nœud.

Les rouges de 8803 sont inchangés : [SHA-256 avant/après](../.work/original/logs/strict-8805-8803-before.sha256). Capteur modèles toujours `null` et non sondé ; la santé déclarée et la fixture de génération ne valent pas qualification d’un fournisseur réel. Les 14 pré-vérifications, 8 opérations d’amorçage/révocation, l’observation système et les 6 requêtes de sondes (réglages et archive brute) sont hors du score. Ni navigateur, modification du port, ni Cloudflare distant.

## Historique 8803 : `default` synthétique et génération de test

**30 réussites strictes / 32 nœuds d’origine**, 2 échecs, aucun saut/manquant. **67 requêtes de test** : 62 `200`, 3 `404` attendus et 2 `502` inattendus. Les 10 pré-vérifications, 4 opérations de fixture admin et les sondes complémentaires ne comptent pas dans ce total. Chaque port conserve ses propres reçus ; les scores ne s’additionnent pas.

| Lot | 8803 | Reçu |
|---|---:|---|
| `base` | 7/7 | [JSONL](../.work/original/logs/strict-8803-base.jsonl) |
| `sessions` | 6/6 | [JSONL](../.work/original/logs/strict-8803-sessions.jsonl) |
| `files` | 2/2 | [JSONL](../.work/original/logs/strict-8803-files.jsonl) |
| `resources` | 2/2 | [JSONL](../.work/original/logs/strict-8803-resources.jsonl) |
| `search` | 2/2 | [JSONL](../.work/original/logs/strict-8803-search.jsonl) |
| `read-extra` | 3/3 | [JSONL](../.work/original/logs/strict-8803-read-extra.jsonl) |
| `sessions-append` | 1/1 | [JSONL](../.work/original/logs/strict-8803-sessions-append.jsonl) |
| `admin` | **2/2** | [JSONL](../.work/original/logs/strict-8803-admin.jsonl) : la liste des utilisateurs du `default` littéral répond `200`, assertions inchangées. |
| `context` (nouveau) | 4/4 | [JSONL](../.work/original/logs/strict-8803-final-context.jsonl) : contexte vide, avec messages, budget zéro, session inexistante. |
| `commit` (nouveau) | **1/3** | [JSONL](../.work/original/logs/strict-8803-final-commit.jsonl) : session vide `200` ; `test_session_commit_flow` et `test_session_commit_returns_task_id` reçoivent `502 INVALID_MODEL_OUTPUT` au lieu de `200`. |

Les deux échecs `commit` ont été reproduits ; le code typé est connu, pas la sous-cause exacte (`error_kind: unknown`). La création, les deux messages et la suppression de chaque session ont répondu `200`. Pour lever les rouges, l’intégrateur doit qualifier la sortie de la fixture de génération reçue par le validateur, sans affaiblir le contrat ni substituer une réponse au client amont. Une première [vérification de transport hors réseau](../.work/original/logs/strict-wire-check-commit.jsonl), puis sa [correction](../.work/original/logs/strict-wire-check-commit-transport-fixed.jsonl), restent séparées du `502` effectivement émis par workerd.

**Sondes hors suite d’origine.** La lecture `GET /api/v1/user-settings/add-locations` vérifie les deux objets `override` et `effective`, pas l’écriture du réglage. Le scénario d’archive brute a explicitement désactivé l’extraction, écrit un message de test, relu `archive_001` en état `completed` avec le même texte et un champ SHA-256, puis supprimé la session : cinq requêtes `200`. Cela ne prouve pas l’extraction sémantique, ni un calcul indépendant du hash. [Reçu](../.work/original/logs/strict-8803-final-context.jsonl). Le capteur `models` est de nouveau **inconnu** (`null`) et `probed:false`, même avec le binding de test annoncé.

## Historique 8802 — 21 novembre 2026

**24 réussites strictes / 25 tests d’origine**, 1 échec, 0 saut ou résultat manquant. **41 requêtes de test** : 38 en `200`, deux absences attendues en `404`, un `404` inattendu. Les huit pré-vérifications `/health`, quatre opérations d’amorçage/révocation et la lecture des capteurs sont hors de ce total. La première vague 8802 avait donné 20/21 ; la preuve historique **7/7 sur 8798** n’est pas additionnée. Le [rapport amont](../.work/original/RESULTATS.md) sépare Linux, workerd et limites.

| Lot / identité synthétique | Verdict | Ce qui a réellement répondu | Manifeste, requêtes, écarts |
|---|---:|---|---|
| `base` / User | 7/7 | Santé, statut, racine `stat`/`ls`/`tree` ; `stat` d’une ressource absente : `404 NOT_FOUND`, attendu. | [JSONL](../.work/original/logs/strict-8802-final-base.jsonl) |
| `sessions` / User | 6/6 | Créations avec et sans ID, liste, récupération, ajout d’un message et suppressions. | [JSONL](../.work/original/logs/strict-8802-sessions.jsonl) |
| `files` / Admin de son compte jetable | 2/2 | `mkdir`/`stat`/suppression ; écriture, relecture avec comparaison exacte du texte et suppression. | [JSONL](../.work/original/logs/strict-8802-final-files.jsonl) |
| `resources` / Admin d’un autre compte jetable | 2/2 | Multipart TXT/Markdown puis import via `temp_file_id` ; vérification de l’URI importée et `ls` dans le cas TXT. | [JSONL](../.work/original/logs/strict-8802-final-resources.jsonl) |
| `search` / User | 2/2 | `find` et `search` répondent `200` avec le résultat groupé et contiennent le document partagé *Coastal Navigation* (`viking://resources/navigation.md`). Embeddings de test seulement. | [JSONL](../.work/original/logs/strict-8802-search.jsonl) |
| `read-extra` / User | 3/3 | `grep` et `glob` : `200` et liste `matches` (pas de preuve d’une correspondance non vide) ; téléchargement d’un texte absent : `404 NOT_FOUND` attendu. | [JSONL](../.work/original/logs/strict-8802-read-extra.jsonl) |
| `sessions-append` / User | 1/1 | Deux ajouts successifs donnent 1 puis 2 messages ; la session du test est supprimée. | [JSONL](../.work/original/logs/strict-8802-sessions-append.jsonl) |
| `admin` / Root | 1/2 | Annuaire des comptes non vide en `200`. `test_admin_list_users` demande **littéralement** `GET /api/v1/admin/accounts/default/users` : `404 NOT_FOUND`, attendu `200`. | [JSONL](../.work/original/logs/strict-8802-final-admin.jsonl) |

Pour le rouge admin de 8802, la première lecture des comptes avait également constaté que `default` était absent. Exiger `default` dans la liste globale était une précondition de harnais trop forte, distincte du cas de listing ciblé. [La première passe](../.work/original/logs/strict-8802-admin.jsonl) est conservée ; l’annuaire global exige maintenant une liste non vide et des identifiants valides, tandis que le test ciblé garde la requête et les assertions d’origine. La réussite sur le `default` de 8803 ne réécrit pas ce `404`. Aucun alias vers le compte de démonstration, aucun compte `default` ajouté sur 8802.

**Capteurs, hors score.** `GET /api/v1/observer/system?format=json` en `200`. Le Worker a déclaré sains `queue`, `vikingdb` (nom de l’interface d’observation, pas preuve d’un VikingDB natif Cloudflare), `lock`, `retrieval` et `filesystem`. Santé `models` **inconnue** (`null`) et `models.probed` a été observé `false`. La réussite de la recherche avec la fixture n’est pas un test du fournisseur réel. La ligne `observer` distingue `observed`, `unknown` (présent mais non booléen, y compris `null`) et `absent` (aucun champ). Une réponse non reçue est `absent`, une réponse reçue mais hors contrat `unknown`, avec statut ou faute de transport consignée.

## Intégrité et garde

- Arbre `upstream/` au SHA ci-dessus, `git status --porcelain=v1` vide après essai. Pour chaque lot les blobs des tests, du client et de la configuration importés sont comparés au Git tree épinglé ; `manifest.files` conserve les SHA-256. L’enfant pytest lit la copie en lecture seule. Les tests, données construites par les tests et assertions n’ont pas été édités. Les modules choisis ont été relus comme données après filtrage ; aucun test d’exploitation n’a été exécuté.
- `--noconftest` remplace seulement le bootstrap/transport `api_client` : client amont, origine explicite, clé distante au processus pytest, sans hints d’identité. Le client conserve les URL/méthodes, paramètres et JSON du test ainsi que les octets des fichiers temporaires TXT/Markdown du scratch ; le superviseur relaie le statut et les octets reçus, sans fabriquer de réponse en mode `run`. Les profils `collect`, `wire-check` et `weak-check` ont **zéro HTTP** ; ils ne comptent pas comme preuve Worker.
- Landlock ABI 7 et seccomp : l’enfant pytest ne peut pas ouvrir de socket, écrire la source ou lire la remise ; il utilise deux pipes vers le superviseur. Le superviseur ne peut connecter en TCP que sur **le seul port remis pour la vague** (8802, 8803, 8805 puis 8809), ne peut pas ouvrir d’écoute, et vérifie `127.0.0.1` ainsi que verbe, chemin et paramètres avant transmission. Écoute IPv4 loopback seule contrôlée sur chacun des ports admis ; aucun proxy, DNS, redirection ni autre port essayé. Réponses limitées à 128 Kio, délais 2 s/5 s, lancement borné.
- Les clés synthétiques sont lues uniquement par le superviseur, jamais en arguments, logs ou manifestes. Pour `files` et `resources`, Root a seulement servi à créer deux comptes disjoints, chacun avec une clé Admin éphémère gardée en mémoire puis révoquée (deux `202`, `data_retained:true`). Le Worker conserve les données des comptes révoqués ; cela **n’atteste pas un effacement physique**. Les originaux de création de session ne suppriment pas tous leurs fixtures ; refaire ces cas requiert un espace jetable neuf. Aucun arrêt/redémarrage du Worker parent, aucune modification de `src/` ou `tests/` du port, aucun commit/push/déploiement.

## Lire et relancer la preuve

Les reçus donnent le nœud exact, les étapes attendues/réelles, `pytest_phase`, les statuts HTTP, la version observée et `diff` (champ, attendu, réel expurgé). Pour une réussite stricte, les trois phases pytest doivent être vertes, toutes les requêtes prévues doivent être observées dans le bon ordre et les contrats HTTP/JSON doivent être satisfaits. Un `4xx` générique sur un appel positif n’est pas une réussite. Une absence volontaire exige le `404 NOT_FOUND` exact et une enveloppe d’erreur. Dans le [témoin 403 hors réseau](../.work/original/logs/strict-weak-403.jsonl), `test_list_sessions` est vert pour pytest mais `weak_pass` pour la campagne. [Six contrôles du harnais](../.work/original/logs/strict-harness-unit.log) réussissent.

Depuis `.work/original/`, vérification hors ligne, puis **un seul lot** sur l’instance annoncée et fraîche ; garder un nouveau fichier par tentative et ne pas réutiliser un port ou un stockage non remis par le parent :

```sh
timeout -k 2s 10s env -i PATH=/usr/bin:/bin /usr/bin/python3 -I confine.py offline . \
  python -B strict_worker.py collect sessions

timeout -k 3s 24s env -i PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 \
  ./venv/bin/python -B strict_worker.py run implicit-levels parent-8818
```

Le lanceur courant est **verrouillé sur 8818 et le seul profil `implicit-levels` de `strict_8818.py`**. `parent-8818` désigne cette remise directe, pas une autorisation permanente ; un autre port nécessite une remise fraîche et une mise à jour explicite du garde. Les admissions historiques restent consultables hors ligne, pas relançables sur ce port. Hors lot : autres tests de ces familles, autres scénarios asynchrones et avancés, CLI/SDK distants, ingestion URL/archive externe, tests offensifs, Studio/navigateur et production. Aucun verdict pour ces familles.
