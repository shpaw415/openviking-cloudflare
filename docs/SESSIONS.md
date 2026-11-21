# Sessions OpenViking sur Workers

Référence en lecture seule : OpenViking `000f0765d7ec183886fbabbc22e69bc289cc429d`, routeurs `sessions`, `tasks`, `stats`, protocole `json_protocol.py`, modèle `builtin/events.yaml`, types et consommateurs Web Studio. Les extraits ont été traités comme données avec Prompt Shield ; le routeur des sessions a produit une alerte heuristique élevée. Aucun code amont n'a été exécuté.

## API

Les réponses JSON des sessions utilisent `{status:"ok", result:…}` et l'enveloppe `ApiError` du parent. Les données sont scopées `(compte, utilisateur, agent, session)` depuis `ctx.caller`, y compris pour un administrateur. Le nom dans l'URI ne porte pas l'agent et ne vaut jamais autorisation.

| Route | Comportement |
|---|---|
| `GET/POST /api/v1/sessions` | Liste de la portée, création avec ID explicite ou généré. |
| `GET/DELETE /api/v1/sessions/{id}` | Métadonnées, compteurs actifs/cumulés et usages connus ; `auto_create=true` côté GET ; suppression en cascade de la session et de ses données. |
| `POST …/messages`, `POST …/messages/batch` | Validation complète avant transaction ; création implicite et append atomiques. `parts` prime sur `content`. La rotation conserve les séquences et les messages originaux. |
| `PATCH …/config` | Paramètres persistants `memory_extraction_config.events.tags`; absent ou `null` hérite, `[]` efface. `auto_commit_policy:null` signifie pas d'auto-commit ; les politiques actives ne sont pas portées. |
| `POST …/commit` | Archivage, extraction et/ou récapitulatif selon politique. Par défaut retourne à la fin et sans `task_id`. `wait:false` ou `?wait=false` passe par la file persistante du parent. |
| `GET …/archives/{archive_id}`, `POST …/archives/{archive_id}/retry` | Messages scellés, SHA-256 du JSONL, état réel et mémoires publiées. Reprise par SHA-256 ; synchrone par défaut, option `wait:false` sur la même file. |
| `GET …/context?token_budget=N` | Suffixe actif entier (défaut 128 000 jetons estimés), puis le dernier récapitulatif post-frontière s'il tient ; zéro donne un contenu vide. Pas de rejeu de verbatim d'une archive échouée. |
| `GET …/tool-results`, `GET …/tool-results/{id}`, `GET …/tool-results/{id}/search` | Sorties texte réellement reçues, indexées sous la même transaction que le message. Liste par `tool_name`/`limit`, lecture `offset`/`limit`/`include_metadata`, recherche littérale sensible à la casse par `q` et `context_chars`. Offsets Unicode, pas UTF-16. |
| `GET /api/v1/stats/sessions/{id}` | Tours utilisateur de l'historique et nombre de publications effectives. Les transports d'outils ne sont pas des tours. |
| `GET /api/v1/stats/memories?category=events` | Documents mémoires indexés et lisibles du montage utilisateur courant (toutes catégories connues si omis) ; âge et dates de dernière écriture. L'index ne suit pas les accès : histogramme de popularité et compteurs `not_accessed_*` à `null`, pas à zéro. |
| `GET /api/v1/content/read?uri=…/sessions/{id}/history/{archive_id}/…` | Vues en lecture seule `messages.jsonl` et `memory_diff.json` pour l'historique du Studio ; diff `operations.adds` basé sur des reçus réels. Nécessite `routeSessions` avant `routeFilesystem`. |

Un outil n'est jamais exécuté. Les références d'outil ou d'image du client ne confèrent aucun accès et ne sont pas déréférencées. Les résultats partiels et refs fournies par le client ne sont pas présentés comme sorties complètes ; un ancien message stocké avant l'ajout de l'index reste lisible via l'historique, sans rétro-indexation. Le compteur de génération est la somme des métriques reçues (`unknown_calls` signale les données incomplètes) ; les jetons d'embedding sont inconnus avec ce binding.

## Extraction et récupération

- La politique locale sans type explicite retient **uniquement** les événements du propriétaire. L'opt-out amont `{"memory_policy":{"memory_types":[]}}` reste valide ; `self.enabled:false` désactive aussi l'extraction. Pas d'écriture pour un pair. Ce n'est pas la politique complète d'OpenViking. Un commit sans texte éligible n'appelle pas de modèle. Sans générateur pour un traitement requis, le commit synchrone renvoie `503` avant rotation.
- Un vrai appel `ctx.generate` reçoit des citations de messages texte numérotés, jamais des messages d'instruction système venant du client. Validation fermée du sous-ensemble *create-only* du protocole JSON amont : `events[page_id,event_name,goal,summary,ranges]`. Toute plage se résout dans le préfixe scellé et désigne au moins un message utilisateur. Ni heuristique de substitution, ni exécution du DSL Python, ni URI/édition/suppression/outils choisis par le modèle. Un résultat vide valide ne crée rien ; une réponse hors schéma échoue. La validation structurelle n'atteste pas que le modèle a bien interprété chaque fait.
- Le Worker calcule le chemin privé `viking://~/memories/events/YYYY/MM/DD/<nom>-<suffixe>.md`, et publie par **les routes internes du filesystem** avec le même caller, en mode création et vectorisation. Les citations sont rendues comme texte. Les tags par commit sur `extraction_metadata.event.tags` remplacent les paramètres par défaut pour cet archivage (`[]` les neutralise). Le montage mémoire utilisateur est partagé entre les agents du même utilisateur, selon le contrat FS ; le transcript, les paramètres, les reçus et les archives restent privés à l'agent. Supprimer la conversation ne supprime pas ses mémoires publiées.
- `enable_working_memory:true` ou la politique `working_memory.enabled` génère en plus un **récapitulatif texte cumulatif** ; le résultat est stocké dans `overview`, le plus récent pouvant être assemblé dans `context`. Pas de réponses fabriquées ni de rétention `turn_budget`, de checkpoints outil ou de consolidation des autres types. `reset_context:true` exige `keep_recent_count:0`, scelle une frontière et n'injecte plus les récapitulatifs antérieurs ; les mémoires FS restent intactes.
- Phase 1 : rotation transactionnelle du préfixe et enregistrement de l'option et de l'identifiant de traitement. Phase 2 : génération bornée, validation de tous les documents avant publication, persistance du plan, puis une transaction FS par note avec son reçu SQLite dans la même transaction. Il peut rester des répertoires vides et des publications partielles en cas de défaillance ; seules les notes réellement créées comptent. Un retry reprend les notes sans reçu avec le **même** plan et les tags scellés ; une note déjà publiée, modifiée ou effacée par l'utilisateur n'est pas réécrite. Une archive complète n'est pas rejouée. Une archive échouée bloque un nouveau traitement sémantique de cette session jusqu'à reprise. Un état `pending` dont le propriétaire a expiré demande `allow_ownerless_ready:true`; une annulation réelle enregistrée demande `allow_cancelled_failure:true`.
- En asynchrone, `status:"accepted"` signifie uniquement que `JobAccess` a persisté une tâche exécutable : tant que l'alarme n'a pas scellé, `archived:false` et `archive_uri:null`. Le job contrôle l'ancre du dernier message et les paramètres à l'exécution ; une écriture ou rotation concurrente ne le fait pas traiter une tranche différente. Suivi/annulation via les routes `tasks` du parent. Si `ctx.jobs` est absent, `wait:false` renvoie `501` au lieu d'annoncer une tâche. Une demande vide et purement synchrone n'a pas besoin de tâche.

### Invariants et limites

- Le parent appelle `initSessions(ctx)`, puis `routeSessions(request,url,ctx)`. Pour le job natif, il enregistre `runSessionCommit(payload,ctx)` et reconstruit `ctx` avec le même principal ; il fournit `reauthorize` et `assertActive` pour revalider après I/O et dans la transaction d'écriture. Aucune mise en réseau HTTP interne, aucune API Node dans le Worker. Contrat FS actuel requis : la mutation de `mkdir` et de `content/write` est dans `ctx.storage.transactionSync`. L'adaptateur garde cette transaction et y ajoute le reçu, sans SQL direct sur les tables FS. Si la versionisation change ce contrat, le crochet de reçu doit rester dans la même transaction que le fichier et son index.
- Un bail SQLite unique par session protège la génération, les appends et les rotations. Expiration de 50 secondes, 2 traitements simultanés par utilisateur et 8 par compte, budgets du fournisseur parent en plus. Aucun `await` ne garde une transaction ouverte. Les réponses tardives ne peuvent pas écrire pour un autre propriétaire de bail, même après suppression/recréation. L'annulation ne promet pas d'arrêter un calcul déjà lancé chez le fournisseur.
- IDs ASCII 1–255 caractères (`A–Z a–z 0–9 _ . @ -`, sauf `.`/`..`). Corps création/config/commit 16 Kio, append 512 Kio, 100 entrées/64 parties par entrée, append normalisé 256 messages/1 Mio, 64 Kio par message, profondeur `tool_input` 32. Index d'outils : au plus 128 sorties complètes par append, 100 entrées en liste, 50 occurrences max. Une réponse brute d'archive est bornée par l'historique d'une session. Traitement sémantique : 128 messages texte éligibles / 16 Kio de transcript sérialisé, 4 notes, 24 Kio par note, aperçu de 3 Kio ; un commit trop gros doit garder une plus grande queue active. La sortie du modèle et les calculs restent bornés même si le client demande davantage.

| Portée | Sessions | Messages actifs + archivés | JSONL (UTF-8) |
|---|---:|---:|---:|
| Compte | 2 048 | 40 000 | 32 Mio |
| Utilisateur, tous ses agents | 512 | 12 000 | 12 Mio |
| Session | 1 | 10 000 | 8 Mio |

Les plafonds sont cumulatifs et vérifiés en transaction. La rotation n'économise pas de quota. Ces chiffres ne sont pas des tailles physiques SQLite. Restent hors portage : politiques d'auto-commit et idle scan, modèles mémoire compte/utilisateur personnalisés, extraction multiscope, upsert/consolidation, anonymisation et filtres de confidentialité amont, télémétrie de session et migration/backfill d'historiques externes.

### Rejeu local

```sh
TMPDIR=/tmp/opencode node --test --test-concurrency=1 tests/sessions.test.mjs tests/bot.test.mjs
```

Résultat du 2026-11-21 : **26/26** (18 sessions, 8 bot). Les assertions s'exécutent par HTTP sur `workerd 2026-11-19`, avec un Durable Object SQLite jetable, des identités fictives et des fournisseurs de test. Sont notamment couverts le redémarrage, les quotas et rollbacks, les plages Unicode, la publication vectorisée, la reprise d'un échec partiel sans double création, l'annulation pendant l'indexation et la reprise par l'alarme `session_commit`, ainsi que la boucle avec VikingBot. Aucun test offensif, Cloudflare distant, déploiement, commit ou push. Ce rejeu ne qualifie ni Workers AI distant, ni les suites d'origine, ni l'UI dans un navigateur.
