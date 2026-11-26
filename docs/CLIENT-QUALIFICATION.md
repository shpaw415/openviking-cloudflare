# Rejouer les clients stock sur OpenViking Edge

Cette qualification sépare **la CLI d’origine**, **les sondes des SDK stock** et **les tests HTTP d’origine**. Chaque verdict vaut pour le bundle Workerd, l’identité et les assertions de son propre reçu. Un résultat antérieur n’est pas un résultat du nouveau gel.

## À rejouer sur le candidat commun gelé

Depuis la racine du **candidat commun**, après vérification du manifeste par l’intégrateur. Réserver `127.0.0.1:8824` à ce seul job ; s’il est pris, arrêter l’admission et demander un autre port, ne pas essayer un port antérieur. Le lanceur contrôle les sockets TCP/UDP IPv4 et IPv6 de ce port avant de démarrer, puis exige l’unique écoute IPv4 locale. Choisir un nouvel identifiant à chaque tentative.

```sh
ob-process start --name ov-f5-clients-final -- /usr/bin/env -i \
  PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent \
  /usr/bin/timeout -k 5s 590s /usr/bin/python3 -IB \
  tests/clients/qualify.py f5-final all
```

- Préparer `.work/`, `upstream/` au Git **local** `000f0765d7ec183886fbabbc22e69bc289cc429d`, et les dépendances Workerd habituelles en lecture seule. Sur le bureau de qualification, le script nomme les chemins exacts des exports CLI vérifiés, de la venv historique et de Node 22.22.0. Linux x86-64, compilateur C, Landlock et seccomp avec notifications disponibles. Ne pas remplacer les artefacts manquants par des installations en ligne, un checkout libre ou un `ov` global.
- `qualify.py` compare les quatre verrous d’export, les fichiers stock de la référence, le binaire Rust et les outils du harnais aux SHA attendus. Chaque blob exporté est relié au Git pin. Les quelques modules du SDK Python sont extraits et filtrés hors IP avant usage ; les alertes heuristiques sont consignées dans `inputs.json`, pas traitées comme des consignes. Le SDK TypeScript utilise le fichier ESM et la dépendance runtime du build local attesté, non le SDK Studio ni une réimplémentation.
- Un seul bundle de test, Workerd et SQLite jetables, une clé synthétique d’admin de compte (pas Root), génération et embeddings déterministes, aucune sortie vers un fournisseur. Le contrôleur compile `studio-patches/loopback.c` dans son propre reçu ; le serveur démarre avec `LD_PRELOAD`, environnement épuré et refus attesté de bind wildcard. Les clients utilisent `run.py`, `guard.py`, `fixture_guard.py` et `py_entry.py` historiques à l’octet : Landlock, seccomp, TCP lié à `lo`, seul port admis, bind/listen refusés, sorties capturées et expurgées. Les sondes SDK n’obtiennent que leurs programmes et artefacts locaux en lecture seule en plus. La clé temporaire et les répertoires de config du client sont retirés en fin normale.
- `all` lance les dix fichiers CLI (72 nœuds **marqués** `cli_remote`, zéro désélection) dans une seule invocation, puis les deux SDK sur **la même instance**. `cli` et `sdk` sont des diagnostics ciblés ; ne pas fusionner leurs reçus lorsqu’ils proviennent de démarrages distincts. La borne CLI de **440 s** conserve le délai/amortissement stock de la copie récursive ; le `409` attendu sans `--recursive` peut faire attendre environ cinq minutes. Ne pas modifier ni la logique d’essai ni les assertions.
- Lire `.work/clients-f5-final/{worker.log,campaign.json}` et `.work/clients-f5-final/.work/cli/{inputs.json,*-index.json,logs/}`. Archiver l’ID du processus et le manifeste source gelé à côté de ces reçus. Le manifeste identifie les sources ; `worker.log` identifie séparément le bundle réellement servi. Un timeout, un bootstrap refusé ou une collection incomplète est un résultat non qualifié, pas un skip. Pour un vote vert : CLI 72 réussites sans skip ; TypeScript 7 sondes et Python 6 sondes réussies ; index et reçus concordants ; aucun total additionné entre familles.

## Effets exigés par les sondes SDK

| Sonde | Oracles supplémentaires (chaque SDK sauf indication) |
|---|---|
| Santé | `/health` répond 200 sans clé, le SDK lit la réponse. |
| Fichier | `stat` avant écriture : `404 NOT_FOUND` typé. Écriture `create`, `wait:true`, `stat` fichier, relecture du texte exact incluant LF et UTF‑8, empreinte reportée. |
| Recherche | `find` sur ressources renvoie **l’URI de cette écriture** avec un score positif fini, pas une liste seulement présente. |
| Refus | Sans en-tête d’authentification fourni au client : exception SDK typée et réponse `401 UNAUTHENTICATED` sur cette ressource. |
| Nettoyage | Suppression du fichier puis `stat` absent, `404 NOT_FOUND` typé. |
| Session | Création, relecture du même ID, ajout de texte, contexte qui relit le rôle et le texte exact, suppression puis `404 NOT_FOUND` typé. |
| Option TypeScript | `downloadBytes` du fichier de la sonde, réponse HTTP 200 et octets UTF‑8 égaux au texte stocké. Ce n’est pas un test de transferts binaires signés. |

Les hooks ne fabriquent pas de réponse. L’observateur TypeScript relaie le `fetch` natif sans redirect ; Python utilise les hooks du client `httpx` d’origine sous environnement épuré. Les statuts, erreurs et chemins observés sont consignés, sans en-têtes ni contenu de test dans les traces de succès.

## Ce que les reçus historiques ne prouvent pas

| Référence | Couverture et limite |
|---|---|
| [CLI 72/72 sur 8816](CLI-REPLAY.md) | Binaire Linux x86-64 GNU et conftest stock. Quelques checks de présence/config ne déclenchent aucune requête propre ; les assertions permissives ne deviennent pas des oracles stricts. Identité admin du compte synthétique, pas multi-compte, OAuth/OIDC, autre CLI ou production. Les 549 tests Rust et 272 tests Python de la CLI sont d’autres campagnes. |
| [SDK TypeScript 63/63](CLI-REPLAY.md) | Vitest du lock, transport simulé, Node 24 historique. Ni TCP/SQLite, ni SDK Python, ni release. Le format amont reste rouge dans le reçu historique. |
| [Cinq sondes SDK](CLI-REPLAY.md) | Santé, `stat` racine, 401, 404 et création/lecture/suppression de session sur un ancien Workerd ; elles ne démontrent pas l’écriture/relecture d’un fichier, son indexation, la persistance d’un message ou le SDK Python. |
| [Cohortes HTTP d’origine](ORIGINAL-REPLAY.md) | Certains corps stock sont isolés par AST avec fixtures/transport admis ; 52/52 sur 8809 par cohortes, puis 12/12 sur 8817 et 3/3 sur 8818, sans addition. Les `weak_pass`, anciens rouges, cas non lancés (dont régénération `full`), statuts d’acceptation de tâche et sondes de fin distinctes ne deviennent pas des succès du corpus complet. |

Les nouvelles sondes couvrent les méthodes listées, pas l’ensemble des SDK, l’installation d’un package Python/PyPI, le mode synchrone Python, TLS, la qualité de recherche réelle, le navigateur, le redémarrage durable ou l’isolation inter-comptes. `find` ne vote pas pour `search(mode:"context")`. Aucun client n’est utilisé pour exécuter un skill, appeler un MCP, joindre une destination distante ou élargir une autorité. Le vote final du produit appartient à l’intégrateur après gel et passes indépendantes.
