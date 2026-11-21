# openviking-cloudflare

Portage natif de [OpenViking](https://github.com/volcengine/OpenViking) sur Cloudflare Workers. Le Worker ne délègue pas à un serveur OpenViking, à un proxy ni à un conteneur. Il sert Web Studio d’origine sur `/studio/`. Le plan de données, le contrôle des comptes et les autorisations OAuth séparées utilisent des Durable Objects SQLite. **La parité complète n’est pas encore attestée ; aucune mise en ligne.**

Référence : `000f0765d7ec183886fbabbc22e69bc289cc429d`. Licence : [AGPL-3.0](LICENSE). Les scripts construisent l’interface à partir du checkout amont épinglé et des adaptations sous `studio-patches/`. Ne pas distribuer le binaire Studio seul : conserver les notices d’origine et rendre le code correspondant accessible conformément à l’AGPL avant exposition réseau publique.

## Démarrer en local

Sous Linux, depuis la racine d’un nouveau clone, récupérer l’amont séparément et le laisser intact. Utiliser Node 22 (voir [les prérequis et la sélection du binaire](docs/STUDIO.md)) :

```sh
git clone --no-checkout https://github.com/volcengine/OpenViking.git upstream
git -C upstream checkout --detach 000f0765d7ec183886fbabbc22e69bc289cc429d
npm ci --ignore-scripts
npm run check
npm run build
npm test
```

`npm run build` exécute le prébuild du Studio et écrit son résultat dans le répertoire de staging indiqué par le lanceur, sans remplacer `dist/studio/`. `--bundle-only` ne qualifie ni ESLint/i18n ni les suites originales séparées. Le [rapport Studio](docs/STUDIO.md) détaille les cohortes. Les dépendances installées, les paquets de sortie et les preuves locales sous `.work/` ne sont pas versionnés.

Pour la vérification UI locale, `node scripts/studio-smoke.mjs 8797` sert les actifs de `dist/studio/` sur une instance **jetable sur loopback**. Pour tester un build stagé sans remplacer le Studio, lancer ce script par chemin absolu depuis un dossier jetable qui présente le build stagé sous `dist/studio/`. Ouvrir `/studio/` et utiliser la clé synthétique créée pour ce port dans `.work/browser/synthetic-8797.key` du dossier de lancement. Sans actifs, utiliser `--api-only`. La base SQLite est réelle mais les embeddings sont fictifs. Aucun compte Cloudflare n’est nécessaire.

Pour tester le **bundle d’empaquetage** en local, `npm run dev` utilise la config Wrangler avec stockage local sur loopback. Définir `OPENVIKING_EDGE_KEYS` dans `.dev.vars` (non versionné), tableau JSON d’entrées `{key, accountId, userId, agentId, role}`. Générer des clés aléatoires de 32 octets ou plus et ne jamais les ajouter au code. `root` accède au [plan de contrôle](docs/CONTROL.md) sans accès aux fichiers ou sessions des comptes ; une clé utilisateur peut se connecter au Web Studio de travail. Les en-têtes d’identité ne peuvent modifier ni le compte, ni l’utilisateur, ni l’agent de la clé. Utiliser `X-API-Key` ou `Authorization: Bearer`, pas les deux. Sans configuration valide, les routes privées restent fermées. Utiliser une instance jetable et des identités fictives pour toutes les recettes.

Wrangler ne démarre pas avec le binding Workers AI en mode strictement local. `npm run dev` dérive donc un profil **sans IA et sans compte Cloudflare**, sans modifier `wrangler.jsonc`. L’API d’IA répond indisponible au lieu d’accéder à un service distant. `node scripts/wrangler-smoke.mjs <port-libre>` vérifie ce profil sur une base jetable ; le harnais Studio séparé permet de tester les parcours IA avec fixtures.

Le modèle du Worker est `@cf/baai/bge-base-en-v1.5`, 768 dimensions, via **Workers AI**, sans repli lexical automatique. Indexer ou rechercher peut transmettre du texte de ressources ou de requête à ce service. Sans binding utilisable, l’opération sémantique échoue explicitement ; ne pas activer l’inférence distante pour des données sensibles sans autorisation. Les limites applicatives sont de 128 vecteurs/minute et 8 192/jour par compte, avec sous-quotas de 64/minute et 4 096/jour par utilisateur, en plus des quotas Cloudflare. Aucun déploiement ni trafic IA distant n’est requis pour les tests locaux.

Fonctions opt-in, non vérifiées sur Cloudflare distant :

| Configuration | Effet |
|---|---|
| `OPENVIKING_EDGE_GENERATION=1` | Active la génération pour la mémoire de session, VikingBot, Compile, Rules et Gateway. Les tests isolent le binding ; aucun traitement de contenu par un fournisseur réel n’est attesté. |
| `OPENVIKING_EDGE_DOCUMENT_CONVERSION=1` | Autorise le binding toMarkdown à recevoir des PDF, documents Office et images pris en charge, bornés à 1 Mio. Staging Markdown uniquement ; pas de stockage ou d’affichage du fichier actif d’origine. |
| `OPENVIKING_EDGE_TEXT_SOURCES` | Tableau JSON de **sources HTTPS exactes explicitement admises** pour importer du texte et activer le suivi périodique. Pas de requête vers une adresse imposée par un modèle ni d’authentification d’un tiers. |
| `OPENVIKING_EDGE_MCP=read` ou `read-write` | Expose la famille MCP bornée à l’espace autorisé. Aucune commande système ni outil réseau arbitraire. |
| `OPENVIKING_OAUTH_ISSUER` et `OPENVIKING_OAUTH_CLIENTS` | Active le consentement pour des clients enregistrés et un périmètre de lecture explicite. Voir [les conditions](docs/POLICIES.md). |
| `OPENVIKING_EDGE_AUDIT=0` | Désactive le journal et les agrégats applicatifs. Le journal actif ne stocke pas les corps, URI privées de ressources, en-têtes de clés ou requêtes de recherche. |

## Vérification et périmètre

- [Rapport de portage et matrice de parité](docs/PORTAGE.md).
- `npm run test:studio:original` exécute la suite du Web Studio conservée dans le checkout ; `npm test` exécute les tests du port dans workerd. Les rapports distinguent UI originale, référence Linux, Workerd local et Cloudflare réel.
- `python3 scripts/inventory-upstream.py` produit l’inventaire statique des routes FastAPI, sans importer le serveur amont. Il ne compte pas les routes mountées dynamiquement.
- L’API expose `/health` et `/ready`, et le résultat privé de `/api/v1/system/edge-capabilities` indique explicitement `parity: partial`. Une opération absente répond en erreur au lieu de simuler un succès. Ce n’est pas encore un remplacement d’une installation OpenViking existante ; pas de réutilisation automatique de ses données.
