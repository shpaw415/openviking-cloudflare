# Importer un fichier de configuration dans le Worker

Une clé OpenViking **root** peut importer un fichier JSON dans Control pour changer les modèles et quelques réglages de recherche sans redéployer. `ov.edge.conf` reprend un sous-ensemble de `ov.conf` au pin `000f0765d7ec183886fbabbc22e69bc289cc429d`, plus un défaut de score propre au port Edge. Ce n’est **pas** le fichier de démarrage complet du serveur Python.

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
| `embedding.dense` (`provider`, `model`, `api_base`, `dimension`, `input`) | Embeddings texte seulement, de 1 à 2 048 dimensions, mêmes fournisseurs s’ils parlent le protocole correspondant. Aux modèles OpenAI `text-embedding-3-*`, le Worker demande la dimension choisie ; pour les autres, indique leur dimension réelle. La taille et l’ordre des vecteurs sont vérifiés. |
| `default_search_limit` | Entier de 1 à 50 ; défaut `10` dans `find`/`search` Edge (une limite explicite reste prioritaire). Abaisse aussi le plafond du rappel **déjà activé** du Gateway lorsqu’il est inférieur à 12. |
| `default_search_score_threshold` (extension Edge) | De `0` à `1` ; défaut `0.1` pour le cosinus de `find`/`search` si aucun seuil n’est fourni. Dans le Gateway, ne fait que relever le seuil du profil actif, sans activer le rappel ni modifier les ACL ou les quotas. Au pin, le seuil est un paramètre de requête ou de profil, pas un défaut global Python. `rerank.threshold` concerne un autre score et ne sert pas d’alias. |
| `retrieval.enable_intent:false` | Même branche « requête brute » qu’en amont : `search` n’utilise plus le contenu de session fourni. `retrieval:null` restaure le contexte de session local et borné d’Edge (jamais un planificateur LLM). `true`, `recall_intent_timeout_s`, `recall_rewrite_timeout_s` et `apply_rerank_to_context` sont refusés : pas de consommateur équivalent sur Edge. |
| Autres clés, y compris `server`, `storage`, chemins OS, `gateway`, `rerank`, `embedding.sparse` | Refusés : stockage, identités, hébergement, destinations et routage de déploiement ne se configurent pas avec cet import. |
| Secrets, `vlm.credentials`, `vlm.providers`, `vlm.extra_headers`, `vlm.extra_request_body`, `vlm.stream`, `vlm.max_retries`, `vlm.backup`, `vlm.media` | Refusés. Pas de transmission arbitraire ni de retries/failover ; les secrets restent côté déploiement. |

Le fichier fait au plus 16 Kio. Une clé de premier niveau omise reste inchangée ; `null` restaure son défaut. Lorsqu’une section est fournie, elle remplace la section entière, pas juste ses champs présents. L’API runtime existante pour les [réglages système et comptes](../docs/CONTROL.md) reste séparée. Tout champ non porté est refusé, **pas ignoré**.

**Important :** un espace conserve le fournisseur, le modèle et la dimension utilisés par son index. Les données héritées du Worker restent sur BGE (768 dimensions) ; les autres espaces se fixent au premier calcul vectoriel réussi. La section `embedding` change le défaut des espaces **non encore fixés**, pas les index existants, même à dimension identique. Pour migrer un index existant vers un autre modèle, prépare un nouvel espace et réimporte les textes ; garde l’ancienne destination disponible jusqu’à la migration. Ne restaure pas une ancienne version du code incapable de lire ce choix sur une base qui contient des vecteurs personnalisés.

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

`--dry-run` valide le fichier et les bindings sans publier ni appeler de modèle. `--revision` empêche d’écraser une modification concurrente : sur `409`, relis la configuration et revalide ton fichier. Un changement effectif ferme les montages Gateway précédents avant publication de la nouvelle révision. En cas de résultat incertain, relis `show-config` ; si une transition incomplète est signalée, reprends le même import. Pour restaurer les défauts, importe `{"vlm":null,"embedding":null,"default_search_limit":null,"default_search_score_threshold":null,"retrieval":null}`. Les index fixés conservent leur modèle.

`test-config` fait **un appel non-stream** avec une entrée synthétique, pas avec des données du compte. `--kind embedding` sonde le modèle par défaut des nouveaux espaces ; consulte `edge-capabilities` avec la clé d’un espace pour voir son modèle effectif. Les appels externes n’ont pas de repli automatique et les quotas du port restent actifs. Ces parcours sont vérifiés en Workerd local avec fournisseurs simulés, pas avec des clés commerciales.
