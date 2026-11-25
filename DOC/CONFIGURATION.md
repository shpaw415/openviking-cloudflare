# Options et limites du port Cloudflare

## Vérifier sans Cloudflare

Pour l’administration seule, partez d’un clone avec les dépendances `npm ci --ignore-scripts` installées. Le harnais lance le vrai Workerd sur `127.0.0.1` avec SQLite jetable, clés fictives et IA simulée. Pas de compte Cloudflare, pas de build Studio nécessaire :

```sh
node scripts/studio-smoke.mjs 8797 --api-only --root
```

Dans un autre terminal à la racine du clone, en supposant que `8797` est le port libre choisi pour ce test :

```sh
OV_URL='http://127.0.0.1:8797'
KEY_DIR="$(mktemp -d "$PWD/.work/admin-local.XXXXXX")"
curl -fsS --max-time 5 "$OV_URL/health"
curl -fsS --max-time 5 "$OV_URL/ready"
node scripts/admin.mjs create-account --url "$OV_URL" \
  --key-file .work/browser/synthetic-root-8797.key \
  --account atelier --admin owner --out-key "$KEY_DIR/atelier-owner.key"
```

Poursuivez avec `register-user` et `regenerate-key` du [tutoriel d’administration](ADMINISTRATION.md). Arrêtez le harnais avec `Ctrl+C` : il efface ses clés synthétiques et sa base jetable. Supprimez aussi les clés émises dans le répertoire privé de test. Pour inclure le Studio, omettez `--api-only` et lancez le harnais depuis un dossier jetable où les actifs vérifiés du candidat sont sous `dist/studio/` (utilisez alors le chemin absolu du script). Cela ne remplace pas le `dist/studio/` du clone.

Pour tester **Wrangler** en local, utilisez `npm run dev -- 8787` depuis un clone de recette avec les actifs sous `dist/studio/` et `OPENVIKING_EDGE_KEYS` dans `.dev.vars` (`0600`, avec identités fictives). Ce profil dédié ne modifie pas `wrangler.jsonc` et omet le binding Workers AI, que Wrangler n’accepte pas ici en mode strictement local. Le stockage sous `.wrangler/offline-state` est persistant sur ce clone. L’IA y est indisponible, pas redirigée vers Cloudflare. Ne changez pas `remote` pour obtenir un test vert. `node --test tests/admin-cli.test.mjs` vérifie l’administration sur une instance jetable et des serveurs de test de transport, sans fournisseur distant.

N’ajoutez pas de secret fournisseur réel à `.dev.vars` pour une recette locale : le profil omet Workers AI, mais le code sait appeler tout endpoint HTTP externe explicitement admis par le secret. Le harnais de test des modèles intercepte ces appels : `node --test tests/model-config.test.mjs`.

## Configurer les fonctionnalités Edge

Les options ci-dessous sont des bindings ou variables du **Worker**, pas des réglages du serveur Python à copier. Les valeurs non secrètes vont dans la configuration Wrangler ; les secrets vont dans le coffre Workers. Aucun secret ne doit être empaqueté avec les actifs. Le tableau de [configuration du README](../README.md#démarrer-en-local) donne la liste des options ordinaires.

| Besoin | Particularité Cloudflare |
|---|---|
| Stockage | Un Durable Object SQLite par compte pour le plan de données et des objets distincts pour le contrôle et OAuth. Pas de serveur Python, de fichier de données à téléverser ni de migration automatique depuis une installation existante. |
| Embeddings et recherche | BGE par défaut via `AI` (`@cf/baai/bge-base-en-v1.5`, 768 dimensions). Un [fichier importé](FOURNISSEURS.md) peut sélectionner un autre modèle pour les espaces sans index initial ; aucun repli lexical automatique. `/ready` n’appelle aucun modèle. |
| Génération | `OPENVIKING_EDGE_GENERATION=1` avec `AI` pour le Llama par défaut, ou choisissez un modèle [par import de configuration](FOURNISSEURS.md). Pour les parcours de génération texte pris en charge : sessions, VikingBot, Compile, Rules et Gateway. |
| SSE du binding opérateur | `OPENVIKING_EDGE_OPERATOR_STREAMING=1` pour un modèle HTTP déjà autorisé et sélectionné par Control. Désactivé par défaut ; clés Data OpenViking seulement. |
| Conversion et sources | `OPENVIKING_EDGE_DOCUMENT_CONVERSION=1` pour toMarkdown (fichiers admis, 1 Mio max). L’[import ponctuel par URL](../docs/URL-IMPORT.md) exige le binding privé `TEXT_SOURCE`, la liste d’URL HTTPS exactes et des embeddings disponibles. |
| API MCP et délégation | MCP est opt-in (`OPENVIKING_EDGE_MCP=read` ou `read-write`) dans le périmètre des ACL. OAuth/OIDC sont séparés des clés d’administration ; voir les [politiques](../docs/POLICIES.md). |
| Gateway | Les clés dédiées datent du montage Workers AI et ne donnent pas de droits OpenViking Data. Les [transferts signés](../docs/GATEWAY-TRANSFERTS.md) exigent la clé Data du propriétaire du ticket ; le [streaming HTTP](../docs/GATEWAY.md#sse-natif) exige l’opt-in opérateur et un fournisseur autorisé. |
| Sauvegarde applicative | Le [binding privé de sauvegarde](../docs/ARCHIVES.md) exporte et restaure le compte explicitement autorisé, pas les identités, les secrets ou l’instance entière. La restauration est évaluée avant application. |

Le Studio utilise la même origine que l’API. Pour un client OpenViking, fournissez **un** en-tête `X-API-Key` ou `Authorization: Bearer`, pas les deux. Les en-têtes d’identité ne changent pas les droits. `GET /api/v1/system/edge-capabilities`, sous l’identité courante, expose les fonctions montées et `parity: partial` : un flag positif n’est pas une sonde de fournisseur, et un flag absent ou faux n’est pas à contourner.

## Voir l’état du service dans le Studio

Dans le menu de l’espace de travail, ouvrez **Monitoring** (`/studio/monitoring`), la même rubrique que dans OpenViking. Connectez-vous avec une clé OpenViking User ou Admin dans le profil de travail, pas avec la clé Root du profil d’administration. Si l’instance passe par Cloudflare Access, sa connexion reste nécessaire en plus de la clé OpenViking.

Le tableau utilise `/health` et `/api/v1/observer/system`. Les détails reflètent le stockage SQLite et les tâches de la portée autorisée. **No data** dans **Models** veut dire que les modèles n’ont pas été testés : consulter l’écran n’appelle aucun fournisseur IA. Une tâche échouée dans la file de la portée courante est signalée dans l’état général. `/ready` reste une sonde de préparation distincte.

Pour le fonctionnement commun (URI `viking://`, workflows, CLI, SDK), utilisez la [documentation officielle](README.md). Pour les résultats locaux et les écarts encore ouverts, consultez le [rapport de portage](../docs/PORTAGE.md) et le [suivi de parité](../docs/SUIVI-PARITE.md).
