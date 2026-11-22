# Importer un fichier de configuration dans le Worker

Après le premier déploiement de cette version du Worker, une clé OpenViking **root** peut envoyer un fichier JSON de configuration et changer les modèles sans redéployer. Le fichier reprend les sections `vlm` et `embedding.dense` de `ov.conf`, mais ce n’est **pas** le fichier de démarrage complet du serveur Python.

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

## 2. Préparer `ov.edge.conf`

Copie le [fichier exemple OpenAI](exemples/openai.conf) ou [Llama / Workers AI](exemples/llama-workers-ai.conf) vers `ov.edge.conf`. Exemple **OpenAI** avec génération, recherche et modèle vectoriel pour les nouveaux espaces :

```json
{
  "vlm": { "provider": "openai", "model": "gpt-4o-mini", "temperature": 0.2, "max_tokens": 1024, "timeout": 20 },
  "embedding": { "dense": { "provider": "openai", "model": "text-embedding-3-small", "dimension": 1536, "input": "text" } },
  "default_search_limit": 10
}
```

Sans `api_base`, `openai` choisit `https://api.openai.com/v1` et exige son entrée dans le secret. Pour **Llama sur Workers AI** ou **Ollama**, remplace seulement `vlm` par l’un des blocs suivants :

```json
{ "provider": "workers_ai", "model": "@cf/meta/llama-3.1-8b-instruct", "max_tokens": 1024 }
```

```json
{ "provider": "ollama", "api_base": "https://inference.example.com/v1", "model": "llama3.2:3b", "max_tokens": 1024 }
```

| Champ | Pris en charge |
|---|---|
| `vlm` | Génération **texte**. `workers_ai`, `openai`, `openai-compatible` ou `ollama` via le protocole OpenAI. `temperature` facultatif de 0 à 2 (omettre si le modèle ne l’accepte pas), `max_tokens` ≤ 2 048, `timeout` de 1 à 25 s pour les fournisseurs HTTP. Le plafond de sortie peut tronquer une réponse longue. |
| `embedding.dense` | Embeddings de texte, `dimension` de 1 à 2 048, mêmes fournisseurs s’ils parlent le protocole correspondant. Pour les modèles natifs OpenAI `text-embedding-3-*`, le Worker transmet la dimension demandée ; pour les autres, indique leur dimension réelle. La taille et l’ordre de chaque vecteur sont vérifiés. |
| `default_search_limit` | Nombre de résultats par défaut, de 1 à 50 ; une limite explicite du client reste prioritaire. |

Le fichier fait au plus 16 Kio. Une section omise reste inchangée ; une section à `null` restaure son défaut de déploiement. Tout champ non porté est refusé, **pas ignoré**. Ne copie pas `server`, `storage`, les chemins OS, les identifiants, les en-têtes arbitraires, les adaptateurs natifs non portés ou les réglages de repli. L’API runtime existante pour les [réglages système et comptes](../docs/CONTROL.md) reste séparée.

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

`--dry-run` valide le fichier et les bindings sans écrire ni appeler de modèle. `--revision` empêche d’écraser une modification concurrente : sur `409`, relis la configuration et revalide ton fichier. `--apply` enregistre les champs admis en une transaction SQLite ; les nouvelles requêtes les utilisent. En cas de résultat incertain, relis `show-config` avant de renvoyer quoi que ce soit. Garde une copie de ton fichier sans secrets pour revenir à la configuration précédente ; pour restaurer les défauts, importe `{"vlm":null,"embedding":null,"default_search_limit":null}`. Les index fixés conservent leur modèle.

`test-config` fait **un appel** avec une entrée synthétique, pas avec des données du compte. `--kind embedding` sonde le modèle par défaut des nouveaux espaces ; consulte `edge-capabilities` avec la clé d’un espace pour voir son modèle effectif. Les appels externes sont sans repli automatique et sans streaming dans le Gateway ; les quotas du port restent actifs. Ces parcours sont vérifiés en Workerd local avec fournisseurs simulés, pas avec des clés commerciales.
