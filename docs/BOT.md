# VikingBot natif Workers

Contrat relevé en lecture seule au SHA `000f0765d7ec183886fbabbc22e69bc289cc429d` : `openviking/server/routers/bot.py`, `bot/vikingbot/channels/openapi{,_models}.py`, types et lecteurs SSE des sessions Web Studio. Les sources amont sont des données, pas des scripts exécutés.

## Routes `/bot/v1`

| Route | Usage |
|---|---|
| `GET /health` | `status`, `version`, `timestamp`, plus `generation` et `persists_messages`. Ne lance pas d'inférence. `503` sans binding de génération. Ce n'est pas un test de disponibilité distante. |
| `POST /chat` | `{message, session_id?, need_reply?, stream?}`. Réponse JSON directe `{session_id,response_id,message,events,relevant_memories,token_usage,timestamp}` ou SSE si `stream:true`. `need_reply:false` persiste seulement l'entrée et n'appelle pas de modèle. |
| `POST /chat/stream` | Même entrée texte ; `text/event-stream`, `X-VikingBot-Session-ID`, `X-VikingBot-Persists-Messages: true`. |
| `GET/POST /sessions`, `GET/DELETE /sessions/{id}` | Liste, création, état et historique persistants du bot. Même session que l'API OpenViking ; effacer une session via l'un des deux endpoints la retire de l'autre. La réponse détail contient `turn` avec l'identifiant, l'état et la référence de réponse connus. |
| `POST /sessions/{id}/interrupt` | `{interrupted:true}` seulement si le tour en cours de ce principal a réellement perdu son droit de publier. Retour `false` si rien à interrompre pour ce principal. |

Le format SSE amont porte l'événement **dans le JSON** : `data: {"event":"response","data":{"content":"…","response_id":"…"},"timestamp":"…"}\n\n`. Une annulation donne `interrupt`, un problème après ouverture donne `response` avec `data.error` et `data.code`. Aucune simulation de `content_delta`, raisonnement ou appel d'outil : le binding parent rend un résultat texte entier. Le flux se termine après l'événement final ; l'entrée et la réponse sont déjà durables à cet instant. Pas de reconnexion au flux à mi-génération ; relire le détail de la session pour savoir si la réponse a été stockée. Après perte du propriétaire d'un ancien tour, l'état est `failed/TURN_OWNER_LOST`, pas un `running` éternel ni un rejeu automatique.

## Raccord et frontières

- Le parent monte `initBot(ctx)` et `routeBot(request,url,ctx)` derrière son authentification et ses en-têtes. Aucune identité reçue dans `user_id` ou `openviking_connection` n'est utilisée ; aucun jeton transmis au fournisseur. Un contexte client non vide est refusé.
- Le bot écrit le message utilisateur avant le modèle. Il lit le contexte de **la même** session, et utilise le vrai `/api/v1/search/find` interne pour des extraits vectoriels des mémoires/ressources privées et des ressources partagées autorisées. Avant publication il revalide le caller, le bail, l'ACL et la révision des sources consultées. Une erreur d'embedding remonte, sans faux repli lexical ou réponse fictive. Une révocation de fichier n'efface pas rétroactivement les réponses déjà livrées.
- Texte du contexte transmis comme données citées, sans outils, aucune exécution, requête HTTP externe construite par le modèle, ni interprétation de la réponse comme commande. Le binding fourni par le parent est la seule génération. Admission avant générateur, stockage de la réponse et libération du bail en une transaction ; un échec conserve l'entrée, mais ne crée pas de réponse. L'interruption est réellement appliquée au stockage et au flux ; l'appel fournisseur sans `AbortSignal` peut finir derrière, son résultat est jeté. Les nouvelles écritures concurrentes (append, commit, effacement) reçoivent `409` pendant un tour actif de la même session.
- Bornes : corps HTTP 24 Kio, question 8 Kio, jusqu'à 24 messages texte depuis une vue active de 16 Kio et 4 extraits de 256 caractères, sortie 16 Kio/1 024 jetons demandés. Historique Bot : 200 dernières lignes physiques au plus, réponse de messages bornée à 256 Kio en plus du budget de jetons. Baux et quotas communs aux sessions. Un POST chat répété n'est pas dédoublonné automatiquement.
- **Raccord Studio :** le client amont écrit lui-même les messages (`persistMessages:true` dans `thread.tsx`). Pour ce moteur qui persiste déjà, désactiver cette écriture côté Studio quand `persists_messages` est annoncé ; sinon le client peut réécrire des messages ou recevoir un conflit pendant le tour. Ne pas dédupliquer sur le texte côté serveur. Le client doit traiter `response.data.error` comme une erreur et non comme un message assistant. L'UI n'est pas modifiée dans ce lot.
- Non portés dans ce lot : images, passerelles/canaux tiers, feedback/évolution, steer à chaud, raisonnement, outils autonomes ou exécution de commandes. Aucun faux statut de dépôt de tâche pour le chat.

## Preuve locale

`tests/bot.test.mjs` joue des requêtes HTTP sur `workerd`, avec SQLite, embeddings et génération de test. Vérifications : contrôle de disponibilité, persistance après redémarrage, récupération d'une mémoire réellement produite par commit, forme SSE, annulation et isolation après recréation, changement de source pendant la génération, erreurs et métriques inconnues. Un scénario distinct exerce aussi le Worker parent (authentification et passage du flux au travers du RPC) avec un binding fictif. Le rejeu n'évalue pas la qualité de réponse du modèle commercial ni la parité navigateur.
