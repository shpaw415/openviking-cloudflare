# Créer des comptes et renouveler des clés sans redéployer

La [CLI d’administration](../scripts/admin.mjs) utilise les routes OpenViking existantes sous `/api/v1/admin/`. Elle reprend les noms des commandes de `ov admin` pour ces opérations, mais les options ci-dessous sont propres au port : **pas de secret brut sur la sortie du programme**. Gardez le [client officiel `ov`](README.md) pour les usages OpenViking généraux.

## S’identifier

- Depuis la racine du clone : Node ≥ 22.12 et un système de fichiers POSIX avec liens physiques. La CLI n’a pas de dépendance npm ni de configuration Cloudflare à charger.
- Passez l’origine exacte (`https://ov.example.com`, sans `/studio` ni `/api`), et une clé par `--key-file` ou `--key-stdin` (sortie brute d’un coffre par un pipe, jamais une saisie visible). Le fichier d’entrée doit être régulier, vous appartenir et être privé (`0600` ou `0400`). Il contient une seule clé, avec ou sans fin de ligne. Aucun suivi des redirections ; HTTP n’est accepté que sur loopback.
- `root` crée et liste les comptes et peut administrer leurs utilisateurs, mais ne lit ni fichiers ni sessions. `admin` inscrit des utilisateurs et renouvelle les clés dans **son compte**. Un membre peut lister son annuaire et renouveler sa propre clé gérée, pas celle d’un autre utilisateur. Le Worker, pas la CLI ni un en-tête d’identité, décide de l’autorisation.

Dans les exemples, `OV_URL` et `KEY_DIR` sont ceux du [guide de déploiement](DEPLOIEMENT.md). `KEY_DIR` est un répertoire privé (`0700`) hors du dépôt, qui contient `root.key`. Pour un essai jetable sans compte Cloudflare, utilisez plutôt la [recette locale](CONFIGURATION.md#vérifier-sans-cloudflare).

## Créer un compte puis inscrire un utilisateur

```sh
node scripts/admin.mjs create-account --url "$OV_URL" --key-file "$KEY_DIR/root.key" \
  --account atelier --admin owner --out-key "$KEY_DIR/atelier-owner.key"

node scripts/admin.mjs register-user --url "$OV_URL" --key-file "$KEY_DIR/atelier-owner.key" \
  --account atelier --user alice --role user --out-key "$KEY_DIR/atelier-alice.key"

node scripts/admin.mjs list-users --url "$OV_URL" --key-file "$KEY_DIR/atelier-owner.key" \
  --account atelier
```

Le compte et son premier administrateur sont activés par la même opération. L’inscription accepte `user` (par défaut) ou `admin` seulement. Chaque émission écrit une seule ligne dans un **nouveau fichier `0600`**, sans écraser quoi que ce soit. Le serveur ne conserve que l’empreinte de la clé ; les commandes `list-accounts` et `list-users` n’affichent que des métadonnées. Remettez chaque clé par un coffre ou un canal de secrets approuvé, jamais en clair dans une discussion.

## Renouveler la clé d’Alice

```sh
node scripts/admin.mjs regenerate-key --url "$OV_URL" --key-file "$KEY_DIR/atelier-owner.key" \
  --account atelier --user alice --out-key "$KEY_DIR/atelier-alice-v2.key"

node scripts/admin.mjs list-users --url "$OV_URL" --key-file "$KEY_DIR/atelier-alice-v2.key" \
  --account atelier
```

**L’ancienne clé est invalidée dès que le Worker applique la rotation.** Prévenez le titulaire, préparez la mise à jour des clients, puis installez la nouvelle clé. Remplacer le fichier local n’est pas une rotation ; la commande laisse l’ancien fichier intact. L’identité et les données sont conservées. Cette procédure ne renouvelle pas une identité fixe de `OPENVIKING_EDGE_KEYS`, un jeton Cloudflare ou une clé dédiée Gateway.

## Que faire en cas d’échec ?

| Résultat | Action |
|---|---|
| `401` | Vérifiez l’origine et le fichier. Une clé déjà renouvelée ou révoquée ne fonctionne plus. |
| `403` | Vérifiez le rôle et le compte de la clé. Une identité fixe ne se renouvelle pas par cette API. |
| `409` | L’identifiant peut déjà exister ou être réservé définitivement, ou la clé a changé pendant une rotation. Examinez l’annuaire avant toute nouvelle demande. |
| Code de sortie `2` | Corrigez les arguments ou les permissions locales ; aucun appel n’a été envoyé. Choisissez un chemin neuf. |
| Code de sortie `3` | Arrêtez-vous : la requête a pu aboutir sans que vous receviez ou enregistriez la clé. Il n’y a pas de relance automatique. |

Après un résultat incertain, vérifiez si le compte ou l’utilisateur a été créé avec `list-accounts` ou `list-users` ; l’annuaire seul ne tranche pas l’état d’une **rotation**. Vérifiez quelle clé fonctionne, s’il vous en reste une. Si l’identité existe et la clé émise est perdue, coordonnez une rotation intentionnelle à l’aide d’un autre administrateur autorisé ou de root, vers un nouveau fichier privé ; ne répétez pas la création ou l’inscription. Si le programme a été interrompu de force, traitez aussi tout dossier temporaire `.openviking-admin-*` du répertoire de sortie comme sensible.

Pour les autres routes et les quotas, voyez le [contrat du plan de contrôle](../docs/CONTROL.md). `node scripts/admin.mjs --help` récapitule la syntaxe.

Avec la clé `root`, la même CLI permet d’[importer et tester un fichier de configuration des modèles](FOURNISSEURS.md), sans exposer de clés de fournisseur dans le fichier.
