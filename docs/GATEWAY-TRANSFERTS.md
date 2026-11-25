# Transferts signés du Gateway Edge

Le Gateway peut importer un fichier texte par `POST /gateway/uploads` ou restituer les octets d’un fichier par `GET /gateway/downloads`. L’upload publie réellement dans l’espace Viking (pas de `temp_file_id` à consommer ensuite). Les liens sont **à usage unique et non anonymes** : il faut la **même clé de données directe** à l’émission et à l’utilisation, en plus du ticket et des contrôles Access existants. Ni les clés dédiées `ovgw_`, ni Root, ni OIDC/OAuth ne reçoivent cette permission.

## Activation opérateur — fermée par défaut

- `OPENVIKING_EDGE_GATEWAY_TRANSFERS=1` **et** le binding secret `OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET` sont requis. Provisionner 32 octets aléatoires cryptographiquement, représentés par 64 chiffres hexadécimaux minuscules, distincts de tout autre secret de l’instance. Aucun secret de secours ou dérivé d’une clé API. Les formats invalides et valeurs manifestement répétitives sont refusés ; le contrôle de format ne prouve pas l’aléa.
- Sans cette configuration, un client direct par ailleurs admis reçoit `501 signed_transfer_unavailable`. La signature HMAC-SHA-256 est réalisée et vérifiée via Web Crypto. Une rotation du secret invalide les anciens tickets ; leurs places expirent normalement. Pour désactiver durablement des tickets non utilisés, retirer le secret ou le remplacer, pas seulement couper et rétablir le drapeau avec le même secret.
- Control doit aussi confirmer l’autorité Data du demandeur, fixe ou géré. Sans cette confirmation, pas d’émission, de rédemption ni d’appel à un fournisseur (`503 AUTH_UNAVAILABLE`).
- Servir les trois routes sur **la même origine HTTPS protégée** que l’API. Ne retirer aucune règle Cloudflare Access ni ajouter de chemin public/alternatif. Le ticket n’est pas une preuve CF Access ; le Worker ne crée ni en-tête Access, ni exception, ni redirection. Un client sans accès à l’origine protégée ne doit pas recevoir de repli. Cette recette locale ne vérifie pas la configuration de l’Access d’un déploiement.
- Garder l’audit applicatif sans URL complète, corps, en-têtes de preuve ni ticket. Les réponses, y compris les erreurs, sont `private, no-store` avec `Referrer-Policy: no-referrer`. **Ne pas activer de journalisation de requêtes complètes** aux autres couches pour ces routes. Préférer `ticket_transport: "header"` si les URL peuvent être journalisées ; exclure aussi cet en-tête et les corps de réponse des traces. Les journaux de navigateur, proxy, Access, WAF et plateforme ne sont pas contrôlés par le Worker : masquer les preuves dans toute la chaîne, ou laisser la fonctionnalité désactivée.

## Matrice route / ACL / limites

| Route | Admission et effet | Limites |
|---|---|---|
| `POST /gateway/transfers/tickets` | API key directe `user`/`admin` (fixe ou gérée). Bien Viking canonique, droits de lecture, d’écriture ou d’administration selon le cas ci-dessous. Aucun accès ou publication de contenu à l’émission. | JSON ≤ 8 Kio, délai de réception 30 s. TTL `1–600` s, `600` par défaut. 16 tickets par acteur, 32 par utilisateur tous agents confondus, 128 par tenant, tickets dépensés compris jusqu’à expiration. Les lignes expirées sont purgées à la prochaine émission admise dans ce tenant. |
| `POST /gateway/uploads` — `resource` | Même origine, même clé, tenant, utilisateur, agent et rôle. ACL `write` sur la destination et son parent existant ; `manage` pour fixer une ACL. Revalidation de la délégation, des droits et de la révision du parent avant l’effet ; publication atomique via `Filesystem`. | `multipart/form-data` non compressé, **un** `file` UTF-8 de 64 Kio au plus et 8 Kio de marge multipart. `upload_mode=local` (ou omis), `telemetry` facultatif (`true/false/1/0`, pas de télémétrie de contenu). Création seulement ; parent existant, pas d’écrasement ni de suffixe automatique. |
| `POST /gateway/uploads` — `skill` | Même preuve de données. Propriétaire du montage privé ou admin tenant pour `viking://agent/skills`. `SKILL.md` identifié par son nom de frontmatter, prévisualisé ou installé par la façade Skills existante, jamais exécuté. Revalidation de l’état du paquet. | Même multipart ; définition unique, pas de ZIP, de dépôt Git ni de mise à jour d’un paquet existant. `list_only` ne publie rien. |
| `GET /gateway/downloads` | Même preuve de données ; `read` via `Filesystem`, vérifié à l’émission et à la lecture de la révision signée (y compris les gardes des fichiers dérivés). | Un seul fichier existant de la façade (texte Edge), octets UTF‑8 complets, `application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''…`, `nosniff`, CSP `sandbox`. Pas de dossier, de HEAD ni de redirection. |

Au transfert, un seul ticket : `?token=…` **ou** `X-OpenViking-Transfer-Ticket`, sans autre paramètre. Un ticket n’autorise que l’action, l’origine, la preuve de clé, l’objet et les révisions d’autorité Data signés ; ni `uri` ni destination alternative ne sont acceptés à l’utilisation. Une modification de rôle, de clé ou d’appartenance rend caducs les tickets des membres concernés, pas ceux des autres membres. Un ancien ticket avec seulement l’époque de compte (F2) reste utilisable tant que cette époque n’a pas changé et que son membre n’a pas franchi de nouveau plancher ; un ticket sans révision est refusé. Une configuration de modèle seule ne rend pas le ticket caduc.

Control lit l’annuaire et la révision ensemble. Avant de modifier l’autorité, il fait avancer un plancher durable dans le Workspace. Ce plancher et les ACL/révisions du fichier sont vérifiés avant les effets fournisseurs et dans les transactions d’émission, de rédemption et de publication. Une lecture d’annuaire tardive ne remplace pas ce contrôle local. Une opération déjà engagée chez le fournisseur, une écriture validée ou des octets déjà remis au transport ne peuvent pas être retirés rétroactivement. Aucun nouvel upstream HTTP n’est choisi par le client.

La consommation du ticket est un `UPDATE` conditionnel SQLite, avant la lecture du multipart et l’indexation. Au plus 8 uploads simultanés par Workspace ; le délai de lecture est borné à 30 s et à l’expiration, et aucune publication ne peut intervenir après cette borne. Aucune copie d’upload durable ni tâche de reprise : seuls plan borné, empreinte de preuve et métadonnées du ticket sont stockés, jamais le ticket complet ou la clé API ; le plan est effacé à la consommation. Un échec après réclamation (p. ex. mauvais multipart, fournisseur en erreur ou révocation pendant le traitement) nécessite un nouveau ticket. Une preuve invalide, expirée ou déjà consommée renvoie `401`. ACL et révisions peuvent refuser par `403`/`404`/`409`; quotas `413`/`429` et média non pris en charge `415`. Après interruption réseau, vérifier l’existence de la ressource avant de demander un nouveau ticket.

## Délivrer et utiliser un ticket

Tous les exemples supposent une origine de fixture autorisée et la même clé de données en `X-API-Key` ou `Authorization: Bearer …`. Les valeurs d’authentification et de ticket doivent rester en mémoire du client, pas dans des commandes enregistrées ni dans un prompt modèle.

1. Émettre par `POST /gateway/transfers/tickets` avec `Content-Type: application/json` et l’un de ces corps :

   ```json
   {"action":"upload","filename":"notes.md","parent":"viking://~/resources","processing_mode":"vectors_only","parse_mode":"no_split","reason":"Notes de marée","tags":["topic=marée"],"ticket_transport":"header"}
   ```

   ```json
   {"action":"upload","kind":"skill","target_uri":"viking://~/skills/maree","list_only":true}
   ```

   ```json
   {"action":"download","uri":"viking://~/resources/notes.md","ttl_seconds":60,"ticket_transport":"header"}
   ```

   Pour `resource` (`kind` par défaut), le `filename` doit correspondre au nom multipart. `to` et `parent` sont exclusifs; `to` est une URI Viking de création exacte (une racine de ressource suivie de la feuille bindée si `to` finit par `/` ou n’a pas d’extension, comme dans B3). `parent` est un répertoire existant (`viking://resources` si rien n’est indiqué). `reason`, `processing_mode` (`semantic_and_vectors` par défaut ou `vectors_only`), `tags`, `tag_mode`, `parse_mode` (`default`/`no_split`), `acl` suivent le sous-ensemble texte d’Edge. Pour `skill`, viser un paquet exact ou fournir un seul nom `skills: ["maree"]` avec la racine souhaitée (`viking://~/skills` par défaut). `list_only: true` délivre un ticket de prévisualisation, différent du ticket d’installation.
2. Le `201` retourne `{status:"ok",result:{method,url,uri,expires_at,…}}`. Résoudre le `url` relatif contre l’origine de la requête. En mode `query` (par défaut), le seul paramètre est `token`; en mode `header`, la réponse fournit `ticket` et `ticket_header` séparés et l’URL ne contient pas de paramètre. Ne jamais placer la clé API ou un secret opérateur dans une URL.
3. Garder Access **et** la clé API directe pour appeler `method`/`url`. Pour un upload, envoyer un `FormData` avec la part `file` et attendre le reçu d’import (p. ex. `result.root_uri`). Pour un download, traiter la réponse comme des octets de pièce jointe, pas comme du JSON ni comme du contenu actif. Le chemin `uri` renvoyé à l’émission permet de vérifier l’effet par la façade normale.

## Écarts assumés avec le pin

Au pin `000f0765d7ec183886fbabbc22e69bc289cc429d`, `openviking_gateway/app.py` relaie `POST /uploads?token=…` et `GET /downloads?token=…` (sous `/gateway`) vers `resources/temp_upload` et `content/download`. `tool_executor.py` reprend les liens issus de MCP (`add_resource`, `add_skill`, `download`) ; le serveur amont consomme le jeton et ingère le fichier sur le chemin signé. Le lot conserve les deux transports et leurs effets, dans le périmètre du stockage Edge. `POST /gateway/transfers/tickets` est l’adaptation explicite de **délivrance**, pas un outil MCP générique, un appel modèle ou un parseur de résultats d’outils.

La rédemption sans clé API directe ou à partir d’une identité déléguée, les jetons amont, les URLs vers une autre origine, packs, binaires, conversion documentaire, staging partagé et arborescences OS distantes ne sont pas portés par ces routes. Les paramètres étrangers sont refusés plutôt qu’ignorés. Les anciens SDK peuvent toujours utiliser leurs routes REST directes actuelles; leurs flux multipart `temp_file_id` et leurs téléchargements directs authentifiés gardent leur contrat et ne sont pas redirigés vers les transferts signés.
