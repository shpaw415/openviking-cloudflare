# Contrats Edge livrés et prérequis opérateur

Référence : `volcengine/OpenViking@000f0765d7ec183886fbabbc22e69bc289cc429d`. Ce port utilise un Worker TypeScript et des Durable Objects SQLite ; il ne démarre pas de serveur Python et ne charge pas d'extension Linux. La compatibilité porte sur les contrats adaptés ci-dessous, pas sur une identité de pertinence modèle ou de moteur natif.

## Usages branchés

| Famille | Réalisation native et règle d'activation |
|---|---|
| Identités, données, ACL | Comptes et membres, clés gérées/rotation, groupes et autorité au dernier effet ; Root reste contrôle seulement, OIDC et OAuth gardent les scopes décrits dans leurs contrats. |
| Fichiers, recherche et ressources | Arborescence, écritures atomiques et batch, tags, résumés dérivés, index et filtres sous ACL. Imports texte et conversions via le binding existant. Une source non admise ne provoque pas de connexion de secours. |
| Web et sources documentaires | HTML courant et parcours borné, RSS/Atom, sitemaps, documents/collections GitHub épinglés, Feishu Docx/Sheets/Bitable/Wiki/Drive approuvés, TOS GetObject/collections. Le service natif privé contacte seulement les origines et objets préprovisionnés. Les clés fournisseur restent dans ce service séparé ; les copies R2 ne sont pas présentées comme des lectures en direct. [Montage](WEB-NATIVE.md). |
| Suivi de sources | Registre, alarmes, permission fournisseur revalidée et protection contre les éditions manuelles ; publication/index effectifs et reprise après redémarrage. Les montages sont opérateur, pas des URL d'un modèle. |
| Gateway | Chat, Responses, Messages ; transports sortants Chat ou natifs explicitement inventoriés, SSE causal et annulation, images/documents/pièces privées, audio WAV Chat, options typées, format JSON et comptage Messages. Outils client inertes et une lecture de données locale consentie avec ACL/révision vérifiées avant chaque effet. [Contrat](GATEWAY-NATIVE-HTTP.md). |
| Assemblage de contexte | Liste ou contexte par budget/quotas/détail, recherche sémantique ou mots-clés, reranker déjà autorisé, approfondissement d'événements, digest opt-in validé avec citations, déduplication durable dans la session du même compte/membre/agent et même incarnation. [Contrat](SEARCH-CONTEXT.md). |
| Sessions et mémoire | Messages/archives, commit durable, seuil/inactivité, rétention/checkpoints et budgets, options compatibles de raisonnement ; pas de permission d'écrire les mémoires d'un autre pair. [Contrat](RUNTIME-F5.md). |
| Compile et Rules | Définitions, jobs/annulation, résultats indexés, consolidation autorisée, Skill généré inerte et validé, alarmes et récurrences bornées/fuseaux documentés. Aucun moteur système ou code importé exécuté. [Contrat](RUNTIME-F5.md). |
| MCP | Transport authentifié et catalogue, opérations Data autorisées, registres et contexte local dynamique sous la même ACL. Les modes avancés restent derrière le montage opérateur et la mutation reste interdite au mode lecture. La recherche avancée réutilise la même implantation et les mêmes providers que l'API Data, pas une réponse simulée. |
| Privacy | Projections expurgées, scan borné, réparation des textes admissibles et réindexation atomique sous autorité ; pas de `reveal` de valeurs, pas de modification d'un Skill ou texte structuré qui contournerait son validateur. |
| Snapshots et archives | Historique, branches, ignore, restauration et OVPack ; sauvegarde RPC multi-comptes à froid v1/v2/v3, pièces privées et états portables scellés, reprises et journal de publication. Les secrets/identités/grants/jobs actifs ne migrent pas et les formats non supportés sont refusés. [Contrat](INSTANCE-BACKUP.md). |
| Studio et clients | Web Studio d'origine exporté au pin, patchs ciblés de capacités/focus/récupération et signal de limitation d'import. Les tests d'origine sont intacts ; tests du port et sondes SDK sont distincts. La CLI/SDK réelle se rejoue sur un seul bundle selon [CLIENT-QUALIFICATION.md](CLIENT-QUALIFICATION.md). |

## Ce qui n'est pas une promesse du port

- Il n'exécute ni commande système, Skill importé, serveur MCP arbitraire, ni outil de navigation donné par un modèle. Ces refus sont des frontières d'autorisation, pas des fonctionnalités simulées.
- Aucun crawl libre ou proxy d'URL, transfert de credentials utilisateur à un tiers, discovery d'IdP ou droit d'écriture inter-pairs implicite. Des identités externes, canaux et sources supplémentaires nécessitent leur propre registre/permission et montage opérateur.
- La recherche visuelle exige un encodeur visuel ; les moteurs Linux, analyseurs AST et tokenizers natifs ne sont pas incorporés. Le comptage natif est attribué au provider configuré, pas à un moteur local prétendument exact.
- Les transferts Gateway scellés ne sont pas un alias de tous les tokens d'upload/download Filesystem amont. Les formats de média, WebDAV, vecteurs OVPack et options fournisseur ont leur périmètre explicite dans les documents de famille ; un mode non pris en charge rend un refus typé, jamais une réussite vide.
- Les plafonds de pages, documents, octets, tokens, temps et récurrences sont des limites du contrat Edge. Aucune équivalence des algorithmes de pertinence, de toute grammaire de calendrier, de toutes les variantes de SDK ou de toutes les APIs fournisseur n'est revendiquée.
- Un test synthétique de montage ne prouve ni ses secrets réels, ni son WAF/Access, ni les permissions d'un tenant fournisseur ou sa disponibilité distante. Les montages optionnels et le dépôt privé ne sont pas activés par un push de code public.

Les reçus de qualification identifient séparément sources, bundle, transport, données/permissions de fixture, cas d'origine et tests ajoutés. Ils doivent correspondre au même gel avant publication. Ne pas additionner des campagnes ou attribuer les compteurs d'un ancien gel à des sources nouvelles.
