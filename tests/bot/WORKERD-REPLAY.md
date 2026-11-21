# Reçu workerd : commits par défaut et Agent Evolution

Amont en lecture seule : `000f0765d7ec183886fbabbc22e69bc289cc429d`. Les deux fichiers de l'essai d'origine (`tests/api_test/sessions/test_session_commit_context.py` et `tests/api_test/api/client.py`) sont vérifiés bit à bit par SHA-256. L'adaptateur de test lit les instructions/assertions d'une liste de trois cas en AST borné ; il n'importe, ne compile ni n'exécute le Python d'amont. Il transmet les mêmes requêtes HTTP, notamment `{}` sans `wait`, et soumet les réponses réelles au comparateur. Aucun changement à la fixture DTO du parent.

| Cas | Avant : reçu strict parent 8805 | Après : Worker parent local jetable |
|---|---|---|
| `test_session_commit_flow` | `200 / completed / task_id:null`, `weak_pass` | `200 / accepted / archived:true`, ID non vide, assertion amont satisfaite |
| `test_session_commit_returns_task_id` | `200 / completed / task_id:null`, échec d'assertion | `200 / accepted / archived:true`, ID non vide, assertion amont satisfaite |
| `test_session_commit_empty_session` | Vert | Vert, `skipped`, aucun job |

Le reçu avant reste sous `.work/original/logs/strict-8805-commit-detail.jsonl`. Le rejeu après est ciblé (3 cas), pas une réexécution de la campagne 43 nœuds. Un témoin séparé vérifie que l'archive du commit est immédiatement lisible et que l'ID est celui d'un vrai `session_commit`, suivi jusqu'à `completed`; un échec SQLite injecté en phase 1 ne laisse ni archive ni job. Les tests synchrones du port demandent `wait:true`.

## Raccord et limites vérifiables

- La fermeture et l'admission du job sont atomiques via `JobAccess.onAccepted`. Le payload `op:"sealed"` contient le numéro d'archive, sans transcript : `runSessionCommit` vérifie le vrai propriétaire `ctx.taskId`, ouvre le bail de traitement et publie avec les gardes de réautorisation, d'annulation et `finishJobInTransaction`. Les nouveaux messages ne modifient pas l'archive scellée. Un abandon après l'acceptation ne peut pas écrire sur une session recréée. Une archive terminale échouée n'immobilise pas la suivante, dans la borne de huit archives non terminées. `retry` conserve le hash, les autorisations `allow_ownerless_ready` et `allow_cancelled_failure`, et réserve l'archive avec le job avant exécution. Le rétablissement d'un job possédé est un conflit plutôt qu'un nouveau succès ; pas de déduction `already_covered` sans checkpoint cumulatif probant.
- L'auto-commit par seuil s'appuie sur la vraie file du parent, conserve la queue demandée et revalide sa politique, sa portée et sa rotation avant d'écrire. Les seuils sont stricts (`>`), zéro les désactive. L'IDLE reste explicitement non pris en charge : ni scan global, ni usurpation de l'alarme du parent. Sans `JobAccess`, aucun commit automatique n'est annoncé.
- `initEvolution(sql)` et `routeEvolution(request,url,ctx)` sont montés par le parent. Les trajectoires sont des vues Markdown lisibles par `content/read`, sur des tours natifs ayant remis un extrait d'une réelle Experience vérifiée au binding et dont le message terminal (réponse, sinon entrée) est dans une archive terminée. Compte, utilisateur et agent sont revalidés ; supprimer/recréer un fichier au même chemin ne reprend pas son historique. Ni tags, ni parts client, ni modèle ne peuvent inventer une provenance. Les tours sans avis restent `unknown` et ceux sans réponse `unfinished` ; le dernier avis signé est seul compté comme `success` ou `failure`. Pas de `partial` inféré, ni de consolidation autonome ou de liens vers des expériences générées par l'amont.
- Rétention des observations : 30 jours, dernier feedback par réponse native observée, 128 tours par acteur, 384 par utilisateur et 2 048 par compte ; une saturation ne fait pas évincer un autre acteur ni échouer le chat. La trajectoire et son feedback disparaissent avec la session. Aucun backfill des chats d'avant l'instrumentation. Date de filtre : remise de l'extrait au binding, en UTC. Les observations expirées ne sont plus servies et sont purgées au prochain tour du compte.

## Commandes locales

```sh
npm run check
TMPDIR=/tmp/opencode node --test --test-name-pattern='upstream pinned|original default' tests/sessions.test.mjs
TMPDIR=/tmp/opencode node --test --test-concurrency=1 tests/sessions.test.mjs tests/bot.test.mjs
```

Dernière passe : **37/37**, TypeScript vert. SHA-256 du bundle parent exercé par les trois cas d'origine et le témoin de cycle de vie : `030109a2894db14dcfe22f713dad43cbcd9297edee93b826c7dba6630f252472`. Une passe précédente avait échoué dans le lecteur SSE du harnais (`Body is unusable`) ; la dernière consomme le flux dès son ouverture, comme le client, sans changer les assertions d'interruption.

`workerd 2026-11-19`, vrai Durable Object SQLite et alarme réelle ; modèles fictifs et identités éphémères, aucun compte Cloudflare, aucun réseau tiers, aucun déploiement. Ce reçu n'atteste pas le rendu Studio, la qualité de génération distante ni une campagne originale complète.
