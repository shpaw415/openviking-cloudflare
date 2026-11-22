# Déployer OpenViking sur Cloudflare Workers

Les étapes 1 et 2 restent locales. La publication est une opération distincte qui nécessite un compte et une zone Cloudflare autorisés.

## 1. Construire depuis un clone neuf

Depuis la racine du clone **de ce port**, sur Linux x86-64 : Git, Node **22** (≥ 22.12), npm système, Python ≥ 3.10, `libseccomp.so.2` et Landlock ABI ≥ 6. Le [rapport Studio](../docs/STUDIO.md#rejouer) explique la sélection du binaire Node si la version système n’est pas 22. Le premier remplissage des caches npm requiert l’accès aux registres ; la compilation du Studio se fait ensuite dans une copie confinée.

```sh
git clone --no-checkout https://github.com/volcengine/OpenViking.git upstream
git -C upstream checkout --detach 000f0765d7ec183886fbabbc22e69bc289cc429d
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

Ne modifiez pas `upstream/`. Le build vérifie le TypeScript, applique les patches du port dans une copie du vrai Studio et signale un dossier `.work/studio/logs/build-…/dist`. **Il ne remplit ni ne remplace `dist/studio/`.** Ne confondez pas `--bundle-only` avec un build complet. Avant une mise en ligne, vérifiez le candidat exact : tests du port, [tests Studio amont et Edge](../docs/STUDIO.md) et passage dans le navigateur sur ces mêmes actifs. N’injectez aucun secret via `VITE_*` et conservez les notices d’origine et l’accès au code correspondant selon l’[AGPL](../LICENSE).

## 2. Préparer un répertoire d’actifs séparé et vérifier le paquet

Remplacez `build-REMPLACER` par le nom **affiché par votre build**, pas par le dernier dossier trouvé. Le paquet de livraison ne contient que le Studio et utilise `--assets` pour éviter toute promotion locale ou utilisation d’un ancien `dist/studio/`.

```sh
STAGE="$PWD/.work/studio/logs/build-REMPLACER"
ASSETS_DIR="$(mktemp -d "$PWD/.work/worker-assets.XXXXXX")"
cp -a -- "$STAGE/dist" "$ASSETS_DIR/studio"
(cd "$ASSETS_DIR/studio" && sha256sum --check --strict --quiet "$STAGE/assets.sha256")
test -s "$ASSETS_DIR/studio/index.html"
```

Arrêtez-vous si une commande échoue ou si vous ne reconnaissez pas le candidat. Aucun `*.key`, fichier de configuration, sourcemap ou autre actif étranger ne doit se trouver dans ce dossier. Avec les dépendances verrouillées du port, utilisez le Wrangler local, pas un téléchargement implicite :

```sh
OUT_DIR="$(mktemp -d "$PWD/.work/wrangler-dry-run.XXXXXX")"
WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run \
  --config wrangler.jsonc --assets "$ASSETS_DIR" --outdir "$OUT_DIR"
```

Le dry-run contrôle le bundle et l’empaquetage, pas les autorisations du compte Cloudflare, le DNS, l’exécution distante ni les modèles. N’y joignez pas de secret. Voir aussi la [recette locale](CONFIGURATION.md#vérifier-sans-cloudflare).

## 3. Choisir le Worker et son URL publique

Dans [`wrangler.jsonc`](../wrangler.jsonc), gardez `ASSETS`, le binding `AI` et les Durable Objects SQLite `WORKSPACES` → `Workspace`, `CONTROL` → `Control`, `OAUTH` → `OAuth`. Ne retirez ni ne renommez les migrations `v1`, `v2-control`, `v3-oauth`. Elles sont appliquées par Wrangler ; aucun SQLite local n’est téléversé. Conservez le même compte et le même nom de Worker pour les mises à jour : changer de Worker n’emporte pas ses données.

`workers_dev: false` et `preview_urls: false` sont volontaires. Dans une zone de votre compte, choisissez un hôte dédié et ajoutez la propriété `routes` suivante à la configuration (en remplaçant le domaine) :

```json
"routes": [{ "pattern": "ov.example.com", "custom_domain": true }]
```

Un domaine personnalisé dessert ici **tout** le Worker sur le même hôte : Studio, API et sondes. Si vous utilisez plutôt [une route sur une zone existante](https://developers.cloudflare.com/workers/configuration/routing/routes/), configurez la route et le DNS proxifié pour cet hôte. N’utilisez pas une route limitée à `/studio/*`. Vérifiez la cible et les règles Cloudflare avant exposition et ne mettez pas en cache les réponses authentifiées. Voir les [domaines personnalisés](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## 4. Amorcer les identités et publier

Pour un **nouveau** Worker, créez une clé `root` inédite et un fichier de secrets au format JSON compris par Wrangler. Le même secret `OPENVIKING_EDGE_KEYS` contient un tableau d’identités fixes encodé en chaîne JSON. L’exemple n’ajoute qu’un `root` sans espace de données. Le port exige au moins une identité fixe valide, y compris lorsqu’il existe des clés gérées.

```sh
umask 077
KEY_DIR="$(mktemp -d "$HOME/.openviking-keys.XXXXXX")"
python3 - "$KEY_DIR" <<'PY'
import json
from pathlib import Path
import secrets
import sys

directory = Path(sys.argv[1])
key = secrets.token_hex(32)
identities = [dict(key=key, accountId='bootstrap', userId='root', agentId='default', role='root')]
with (directory / 'root.key').open('x', encoding='ascii') as out:
    out.write(key + '\n')
with (directory / 'wrangler-secrets.json').open('x', encoding='ascii') as out:
    json.dump({'OPENVIKING_EDGE_KEYS': json.dumps(identities)}, out)
PY
```

Gardez ces fichiers hors dépôt et hors actifs. Après sauvegarde de la clé dans votre coffre, ne conservez pas de copie de préparation inutile. `.dev.vars` est réservé au **local** ; ne mettez pas la clé dans `wrangler.jsonc`, un argument ou un journal.

Authentifiez Wrangler avec [les modalités Cloudflare](https://developers.cloudflare.com/workers/wrangler/commands/) et vérifiez avec `./node_modules/.bin/wrangler whoami` que vous opérez sur le bon compte. Après validation et autorisation de publier, alors seulement :

```sh
./node_modules/.bin/wrangler deploy --config wrangler.jsonc --assets "$ASSETS_DIR" \
  --secrets-file "$KEY_DIR/wrangler-secrets.json"
```

Cette commande publie le Worker et le secret d’amorçage dans la même version. Pour une mise à jour ordinaire, préparez les nouveaux actifs et déployez **sans** `--secrets-file` : ne régénérez pas le `root`. Un changement des identités **fixes** se fait sur le secret Worker (p. ex. [`wrangler secret put`](https://developers.cloudflare.com/workers/configuration/secrets/) avec entrée privée) et est distinct de la rotation d’une clé **gérée**, qui ne déploie rien.

## 5. Vérifier avant de connecter des clients

```sh
OV_URL='https://ov.example.com' # Remplacer par votre origine HTTPS exacte.
curl -fsS --max-time 15 "$OV_URL/health"
curl -fsS --max-time 15 "$OV_URL/ready"
curl -fIsS --max-time 15 "$OV_URL/studio/"
node scripts/admin.mjs list-accounts --url "$OV_URL" --key-file "$KEY_DIR/root.key"
```

Attendez-vous à `healthy:true`, `auth_mode:"api_key"`, puis `status:"ready"` avec les vérifications de configuration et SQLite à `ok`. Un binding IA présent n’a pas été sondé. La liste root d’un nouveau registre est vide ; elle vérifie l’authentification et le contrôle, pas l’accès aux données. Pour valider le Studio, créez un compte de test et connectez le profil de travail avec une **clé de données**, jamais avec la clé root. Si `/ready` échoue, relisez le secret et les bindings ; si les sondes ne répondent pas au bon service, corrigez le domaine ou la route avant de transmettre une clé.

Pour la suite, voir [l’administration à distance](ADMINISTRATION.md) et [les options du portage](CONFIGURATION.md).
