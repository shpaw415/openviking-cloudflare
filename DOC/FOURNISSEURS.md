# Importer un fichier de configuration dans le Worker

Une clé OpenViking **root** peut importer un fichier JSON dans Control pour changer les modèles, la recherche et le traitement des sessions sans redéployer. `ov.edge.conf` reprend un sous-ensemble de `ov.conf` au pin `000f0765d7ec183886fbabbc22e69bc289cc429d`, plus des réglages propres au port Edge indiqués ci-dessous. Ce n’est **pas** le fichier de démarrage complet du serveur Python.

## 1. Autoriser le fournisseur externe une fois

Pour **Workers AI** (par exemple Llama), garde le binding `AI` du [déploiement](DEPLOIEMENT.md). Aucun secret de fournisseur n’est nécessaire.

Pour **OpenAI** ou une **API compatible** (Ollama, vLLM, etc.), ajoute un secret Workers nommé `OPENVIKING_EDGE_PROVIDERS`. Sa valeur est un tableau JSON de couples URL de base / clé :

```json
[
  { "api_base": "https://api.openai.com/v1", "api_key": "CLE_DU_FOURNISSEUR" },
  { "api_base": "https://inference.example.com/v1", "api_key": "CLE_DE_TON_SERVICE" }
]
```

Ne garde que les fournisseurs approuvés. Cette valeur va dans les [secrets Workers](https://developers.cloudflare.com/workers/configuration/secrets/), pas dans le fichier à importer, les variables publiques, ni Git. Tu peux l’ajouter au premier déploiement via `--secrets-file` (valeur encodée en **chaîne** JSON), ou sur un Worker existant avec `wrangler secret put OPENVIKING_EDGE_PROVIDERS` en lisant le tableau depuis un fichier privé via l’entrée standard. L’ajout ou la rotation d’un secret est une opération Cloudflare ; changer le modèle d’une destination **déjà autorisée** n’en est pas une.

Le Worker n’émet que vers la base HTTPS exacte admise par l’opérateur, sans suivre de redirection. Il ajoute `/chat/completions` ou `/embeddings` à cette base et envoie la clé dédiée en Bearer, jamais la clé OpenViking. Pour Ollama, utilise un endpoint HTTPS authentifié et joignable depuis Cloudflare, pas `localhost`. Autoriser une destination signifie lui faire confiance pour traiter le texte des utilisateurs et vérifier ses règles de confidentialité et ses tarifs. N’y mets pas une URL de redirection, un proxy ouvert ou une clé dans le chemin.

Pour autoriser le **SSE HTTP**, ajoute la variable de déploiement `OPENVIKING_EDGE_OPERATOR_STREAMING=1`. Sans elle, `stream:true` sur le binding opérateur donne `501 streaming_unavailable` sans appel fournisseur. Avec elle, une clé Data OpenViking admise peut demander `stream:true` pour un modèle routable. Le fournisseur doit émettre un flux Chat Completions texte, avec une raison de fin prise en charge et `[DONE]`. Le Gateway le traduit en Chat, Responses ou Messages selon la route ; pas de transport natif Responses/Messages vers le fournisseur, de repli non-stream, ni de droit supplémentaire pour les clés dédiées ou les profils tenant. Voir [le contrat SSE](../docs/GATEWAY.md#sse-natif).

## 2. Préparer `ov.edge.conf`

Copie le [fichier exemple OpenAI](exemples/openai.conf) ou [Llama / Workers AI](exemples/llama-workers-ai.conf) vers `ov.edge.conf`. Exemple **OpenAI** avec génération, recherche et modèle vectoriel pour les nouveaux espaces :

```json
{
  "vlm": { "provider": "openai", "model": "gpt-4o-mini", "temperature": 0.2, "max_tokens": 1024, "timeout": 20 },
  "embedding": { "dense": { "provider": "openai", "model": "text-embedding-3-small", "dimension": 1536, "input": "text" } },
  "default_search_limit": 10,
  "default_search_score_threshold": 0.2
}
```

Sans `api_base`, `openai` choisit `https://api.openai.com/v1` et exige son entrée dans le secret. Pour **Llama sur Workers AI** ou **Ollama**, remplace seulement `vlm` par l’un des blocs suivants :

```json
{ "provider": "workers_ai", "model": "@cf/meta/llama-3.1-8b-instruct", "max_tokens": 1024 }
```

```json
{ "provider": "ollama", "api_base": "https://inference.example.com/v1", "model": "llama3.2:3b", "max_tokens": 1024 }
```

| Champ | Décision et effet |
|---|---|
| `vlm.provider`, `vlm.model`, `vlm.api_base` ; alias amont `vlm.backend` | Sélection texte parmi `workers_ai`, `openai`, `openai-compatible` ou `ollama` via le protocole OpenAI. `backend` est normalisé comme `provider` ; une paire contradictoire est refusée. L’URL doit correspondre à l’inventaire HTTPS du déploiement. |
| `vlm.temperature`, `vlm.max_tokens`, `vlm.timeout` | Température de 0 à 2 ; plafond de sortie de 1 à 2 048 tokens, sans augmenter la demande du client ; délai HTTP par appel de 1 à 25 s (20 s par défaut, couvre aussi le corps SSE). Les bornes SSE 12 s / 45 s continuent à s’appliquer. `temperature:null` et `max_tokens:null` omettent ces réglages VLM, sans enlever les limites Edge. |
| `vlm.reasoning_effort` | Réglage de calcul pour les modèles HTTP qui le prennent en charge : `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, ou `null` pour ne rien envoyer. Transmis au corps Chat Completions en JSON et SSE. Ni sondage à l’import ni garantie que tous les modèles le comprennent ; omettre si non compatible. Pas de flux de raisonnement exposé. |
| `vlm.top_p` (projection Edge typée) | De 0 à 1, ou `null` pour omettre. Transmis en JSON et SSE Chat Completions aux modèles HTTP compatibles ; pas envoyé à Workers AI. Au pin, `top_p` n’est pas un champ autonome : certains backends acceptent un corps additionnel libre, qui reste **refusé** sur Edge. |
| `vlm.max_concurrent` | De 1 à 8, facultatif. Plafond d’appels simultanés au modèle de déploiement par espace, partagé par la génération texte et les tours multimédias/outils. Un flux SSE occupe sa place jusqu’à fin/annulation. Refus `429` si le plafond est atteint, sans mise en attente ni augmentation des quotas. N’inclut pas les sondes root, qui ont leur propre quota. En amont, le même nom pilote le parallélisme de traitement sémantique côté serveur. |
| `embedding.dense` (`provider` ou `backend`, `model`, `api_base`, `dimension`, `input`) | Embeddings texte seulement, de 1 à 2 048 dimensions, mêmes fournisseurs s’ils parlent le protocole correspondant. Aux modèles OpenAI `text-embedding-3-*`, le Worker demande la dimension choisie ; pour les autres, indique leur dimension réelle. La taille et l’ordre des vecteurs sont vérifiés. |
| `embedding.dense.batch_size`, `embedding.dense.encoding_format` | HTTP seulement. Plafond de 1 à 32 textes par sous-lot (32 par défaut ; l’indexeur peut déjà envoyer moins). Les sous-lots sont séquentiels, sans prolonger la fenêtre HTTP de 20 s par lot logique ni changer la réservation totale de vecteurs. `float` par défaut ou `base64` standard avec remplissage `=` si nécessaire (coordonnées float32 little-endian, taille exacte, valeurs finies, index uniques). Une réponse invalide fait échouer le lot logique, sans retour partiel ni tentative avec un autre format. |
| `default_search_limit` | Entier de 1 à 50 ; défaut `10` dans `find`/`search` Edge (une limite explicite reste prioritaire). Abaisse aussi le plafond du rappel **déjà activé** du Gateway lorsqu’il est inférieur à 12. |
| `default_search_score_threshold` (extension Edge) | De `0` à `1` ; défaut `0.1` pour le cosinus de `find`/`search` si aucun seuil n’est fourni. Dans le Gateway, ne fait que relever le seuil du profil actif, sans activer le rappel ni modifier les ACL ou les quotas. Au pin, le seuil est un paramètre de requête ou de profil, pas un défaut global Python. `rerank.threshold` concerne un autre score et ne sert pas d’alias. |
| `retrieval.enable_intent:false` | Même branche « requête brute » qu’en amont : `search` n’utilise plus le contenu de session fourni. `retrieval:null` restaure le contexte de session local et borné d’Edge (jamais un planificateur LLM). |
| `retrieval.session_context_messages`, `retrieval.session_context_chars` (extensions Edge) | Resserre le contexte fourni au calcul vectoriel de `search` avec `session_id` : 1 à 4 messages utilisateur ; 64 à 1 024 unités UTF-16 au total (256 par message, plus récent prioritaire avec le plafond explicite). Rien à configurer en mode requête brute. La lecture reste attachée au propriétaire de la session. |
| `rerank.provider`, `rerank.model`, `rerank.api_base`, `rerank.threshold`, `rerank.timeout`, `rerank.max_input_tokens` | Reclasse les candidats qui ont franchi le seuil vectoriel de `find` et `search` HTTP Data. `provider:"openai"` désigne uniquement le protocole HTTP compatible de classement, pas un endpoint officiel implicite. URL HTTPS complète inscrite exactement au secret ; le corps contient seulement le modèle, la requête brute, les extraits autorisés et `top_n`. Un résultat doit dépasser `threshold` (0–1, défaut 0.1). Délai complet 0.1–10 s (défaut 3) ; `max_input_tokens` 128–1 024 par paire, estimés sur Edge, ou 0 (défaut) pour conserver les seuls plafonds d’octets. Voir ci-dessous. |
| `memory.extraction_enabled` | `false` archive le texte normalement mais désactive l’extraction d’événements lors du **nouveau scellement**, y compris auto-commit. `true` (défaut) conserve le choix du propriétaire et n’élargit pas les catégories portées. Le résumé de travail explicitement demandé reste indépendant. Les archives déjà scellées gardent leurs options de traitement et leurs règles de reprise. |
| `memory.edge_context_token_budget`, `memory.edge_extraction_max_tokens` (extensions Edge) | Respectivement : plafond de 0 à 128 000 tokens estimés pour la route `/sessions/{id}/context` (pas de plafond additionnel si omis ; la requête peut demander moins), et plafond de sortie de 1 à 1 536 tokens de l’extracteur JSON d’événements (1 536 par défaut, encore limité par `vlm.max_tokens`). Les plafonds d’octets, de portée et de stockage restent inchangés. |
| `memory.session_auto_commit.enabled`, `message_count_threshold`, `pending_token_threshold` dans cette section | `enabled:true` applique une politique par défaut aux nouvelles sessions natives sans politique explicite, lorsqu’elles disposent de la file durable. En amont, les deux seuils appartiennent à la politique de session ; Edge permet d’en régler ici le défaut : 0–100 messages (défaut 100) et 0–150 000 tokens en attente (défaut 150 000). Strictement au-dessus d’un des seuils actifs ; 0 désactive ce déclencheur, pas les deux à la fois. `false` (défaut) ne pose aucune politique. Aucune réécriture des politiques existantes, des sessions Bot/Gateway ou des historiques restaurés, et pas de déclenchement d’inactivité. |
| Paramètres fonctionnels non portés | `retrieval.enable_intent:true`, `recall_intent_timeout_s`, `recall_rewrite_timeout_s`, `apply_rerank_to_context`, `query_planner`, `default_search_mode`, classeurs autres que le protocole ci-dessus, `embedding.sparse` / `hybrid`, `embedding.text_source` / `max_input_tokens` / `query_param` / `document_param`, extraction de skills/liens, protocole Python, modèles de templates personnalisés, réessais de résumé et options scanner/Redis de `memory.session_auto_commit` : refusés. Aucun alias vers un comportement approximatif sans équivalent. |
| Hébergement, secrets et routage | `server`, `storage`, `gateway`, `oauth`, écoute/ports, chemins OS (`workspace`, `model_path`, `cache_dir`), `allow_private_networks`, `runtime_config`, `*_api_key`, `credentials`, `extra_headers` / `extra_request_body` / `extra_body`, fournisseurs en cascade, retries, serving SSE/médias et quotas : refusés à l’import. Autorités, bindings, autorisations de destination, secrets et fonctions de déploiement restent hors fichier. |

### Exemples avancés

Le [fichier `sessions-edge.conf`](exemples/sessions-edge.conf) ne sélectionne aucun fournisseur et ne contient aucun secret. Il plafonne le contexte de session et désactive l’extraction d’événements pour les futures archives.

Un reclassement externe est désactivé par défaut. Exemple **fictif**, à utiliser uniquement après approbation du fournisseur et de son traitement des données :

```json
{
  "rerank": {
    "provider": "openai", "model": "ranking-model", "api_base": "https://rank.example.com/v1/reranks",
    "threshold": 0.45, "timeout": 2, "max_input_tokens": 256
  }
}
```

Dans ce cas, enregistre **l’URL complète** `https://rank.example.com/v1/reranks` (sans slash terminal) comme `api_base` dans l’inventaire du §1. Aucun suffixe n’est ajouté. Le Worker envoie à ce fournisseur le texte de la requête et les extraits d’au plus 50 candidats **déjà lisibles** (768 octets UTF-8 par extrait, 1 024 pour la requête, 64 Kio pour le JSON) ; ni preuve de session, ni URI, ni clé OpenViking. Le budget de génération par compte et par acteur débite cet appel. Il ne s’applique ni au rappel Gateway, ni aux recherches seulement métadonnées, ni aux identités déléguées/fédérées. `provider_rerank` distingue le score du fournisseur du cosinus. Réponses incomplètes, redirections ou dépassements de délai échouent explicitement ; candidat, droits ou révision changés pendant l’appel invalident son classement. `rerank:null` restaure le classement vectoriel. Ce sous-ensemble n’implémente pas `search(mode="context")` ni les protocoles de classement natifs imbriqués.

Sources du contrat au pin : `openviking_cli/utils/config/{open_viking_config,retrieval_config,rerank_config,memory_config,embedding_config,vlm_config}.py` ; `openviking/models/{rerank/openai_rerank,embedder/openai_embedders,vlm/backends/openai_vlm}.py` ; `openviking/retrieve/{hierarchical_retriever,rerank_scoring}.py` ; `openviking/service/{core,session_service}.py`, `openviking/session/{session,auto_commit_policy}.py`. Les options marquées Edge ne se copient pas dans un `ov.conf` Python.

Le fichier fait au plus 16 Kio. Une clé de premier niveau omise reste inchangée ; `null` restaure son défaut. Lorsqu’une section est fournie, elle remplace la section entière, pas juste ses champs présents. L’API runtime existante pour les [réglages système et comptes](../docs/CONTROL.md) reste séparée. Tout champ non porté est refusé, **pas ignoré**.

**Important :** un espace conserve le fournisseur, le modèle, la dimension et les options de transport fixés pour son index. Les données héritées du Worker restent sur BGE (768 dimensions) ; les autres espaces se fixent au premier calcul vectoriel réussi. La section `embedding` change le défaut des espaces **non encore fixés**, pas les index existants, même à dimension identique. Pour migrer un index existant, prépare un nouvel espace et réimporte les textes ; garde l’ancienne destination disponible jusqu’à la migration. Ne restaure pas une ancienne version du code incapable de lire ce choix sur une base qui contient des vecteurs personnalisés.

## 3. Prévisualiser, appliquer et vérifier

Depuis le clone, utilise `OV_URL` et `KEY_DIR` du [tutoriel d’administration](ADMINISTRATION.md). Lis la révision courante, puis remplace `0` par ce nombre :

```sh
node scripts/admin.mjs show-config --url "$OV_URL" --key-file "$KEY_DIR/root.key"
REV=0
node scripts/admin.mjs import-config --url "$OV_URL" --key-file "$KEY_DIR/root.key" \
  --file ov.edge.conf --dry-run --revision "$REV"
node scripts/admin.mjs import-config --url "$OV_URL" --key-file "$KEY_DIR/root.key" \
  --file ov.edge.conf --apply --revision "$REV"
node scripts/admin.mjs test-config --url "$OV_URL" --key-file "$KEY_DIR/root.key" --kind vlm
```

`--dry-run` valide le fichier et les bindings sans publier ni appeler de modèle. Les reçus du CLI n’affichent pas les URL ni les secrets. `--revision` empêche d’écraser une modification concurrente : sur `409`, relis la configuration et revalide ton fichier. Un changement ferme les montages précédents du Gateway et du classeur avant publication de la nouvelle révision. En cas de résultat incertain, relis `show-config` ; si une transition incomplète est signalée, reprends le même import. Pour restaurer les défauts, importe `{"vlm":null,"embedding":null,"default_search_limit":null,"default_search_score_threshold":null,"retrieval":null,"rerank":null,"memory":null}`. Les index fixés conservent leur choix.

`test-config` fait **un appel non-stream** avec une entrée synthétique, pas avec des données du compte. `--kind embedding` sonde le modèle par défaut des nouveaux espaces ; consulte `edge-capabilities` avec la clé d’un espace pour voir son modèle effectif. Les appels externes n’ont pas de repli automatique et les quotas du port restent actifs. Ces parcours sont vérifiés en Workerd local avec fournisseurs simulés, pas avec des clés commerciales.
