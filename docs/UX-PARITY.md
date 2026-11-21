# Web Studio Edge — contre-revue indépendante

**8/10 — modifications demandées.** Les corrections clés du parcours User sont confirmées sur le Workerd local. La connexion Root est réelle, mais l’onglet **Users**, ouvert par défaut, plante sur le compte synthétique malgré des réponses API en **200**. Le [rapport historique à 7/10](UX-REVIEW.md) reste inchangé ; son périmètre n’incluait pas ce parcours Root.

## Périmètre et provenance

- **21 novembre 2026, Chrome de ma session**, sur `127.0.0.1:8804` uniquement : lancement, connexion, explorateur et recherche User, lecture de l’onglet d’administration Root et signalement des capacités inactives. Le parent fournit le vrai Workerd / Durable Objects SQLite jetables (`scripts/studio-smoke.mjs`, `tests/support/local-worker.mjs:14–42,55–68`). Le calcul d’embeddings utilise une **fixture de test sans service distant**, pas le fournisseur Workers AI réel. Frise, éditeur, configuration et gestion des comptes hors périmètre.
- **Candidat** : SHA-256 de `dist/studio/index.html` et des octets reçus par Chrome (`GET /studio/index.html` **200**) : `d200cd3ef4c760602a3618064a97ccab9e71c4c563f2582a9b0558d9704bae01`. Entrées chargées : `index-C8rWxiFF.js`, `index-CaEHTXor.css`. L’empreinte locale est inchangée en fin de revue. Les sources du port éclairent les constats ; leurs éventuelles évolutions ne sont pas créditées au bundle testé.
- **Amont** : `volcengine/OpenViking@000f0765d7ec183886fbabbc22e69bc289cc429d` (pin documenté). Référence réelle `upstream/web-studio/` (React/Vite, TanStack Router, Tailwind et i18next), `README.md` amont et `.work/studio/CONTRAT.md` lus comme données ; adaptations `studio-patches/` et `docs/STUDIO.md` relevées séparément. `tar --sort=name --exclude=upstream/.git -cf - upstream | sha256sum` : empreinte identique avant/après, `1f0598ca9243ce364ffb708226830ab6b8ef338afc473db0cf60c7dd0c54fde0` ; c’est un témoin du contenu local, pas une vérification Git du pin. Le SHA-256 de `UX-REVIEW.md` est resté `7168b625e06546634742acd9e620ee2c118053c1ab252589e18e2bdcf6be94bf`.

## Relecture des corrections du 7/10

| Domaine | Verdict borné au rendu observé |
| --- | --- |
| Accessibilité | Champ **Search query** : label persistant, `:focus-visible` et contour solide **2 px** ; recherche soumise par Entrée native. Dans l’explorateur, un seul `main` ; Tab puis Entrée sur « Make pane wider » déplace le séparateur de **32 px**, sans glisser. Les quatre modes de recherche sont des radios natives dans le DOM ; flèches non rejouées. |
| Mise en page | Pas de défilement horizontal du document ni des zones de travail User échantillonnées à **320×700**, **390×844** (émulation Chrome) et **1911×1074** (bureau). Champ, notice, fichier et lien du volet mesurés. Sur l’onboarding à 320, l’action est sous le pli ; ce relevé ne valide pas tous les recouvrements verticaux. Le contrôle de compte Root est trop comprimé à 320 (ci-dessous). |
| Rédaction et i18n | Vide **200**, échec **501** et reprise séparés. Le changement **EN → 中文** via le menu a basculé `html[lang]` vers `zh-CN`, et traduit la notice et l’état vide. Le **401** de connexion propose de vérifier la clé et de réessayer. La panne de la sonde initiale et sa reprise sont traitées séparément en source dans `06-edge-ux.patch` (`contextFailed`, `onRetryContext`) ; cette branche n’a pas été déclenchée. |
| Typographie | Champs d’onboarding et de recherche mesurés à **16 px** à 320 et 390 ; URI complète disponible dans le volet, qui reste dans la largeur utile. Autozoom Safari iOS non testé. |
| Couleurs | Les quatre paires relevées dans l’historique passent désormais en clair et en sombre (table ci-dessous). Il ne s’agit pas d’une mesure exhaustive de tous les états. |
| Finition et mouvement | Volet : Entrée sur la ligne focalisée ouvre le détail et place le focus sur « Open in Filesystem » ; Tab passe à « Close », puis revient au lien ; Échap ferme le volet et rend le focus **à la même ligne**. Réouverture puis Entrée sur le lien : fichier dans un nouvel onglet. Touches natives contrôlées via `isTrusted` ; le point de départ de la ligne a été focalisé via le DOM, pas un parcours intégral depuis la barre d’adresse. Mouvement réduit relu en source (`LoadingHint`, `motion-safe`), pas exercé. |

**Vrai zoom Chrome.** Émulation désactivée avant cinq frappes natives `Ctrl+=`. Le viewport de recherche/volet passe de **1911×1074 / DPR 1** à **955×537 / DPR 2** ; le document est à **955/955 px** (`clientWidth/scrollWidth`), le `main` à **736/736 px**, et le lien du volet reste dans le viewport. À 320 et 390 hors zoom, le `main` est à **320/320** et **390/390**, et le lien du volet reste dans les limites. Retour à 100 % vérifié (`Ctrl+0`, DPR 1). Aucun zoom CSS ni image redimensionnée.

| Paire mesurée dans Chrome (`getComputedStyle`, fonds composés en sRGB) | Clair | Sombre |
| --- | ---: | ---: |
| Notice, 14 px | 14,97:1 | 12,89:1 |
| Placeholder de recherche, 14 px | 5,30:1 | 5,84:1 |
| Titre de l’état vide, 14 px | 15,49:1 | 12,85:1 |
| Conseil de l’état vide, 12 px | 15,49:1 | 12,85:1 |
| Contour de focus du champ sur sa carte | 15,49:1 | 11,52:1 |

Seuils pour ces paires : **4,5:1** pour le texte (WCAG 1.4.3), **3:1** pour le contour (1.4.11). Le conseil vide était mesuré à **1,74:1 / 2,20:1** dans l’historique.

## Traces réseau et séparation des parcours

Statuts relevés dans le navigateur, sans valeurs de clés, identifiants de compte/utilisateur, ni trames brutes. Les POST ci-dessous sont des recherches, pas des mutations.

| Parcours | Réponses et rendu |
| --- | --- |
| Connexion User | `/` mène au Studio puis à l’onboarding ; adresse serveur en lecture seule, de même origine. `GET /health` public **200** ; champ vide traité dans la page, puis saisie volontairement invalide → `GET /health` **401**. Champ marqué `aria-invalid`, alerte associée, focus restauré et saisie conservée. Clé User de test : `GET /health` **200**, `GET /api/v1/fs/ls` **200**, « Connection verified » puis `/studio/home`. |
| Explorateur et liaison | Notice → File Explorer → `resources` → document fictif `navigation.md`. `GET /api/v1/fs/ls` et `GET /api/v1/content/read` **200**. Même document et contenu lors de l’ouverture depuis le volet de recherche. |
| Recherche | `POST /api/v1/search/find` **200** avec le résultat de la fixture ; une recherche sans correspondance distincte renvoie **200**, titre et conseil dans `role=status`, sans alerte. Un ancien lien Search contenant un contexte de session donne un vrai `POST /api/v1/search/search` **501**, alerte « Search failed », diagnostic séparé. Le champ session n’est pas proposé. « Remove unavailable filters and search again » retire le paramètre, remet le focus dans le champ et donne **200** avec un résultat. |
| Capacités du User | `GET /api/v1/system/edge-capabilities` **200** : contrôle, VikingBot, Compile, Watches et OAuth annoncés inactifs pour ce profil. Aucune de ces entrées dans la navigation échantillonnée. Liens directs VikingBot et Compile : notice « Not available on this server » ; aucun appel fonctionnel vers `/bot/` ni `/api/v1/compile` dans ces visites. Le lien direct User vers `/studio/admin/users` ne monte pas de liste et ne lance aucun appel `/api/v1/admin/`. **Ne pas reprendre le 501 historique de la provenance** : le candidat l’annonce active pour User (`src/worker.ts:101–117`, `src/fs/search.ts:50–56`) ; son fonctionnement détaillé n’est pas qualifié ici. |
| Connexion et lecture Root | Onboarding **Administration**, un seul champ de gestion, distinct du champ User. `GET /health`, `GET /api/v1/system/edge-capabilities` et `GET /api/v1/admin/accounts` **200**, contrôle actif. Aucun `fs/ls` observé dans le parcours Root. « Enter Studio » → `/studio/admin` → `/studio/admin/users`. `GET …/accounts/{account}/users`, `GET …/accounts/{account}/groups` et `GET …/accounts/{account}/users/{user}/settings` **200**. Le compte synthétique est bien sélectionné et visible sur l’onglet **Groups**, testé séparément en lecture ; l’onglet **Users** ne rend pas la liste (constat P1). Pas de liens de travail User sur la page Groups Root. |

**Sécurité UI, pas audit d’autorisation complet.** La navigation observée concorde avec les capacités par identité. La règle de présentation n’est pas une frontière de sécurité : le Worker authentifie et route les requêtes indépendamment de l’UI (`src/worker.ts:172–205`). L’en-tête CSP de la réponse HTML porte `frame-ancestors 'none'`. Le contrôle de même origine est visible à la connexion ; stockage de clés et comportement par défaut destinés à ne pas persister en clair sont documentés dans `05-edge-credential-storage.patch` et `docs/STUDIO.md:28,38`, mais non qualifiés par cette recette. Aucun test de contournement, ni conclusion sur l’isolation multi-comptes.

## Constats à corriger

`U/` = `upstream/web-studio/src/` au pin documenté.

| Priorité / domaine | Source | Constat et impact | Correction et critère de sortie |
| --- | --- | --- | --- |
| **P1 / HIGH — UI, raccord du port** | `src/control/settings.ts:144–149` ; `U/shared/api/admin.ts:572–584` ; `U/features/admin/users/components/user-memory-policy-cell.tsx:64–83` ; `U/shared/lib/user-memory-policy.ts:59–63` | La cellule de politique suppose un objet. Le **200** des réglages donne une `memory_policy` nulle ; le navigateur affiche « Something went wrong » / `Cannot read properties of null (reading 'memory_types')`. Le tableau et la navigation disparaissent. Reproduit à l’arrivée avec Root puis après rechargement forcé, sans modifier la fixture. C’est un échec de rendu, pas un refus d’identité ni une vulnérabilité d’accès démontrée. | Dans l’adaptation Edge, rendre « politique non configurée/indisponible » pour la valeur nulle et ne pas proposer une édition que le serveur ne prend pas en charge ; ne pas inventer une politique active. Rejouer l’arrivée Root et le rechargement d’un compte synthétique avec utilisateur et politique nulle : le tableau reste lisible et le reste de l’écran fonctionne. |
| **P2 / MEDIUM — mise en page** | `U/app/layouts/studio-header.tsx:40–42,63–86` (`StudioScopeSwitcher`) | Sur **Groups** à 320, « Switch Account » se comprime à **12×36 px** (contre ~31 px de large à 390 et 105 au bureau) ; la zone de texte est mesurée à **0 px**. L’attribut de titre et le nom accessible restent présents, mais l’identité du compte actif n’est plus lisible en continu. Le test n’établit pas une violation WCAG de taille de cible : espacement et surface effective non vérifiés. | Donner au sélecteur une largeur minimale et un repère de compte lisible, ou déplacer une action secondaire dans le menu aux petites largeurs. Rejouer à 320 et 390, au clavier et au pointeur, sans élargir le document. |

**Limites et nettoyage.** Pas de build, de campagne Vitest, de Safari/appareil physique, de lecteur d’écran, de RTL, de panne réseau imposée, d’édition/import ou de gestion de clés/comptes. Aucun appel à des services de production, aucun déploiement ni opération Git. Uniquement les données navigateur de l’origine de test effacées et les onglets correspondants fermés ; zoom et émulation restaurés. Aucune capture, valeur de clé consignée, ni changement au produit, au serveur ou aux fixtures par le relecteur. Ce fichier est le seul écrit du mandat dans le projet.

**Note : 8/10.** Parcours User et reprises **3,5/4** (lecture/recherche et 401/501 démontrés ; échec de la sonde seulement relu) ; accessibilité, contraste et reflow **2,5/3** (correctifs User confirmés, repère de compte comprimé à 320) ; séparation et capacités affichées **1/1** sur les cas essayés ; administration **1/2** (connexion et Groups réels, Users inutilisable). **Modifications demandées sur le candidat local ; pas de feu vert de production.**

## Addendum final — contre-visite P1/P2 sur 8808, 21 novembre 2026

**8/10 maintenu — P1 et P2 non levés sur l’artefact servi.** Contre-visite indépendante dans mon Chrome, limitée à la lecture Root de **Users** et à la mesure du sélecteur de compte sur **Groups**, où P2 avait été constaté. Workerd jetable fourni par le parent, identité synthétique, aucune action mutante côté serveur.

**Artefact vérifié.** `GET /studio/index.html` **200** sur `127.0.0.1:8808` et `dist/studio/index.html` donnent tous deux `bc1b9a2ce087244b06637e25723c655e466cef029a42bed8443541f8d54e1581` (SHA-256). L’HTML chargé référence `index-fYsjxuVP.js` et `index-CaEHTXor.css` ; ces deux fichiers ont aussi des empreintes identiques entre la réponse HTTP et le disque. La vérification d’artefact menée en parallèle par le parent n’est pas utilisée comme preuve de rendu.

| Constat | Rejeu sur le candidat de 8808 | Verdict |
| --- | --- | --- |
| **P1 — Users Root** | « Enter Studio » mène à `/studio/admin/users`. Le navigateur relève **200** sur `GET /health`, `GET /api/v1/system/edge-capabilities`, `GET /api/v1/admin/accounts` et les lectures `…/accounts/{account}/users`, `…/groups`, `…/users/{user}/settings`. Le dernier `200` contient bien une `memory_policy` nulle. La page retombe sur « Something went wrong » et `Cannot read properties of null (reading 'memory_types')` ; ni tableau ni libellé « Memory policy not available ». Même résultat au rechargement forcé. | **Bloquant reproduit.** La garde `null` figure dans la source (`studio-patches/06-edge-ux.patch:285–298`), mais le comportement corrigé n’est pas constaté sur l’artefact. |
| **P2 — reflow du sélecteur de compte** | Sur `/studio/admin/users/groups`, pour le même compte de test, le document ne déborde pas. « Switch Account » reste à **12×36 px** à **320×700** (libellé **0/40 px**, largeur visible / nécessaire) ; le centre du rectangle ne touche pas le bouton au hit-test DOM. À **390×844** : **31×36 px**, libellé **1/40 px**. Au bureau **1911×1074** : **105×36 px**, libellé **47/47 px**. L’en-tête reste en `flex` aux petites largeurs et le DOM n’a ni la classe de grille mobile de l’en-tête ni la largeur minimale du sélecteur prévues par `06-edge-ux.patch:63–89,376–397`. | **Non levé.** Pas d’interaction clavier/pointeur ni de changement de compte lors de ce rejeu ; mesures du rendu seulement. |

**Conclusion.** Vérifier l’inclusion des deux corrections dans les modules et styles effectivement servis avant un nouveau rejeu : l’empreinte de l’index ne suffit pas à prouver leur présence. Aucun point récupéré sur **administration (1/2)** ni sur **accessibilité/reflow (2,5/3)**. Les autres rubriques sont reprises de l’historique, **non rejouées**. Onglet de test fermé, données de cette seule origine effacées et émulation désactivée. Aucun build, changement de code, de fixture ou de serveur ; le rapport initial est conservé à l’identique.

## Addendum — candidat corrigé 8810, 21 novembre 2026

**P1 et P2 levés sur le candidat corrigé.** Le `8/10` et les observations ci-dessus restent attachés aux candidats antérieurs ; le parent confirme que 8808 était **pré-correctif**. Sur le Workerd jetable `127.0.0.1:8810`, `GET /studio/index.html` **200** et `dist/studio/index.html` donnent tous deux le SHA-256 `9fd48ee49904e3e443c8c9a14d06756499255189c51e3fd6bce3fce50550c00d`. Entrées du document chargé : `index-CkuyN7nG.js`, `index-BL32sqvw.css`. Seule la clé Root synthétique de 8810 a été utilisée, dans Chrome de ma session.

- **P1 — Users Root.** Après l’ouverture de **Groups**, clic sur **Users**, puis rechargement forcé confirmé par le navigateur. La ligne synthétique et son libellé « Memory policy not available » sont rendus avant et après rechargement, sans plantage ni commande d’édition de la politique sur cette ligne. `GET …/accounts`, `…/users`, `…/groups` et `…/users/{user}/settings` : **200**. Les réglages renvoient toujours une politique mémoire nulle : le cas qui plantait est bien celui qui a été rejoué.
- **P2 — sélecteur de compte.** Sur **Groups** et **Users**, à **320×700** comme à **390×844** en émulation Chrome, le bouton mesure **96×36 px**, son libellé est entièrement visible (**40/40 px**) et son centre touche le contrôle au hit-test. Document et `main` sans débordement horizontal (**320/320**, **390/390**). Sur **Groups**, l’en-tête passe bien en grille. Pas de changement de compte ni de recette clavier complète du sélecteur.

**Appréciation du candidat 8810 : 9,5/10 dans le périmètre du rapport.** Administration **2/2** (+1), accessibilité/reflow **3/3** (+0,5) pour les cas échantillonnés. Les sous-notes **3,5/4** du parcours User et **1/1** de la séparation des profils et des capacités restent historiques, non rejouées ici. Aucun point bloquant restant sur P1/P2 ; pas de qualification de production. Aucune mutation de données de test ; onglet fermé, données navigateur de cette seule origine effacées et émulation restaurée.

## Addendum — staging `build-pqubwy2c`, 21 novembre 2026

**Recette partielle : parcours User/Admin/Root de base validés ; refus réel de Gateway Keys confirmé, scénario d’émission non qualifié. Aucun reçu de promotion.** Les **1 939 tests originaux** et les **28 Edge** (deux passages) sont les résultats du parent rapportés dans `.work/studio/GATEWAY-KEYS.md` ; ils n’ont pas été rejoués ici. Le score et les preuves historiques de 8810 ne sont pas transférés à ce staging.

### Identité de l’artefact et environnement

- Entrée `.work/studio/logs/build-pqubwy2c/dist` : index SHA-256 `f6ff17c7ed9e11c3b47533c7699fdeb45410b09f5f9d3cfaf183bf7feb527166`, manifeste SHA-256 `1a7faf719bc173c5701df7adb25513eb0483f393c1cbc109eb56fab7db6d9a9c`. **614/614 fichiers** vérifiés individuellement au manifeste, source puis copie privée, avec inventaire exact sans lien symbolique. La copie, jamais `dist/studio`, a alimenté le binding d’actifs en lecture seule. L’index actif de `dist/studio` est resté à `9fd48ee4…` au contrôle final.
- **Preuve du corps HTTP :** dans mon Chrome, `GET /studio/` et `GET /studio/index.html` sans cache ni identifiants donnent chacun **200**, `text/html`, **1 718 octets**. SHA-256 calculé sur `response.arrayBuffer()` : `f6ff17c7ed9e11c3b47533c7699fdeb45410b09f5f9d3cfaf183bf7feb527166` pour les deux. Entrées chargées : `index-ByiorU8W.js`, `index-DfmE3u-2.css`.
- Workerd natif sur `127.0.0.1:60815`, SQLite jetable et identités fictives. Socket loopback d’entrée préouvert et transmis à Workerd ; Landlock (actifs en lecture seule, état en scratch) et seccomp (création de sockets, `connect` et `bind` refusés), sorties Worker bloquées. Seuls les embeddings sont fictifs, avec l’algorithme de la fixture locale ; aucune génération activée. L’adaptateur d’actifs ne change que le type MIME, pas le corps. APIs et décisions Gateway du vrai Worker, non interceptées.

### Contrôles Chrome

| Parcours | Observation |
| --- | --- |
| **User** | Formulaire vide : champ repris au focus, `aria-invalid=true`, alerte associée via `aria-describedby`. Connexion synthétique → accueil → explorateur ; `GET /api/v1/content/read` **200** et texte de `navigation.md` visible. Recherche Find lancée par Entrée native, **200** avec résultat de fixture, contour de focus **2 px**. Entrée native sur la ligne focalisée ouvre le volet et place le focus sur le lien de l’explorateur. |
| **Admin de compte / Root** | Les deux profils atteignent **Users**, avec tableau rendu et lectures de gestion **200**. Après rechargement forcé en Root, la ligne fictive et « Memory policy not available » restent visibles ; le **200** des réglages contient bien une politique mémoire nulle. Le sélecteur de compte Root s’ouvre par Entrée et se ferme par Échap, avec retour du focus au bouton ; événements natifs confirmés, aucun changement de compte. |
| **Reflow** | À **320×700**, **390×844** et **1911×1074**, pas de débordement horizontal du document échantillonné. Le lien du volet User tient dans le viewport ; le sélecteur Root fait **96×36 px** aux deux petites largeurs, texte entièrement visible (**40/40 px**). L’écran de refus Gateway Keys est également testé à 320 et 390. |
| **Gateway : refus rendu** | Aucun lien Gateway dans les navigations échantillonnées. Ouverture directe de `/studio/admin/gateway/keys` avec User, Admin de compte et Root, et de `/studio/admin/gateway/` avec Admin : « Not available on this server », sans commande ni dialogue d’émission, ni appel `/gateway/*` déclenché par ces pages. Le **200** de la route HTML ne vaut donc pas accès à l’API. Sur Admin et Root, le refus est rendu dans une région `aria-live="polite"` ; lien de reprise observé sur Admin. L’annonce a été vérifiée dans le DOM, pas à l’oreille avec un lecteur d’écran. |

### Gateway : frontière observée sur le vrai Worker

Sondes HTTP locales **en lecture seulement**, distinctes des visites Chrome et sans afficher de valeurs de clés ni de corps bruts. `GET /api/v1/system/edge-capabilities` donne **200**, avec Gateway inactif pour chacun des trois profils ; le contrôle de compte est inactif pour User et actif pour Admin/Root. Ceci concorde avec `src/worker.ts:117–134` : la capacité Gateway dépend de l’identité et du binding de génération activé.

| GET Gateway | User / Admin de compte | Root |
| --- | --- | --- |
| `/gateway/admin/access` | **200** ; `can_issue_for_others=false`, `dedicated_gateway_keys=false` | **403** |
| `/gateway/admin/overview` | **200** en lecture | **403** |
| `/gateway/admin/keys` | **501** `gateway_keys_unavailable` | **403** `PERMISSION_DENIED` |

Le **501** des clés est un blocage distinct de la visibilité du menu ou de l’identité Root : `src/gateway.ts:28,56–63,79–81` désactive les clés dédiées. **Aucun scénario d’émission autorisée en Chrome** : aucun harnais navigateur fictif déjà adapté n’a été identifié dans le lot fourni ; les tests de composant en jsdom décrits par le parent restent une preuve fictive séparée. L’attente et l’annonce d’arrivée de l’annuaire, la sélection du destinataire, le maintien du focus et l’envoi dans ce dialogue ne sont pas qualifiés ici. Aucun droit ou flag n’a été forcé pour les atteindre.

**Limites et clôture.** Pas de preuve de zoom à 200 % pour ce SHA, ni de confirmation du retour de focus du volet User à la fermeture sur cette passe ; le retour de focus du sélecteur Root, lui, est confirmé. Pas de service distant, de promotion ou de reçu `passed:true`. Aucun changement Studio/Worker ni opération Git ou déploiement. Onglets de test fermés, données de cette seule origine effacées, zoom revenu à 100 %. Seul mon Workerd jetable a été arrêté ; port fermé, scratch et clés synthétiques supprimés.
