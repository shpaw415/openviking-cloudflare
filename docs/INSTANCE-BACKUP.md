# Sauvegarde applicative d’instance Edge

Cette sauvegarde est distincte du [backup par compte](ARCHIVES.md) et d'un dump
Cloudflare/SQLite. Elle compose les archives Edge-v1 des Workspaces de **tous**
les comptes provisionnés de la topologie admise. Elle ne sauvegarde ni la
machine ni une installation amont et n'exécute aucune tâche. Sur une instance
normale, rien n'est monté par défaut et les refus publics F3 restent inchangés.

## Autorité et montage

- Seul `InstanceBackupOperator`, un *named entrypoint* Workers RPC sans `fetch`,
  reçoit les appels. Le consommateur doit disposer d'un binding privé explicite,
  jamais d'un proxy HTTP ou d'un outil Data/OAuth/MCP. Aucun changement
  `wrangler.jsonc`. Les permis internes authentifiés durent au plus 30 s et
  distinguent opération, instance locale et, côté Workspace, compte, capture,
  archive et plan selon l'étape. Control et Workspace comparent leur identité
  physique à celle du binding prévu.
- Le montage exige `OPENVIKING_EDGE_INSTANCE_BACKUP_KEY` (HMAC, 256 bits
  aléatoires hexadécimaux, approvisionné hors bande sur cette paire; différent
  de toutes les clés Edge Data locales et du HMAC de sauvegarde F3), plus
  `OPENVIKING_EDGE_INSTANCE_BACKUP` : objet exact à quatre champs
  `mode`, `instance_id`, `peer_id`, `peer_control`. `mode` vaut `source` ou
  `standby`; les deux identifiants d'instance sont différents, aléatoires et
  longs de 128 bits (hex). `peer_control` est l'ID physique du Control pair
  (`identify()` le fournit au seul binding privé). La paire est réciproque;
  même Control physique ou réutilisation du Workspace source côté secours
  sont refusés. Ce n'est pas une archive restaurable sur une cible arbitraire.
- L'instance doit dédier ses namespaces Control et Workspace. Support : 1 à 8
  comptes fixes, tous consentants via `OPENVIKING_EDGE_BACKUP_POLICY`, chacun
  avec sa propre époque `scope_id` non recyclée et le même nom et la même
  époque sur la paire. Chaque Control **doit déjà** contenir le registre fixe
  exhaustif, approvisionné par l'opérateur avec des clés propres à sa destination.
  Pas d'identité créée par l'archive. Le registre SQLite, les comptes des clés
  fixes et les opt-ins doivent correspondre exactement; registres gérés,
  réservations retirées, opt-ins incomplets et réglages utilisateurs dans Control
  sont refusés avant de contacter les Workspaces. La preuve HMAC par compte lie
  les triplets provisionnés `(utilisateur, agent, rôle)` sans les sérialiser en
  registre (ni dériver la moindre empreinte de credential). Les chemins privés et
  enregistrements applicatifs contiennent les propriétaires nécessaires au routage.

**Quiescence obligatoire.** Arrêter et drainer la version antérieure avant de
monter la source en mode `source`; ne pas partager les DO avec un autre bundle,
un écrivain direct, une instance OAuth déjà servie ou une ancienne version
encore accessible. Ce n'est pas un mode sauvegarde à chaud, un *rolling update*
ou un mécanisme qui prouve à lui seul l'arrêt des anciennes versions. Le bundle
en maintenance ferme le dispatch et les écrivains Control/Workspace, y compris
le RPC F3 et les alarmes productives. L'alarme déjà livrée à la source est
différée sans exécuter sa tâche. Garder source, variables et namespaces stables
pendant la capture. Le secours doit être une nouvelle instance, Workspace sans
schéma applicatif (même une initialisation antérieure sans fichiers est refusée),
Control sans état sauf l'annuaire fixe. Approvisionner les sièges en environnement
isolé (p. ex. une lecture Root de la liste des comptes matérialise les sièges
fixes), sans router de trafic ni appeler `/ready` avant de monter `standby`.

## Archive et contenu

`openviking-instance-backup.zip`, ZIP32 STORE. `capture()` reste le profil
`edge-v1` (version 1, au plus 12 090 112 octets) et garde son refus des espaces
avec des lignes de pièces Gateway. L’appel privé
`capture('edge-v1-attachments')` utilise la version 2 ci-dessous;
`capture('edge-v1-portable-state')` sélectionne explicitement la version 3.
Les anciens paquets v1/v2 et leurs journaux restent lisibles; aucun changement au backup F3
par compte ni aux formats intérieurs OVPack v3 et Edge-v1.

| Membre | Contenu |
|---|---|
| `inventory.json` (≤ 64 Kio) | `kind: openviking.instance-backup`, `format_version: 1`, `profile: edge-v1`, identifiant de capture, paire logique/physique et inventaire ordonné exact. Chaque compte possède un ID source physique, une preuve de périmètre, un sceau de membre ACL2 et un descripteur. |
| `inventory.hmac` | HMAC hexadécimal SHA-256 de l'inventaire (via son SHA-256), contextualisé par la paire et une étiquette indépendante. |
| `configuration.json` (≤ 16 Kio) | Projection validée des paramètres cluster/compte F3 : langue, ACL toujours activée et évolution toujours désactivée aux scopes admis. Ni configuration brute ni fournisseur. |
| `accounts/<id>.zip` | En v1 (≤ 1 500 000 octets), le vrai export Workspace Edge-v1. En v2 (≤ 3 629 920 octets), un conteneur de ce même export inchangé sous `workspace.edge.zip`, et des pièces décrites ci-dessous. Le `content.ovpack` reste un OVPack v3 `backup` à racine `viking://`, `resources` et `user`. Le sceau ACL2 authentifie tout le membre du compte, porte le contexte de cette paire/capture/version et n'est pas un permis F3. |

Les descripteurs lient le nom exact, la longueur et le SHA-256 de configuration
et de chaque compte. On vérifie aussi les ZIP et manifests imbriqués, plafonds,
quotas, types et états pris en charge. Fichiers texte/dossiers/métadonnées
portables, ressources/mémoires privées, sessions texte actives et historiques
avec frontières de reset, tags et politiques admises, skills privés inertes
validés F3 et destinations privées d'ajout sont portés. Les partages recréés
restent en quarantaine admin; ni grants ni appartenances ne sont importés;
le plafond F3 `acl2` reste vérifié. Pas de modèle lors de l'import, index différé.

**Pièces v2.** Dans chaque membre de compte : `attachments.json` (≤ 24 Kio,
liste canonique triée par ID, également présente si vide), puis exactement
`attachments/<id>.bin` pour chaque `att_<32 hex>`. Le descripteur exact contient
`id`, `user_id`, `agent_id`, `filename`, `content_type`, `size`, `expires_at`
(epoch absolue en ms), `sha256`. L’archive porte les octets opaques validés
selon les mêmes types que Gateway, sans expansion ni chemin hôte. Limites :
1 Mio par pièce, 32 pièces / 2 Mio par Workspace et 16 par agent; paquet
instance v2 ≤ 29 129 472 octets. Toute pièce encore visible au moment de la
capture est incluse ou fait refuser l’ensemble; les lignes déjà expirées
ne sont pas des pièces actives. Le compte provient de l’inventaire signé, le
couple membre/agent doit y être provisionné localement et scellé au même roster;
aucun octet d’un compte voisin n’est lu. Les tickets, staging et révisions
source sont absents; l’insertion recrée une révision à la destination et le
téléchargement exige un nouveau ticket via le Gateway normalement autorisé.

**État portable v3.** L'inventaire porte `format_version: 3`, `profile:
edge-v1-portable-state`. Chaque compte contient exactement `workspace.zip`
(le membre v2 inchangé, avec les mêmes limites et échéances de pièces) et
`portable-state.json` (≤ 512 Kio, y compris les blobs texte). Le sceau de
membre est séparé (`v3:portable-state`) et couvre les deux membres. Le JSON
contient `kind: openviking.edge-portable-state`, `version: 1`,
`shared_history: admin-only`, `ignore`, `commits`, `heads`, `blobs`, `compile`.

- La préférence `snapshot/ignore` est restaurée par compte, sans créer de
  fichier de travail. Les OID de révision, parents, têtes, auteurs, dates, arbres
  et octets des blobs sont conservés. Un fichier historique n'a pas besoin
  d'exister en live; il doit garder une URI texte canonique dans sa même
  monte portable. Parents, têtes et blobs doivent être présents dans la même
  monte, sans cycle, doublon ni objet orphelin; les empreintes arbre/blob sont
  revérifiées. Limites : 512 révisions, 96 par auteur, 512 têtes, 2 048 blobs,
  256 fichiers/2 Mio par arbre, ignore ≤ 64 Kio. Les grandes histoires sont
  refusées, jamais tronquées.
- Les incarnations historiques sont des alias sans identifiant source. Les
  historiques partagés sont **réservés aux administrateurs du compte**, y
  compris leurs métadonnées, branches vides et accès par préfixe d'OID. Le
  plafond transféré est zéro pour tout non-admin; aucun ACL ni groupe
  historique n'est copié. Les nouveaux grants rendus à des objets live à la
   destination ne rouvrent pas ces révisions. `snapshot/commit` sur la monte
   partagée est réservé aux administrateurs, y compris sur `main` et dans un
   compte sans sauvegarde restaurée. Pour un membre, le refus `403` précède
   toute lecture de tête et ne dépend pas de l'existence de la branche. Cette
   règle ne change ni les droits sur les fichiers live, ni les contrôles
   de `snapshot/restore` (qui ne crée pas de branche). L'historique privé garde sa monte
  propriétaire; un premier commit après reprise peut constater la nouvelle
  incarnation d'un fichier même si ses octets sont restés identiques.
- Compile porte au plus 256 définitions privées, au même siège provisionné,
  jamais exécutées ni planifiées, avec `auto_update=false`, sans échéancier,
  instruction libre, args ou skill installé. Seulement une recette système
  embarquée, sources et cible privées présentes dans le membre, cible marquée
  `compile_target=true` et sans chevauchement avec une autre définition.
  Aucun job, run, planification, credential, signature de config source ni
  provenance d'artefact n'est transféré. On peut lire/modifier une définition
  par les API normales après release; une exécution ultérieure nécessite une
  nouvelle demande et les gardes Compile ordinaires.

**Inventaire des refus.** v1 refuse `ov_edge_gateway_attachment`; v1/v2
refusent `ov_edge_snapshot_{commit,head,blob,ignore,portable_hidden}` et
`ov_edge_compile_config` s'ils ne sont pas vides. v3 refuse toute ligne de
`ov_edge_compile_run` ou `ov_edge_compile_schedule`, même dormante, et les
définitions hors sous-ensemble. Tous profils refusent un échéancier actif,
`ov_watches`, `ov_edge_compiled_rule`, `ov_edge_compile_artifact`,
`ov_gateway_objects`, `ov_gateway_state`, `ov_edge_mcp_registry`, les montes
`ov_edge_fs_entry` hors `shared`/utilisateur et `ov_jobs` pending/running/cancelling.
Les gardes héritées refusent `privacy_targets`, les réservations actives
`ov_edge_fs_pending` rattachées à un job, `ov_session_flights`,
`ov_session_semantic_archives`, `ov_session_tool_results`,
`ov_session_auto_commit` avec politique, `ov_bot_threads`, les sessions et
skills hors profil Edge et `ov_control_templates` côté source. La destination
refuse tout schéma applicatif Workspace préexistant et toute ligne dans les
tables Control énumérées dans `assertColdControl` (`instance-settings.ts`).
Les pièces hors siège ou hors type/TTL/quota restent refusées. Les sorties
temporaires de protocole, tickets/staging,
historiques techniques/audit/usage, compteurs, index/vecteurs dérivés, crédits
d'auth, registres et grants OAuth, secrets et paramètres de fournisseurs **ne
sont pas des domaines du contrat**. Aucun octet de fichier OS, page SQLite,
credential ou empreinte réutilisable de credential n'est exporté. Le ZIP n'est
pas chiffré : les textes applicatifs sont des données et une éventuelle valeur
secrète écrite par un utilisateur dans son texte n'est pas expurgée. Coffre
privé requis; ne pas publier (archive ni jeton d'approbation).

## Cycle RPC et reprise

1. `capture()` sur la source fermée produit le ZIP seulement après lecture
   réussie de tous les comptes. Une source hors profil ne retourne pas de
   préfixe d'archive.
2. `evaluate(bytes)` sur le secours valide tout et exécute les vrais plans
   Workspace sans staging ni écriture applicative. `200`, `dry_run:true`, reçu
   d'évaluation de 5 min; ce n'est **pas** une restauration.
3. `begin(bytes, approval)` refait la validation globale et tous les plans,
   vérifie le reçu pour le package exact puis épingle les plans dans Control.
   `202 staged`, aucun Workspace publié à ce stade. Garder le même ZIP dans le
   coffre de l'opérateur; le journal n'en conserve pas d'octets.
4. `step(bytes, index)` applique une seule étape ordonnée à partir de 0. Le
   Workspace revalide le plan à froid et écrit contenu et reçu durable dans le
   **même** `transactionSync`. Le Control acquitte ensuite ce reçu. Une
   interruption entre les deux laisse un préfixe SQLite réel **non servi**.
   `status()` puis réémission du **même index et même ZIP** récupère le reçu
   existant sans duplication; un appel déjà acquitté ne consomme pas l'étape
   suivante. `202 staged` ou `202 awaiting_release`; pas de publication publique.
5. `release(bytes)` exige tous les reçus, les relit dans les Workspaces, puis
   publie la configuration et le marqueur durable de mise en service en une
   transaction **Control**. `200 published` seulement à cette frontière. Les
   gardes du Worker et Control, le verrou persistant du journal et les reçus
    côté Workspace retiennent les données même après redémarrage ou retrait des
    variables sur ce même code et ces mêmes namespaces pendant la reprise.

Avec le même binding Control, son journal ferme aussi le Worker et les
Workspaces encore froids, même si aucune variable de sauvegarde n’est montée.
`/health` anonyme reste une liveness sans données ; `/ready` teste SQLite sans
initialiser le schéma, et ne rend pas un Workspace froid inéligible au plan.

Ce protocole rend un préfixe non visible sur le secours et laisse la source
disponible pour une reprise distincte; il ne promet ni rollback ni atomicité
SQLite multi-DO. Si une condition ne peut plus être prouvée, rester fermé,
préserver les preuves et préparer un nouveau secours/une nouvelle paire avec
l'opérateur. Pas de remise à zéro du journal, pas de réutilisation comme cible de
récupération du même annuaire. La bascule réseau/DNS demeure hors contrat.

Pour v2/v3, aucune alarme n’est armée à blanc. La prochaine échéance absolue est
armée sur l’alarme Workspace **existante** avant la transaction; pièces, autres
domaines et reçu sont ensuite commis ensemble. Un acquittement perdu relit
le même reçu et réarme sans recréer de révision. Une échéance atteinte avant
`release` vaut `INSTANCE_BACKUP_ATTACHMENT_EXPIRED` (409), `status` expose
`phase: expired`; aucune mise en service partielle ni prolongation du TTL.
Le secours scellé ne consomme aucun travail d’application : seule la purge
du compte détenteur d’un reçu avec pièces est autorisée dans sa branche d’alarme fermée.
Une fois publié, le statut reste historique et l’expiration ordinaire des
pièces continue; les tickets et paramètres du Gateway ne sont pas importés.
