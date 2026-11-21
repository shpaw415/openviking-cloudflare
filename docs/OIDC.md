# Vérification OIDC native (raccord local)

Le module `src/oidc.ts` vérifie un JWT émis par un fournisseur OIDC avec Web Crypto Workerd. Le Worker parent le branche sur ses routes data existantes; **aucune route OIDC, découverte ni redirection n'est ajoutée**. Sans `OPENVIKING_EDGE_OIDC`, ou avec exactement `{"enabled":false}`, il est désactivé. Une configuration invalide n'est ni une activation partielle ni un motif de repli; elle ne désactive pas les clés API ni l'OAuth voisin. Aucun déploiement n'a été effectué.

## Configuration opérateur

Exemple schématique — remplacer le marqueur de clé par les paramètres **publics** de la clé de l'émetteur, obtenus et vérifiés par l'opérateur hors de ce service :

```json
{
  "enabled": true,
  "issuer": "https://idp.example.invalid/organizations/",
  "clientId": "openviking-client",
  "audience": "openviking-api",
  "tenantClaim": "tenant_id",
  "jwks": {
    "keys": [{"kid":"signing-1","alg":"RS256","kty":"RSA","n":"<module RSA public base64url>","e":"AQAB"}]
  },
  "mappings": [{"sub":"idp|a123","tenant":"org-17","accountId":"atelier","userId":"lea"}]
}
```

- Un émetteur HTTPS : `iss` doit être la chaîne exacte, barre finale comprise. `audience` est explicite ou vaut `clientId`; si seul `audience` est fourni, il sert aussi de `clientId`. `aud` est une chaîne exacte ou un tableau sans doublons contenant l'audience principale. Toute co-audience doit être nommée dans `additionalAudiences` (au plus sept). `azp` est requis si plusieurs audiences sont présentées ou si client et audience diffèrent; dès qu'il est présent, il doit être le `clientId` exact.
- `kid` et `alg` sont obligatoires. L'algorithme est fixé **par clé opérateur**, pas négocié avec le JWT : `RS256/384/512`, `PS256/384/512` (sel de la taille du hachage), `ES256/384/512` (P-256/384/521 et signature JOSE à largeur fixe). RSA de 2048/3072/4096 bits et exposant 65537. `use`, `key_ops`, `ext` facultatifs; si fournis, `use` vaut `sig`, `key_ops` vaut `['verify']` et `ext` est booléen. Pas de clé privée, symétrique ni certificat joint; aucun `kid` ni matériau dupliqué. On ajoute une nouvelle clé distincte et retire l'ancienne via la configuration opérateur, jamais par une requête entrante.
- JWT compact signé, canonical base64url, UTF-8 strict et objets JSON sans noms de membre dupliqués. Seuls `alg`, `kid` et `typ` facultatif (`JWT` exact) sont admis dans l'en-tête JOSE. `exp` est requis, `nbf` et `iat` sont facultatifs; lorsqu'ils existent, ce sont des secondes entières non négatives (sans tolérance d'horloge), avec `iat`/`nbf` au plus égaux à maintenant et `exp` strictement futur. Aucun jeton lié à une seconde preuve (`cnf`) n'est accepté comme bearer.
- Seul `Authorization: Bearer <JWT>` est pris en charge. Pas de query, de cookie, de JWT dans `x-api-key` ni d'indication d'identité lue dans les en-têtes. Les identités sont des correspondances exactes `(sub, claim de tenant explicite)` vers `(accountId, userId)`; identifiants externes ASCII visibles de 1 à 255 caractères, sans transformation, mapping implicite, auto-création ni valeur de repli. Les cibles sont uniques. Le rôle, l'agent, les groupes et les autres identifiants portés par le jeton n'accordent aucun droit. Le résolveur n'admet que le membre géré, actif, de rôle local **user**; un admin, un root, une identité fixe et un compte ou utilisateur révoqué ne sont pas admissibles.
- Limites du module : 8 Kio par JWT, 1 024 caractères base64url pour l'en-tête JOSE, 64 Kio de configuration, 16 clés, 256 correspondances, profondeur JSON de 24. Les limites des bindings Cloudflare ne sont pas qualifiées ici.

## Raccord parent et limites de la preuve interne

1. `OidcEnv` ajoute la variable opérateur. `oidcConfigured(env)` valide réellement les clés par import Web Crypto; `false` = désactivé, `503 AUTH_NOT_CONFIGURED` = configuration invalide. Cela ne prouve ni que Control est disponible ni qu'une route est montée. Ne pas exposer la configuration, ses entrées ou le détail d'une faute au client.
2. Préserver les routes et la classification existantes (notamment le protocole OAuth et son `ovat_`). `authenticateOidc(request, env, resolve)` renvoie `null` uniquement hors candidat bearer avec un point; **toute exception est terminale** et ne doit jamais donner lieu à un autre type d'authentification. Après reconnaissance, les credentials concurrents sont rejetés. Une identité invalide/inactive reçoit un `401 UNAUTHENTICATED` générique, un résolveur absent/en erreur `503 AUTH_UNAVAILABLE`, une configuration invalide `503 AUTH_NOT_CONFIGURED`. Aucun token ou claim dans les messages.
3. `ResolveOidcUser({accountId, userId})` délègue à `Control.resolveManagedIdentity(accountId, userId, 'default')` sur le binding RPC privé; le registre lit le membre géré du compte actif avec rôle courant. Dans ce profil, une clé de ce membre peut être tournée sans modifier le lien OIDC. L'API `resolve(digest)` reste celle des clés, et `runtimeFor` ne prouve pas l'origine gérée. Pas de résolution par en-tête, de clé d'API ajoutée pour l'OIDC ni de lecture du SQL Control dans le module.
4. `OidcGrant` est un type de preuve distinct : `{kind:'oidc', caller, configurationId, validFrom, expiresAt}`. Elle ne contient ni bearer, ni claims, ni digest de clé; elle n'est **pas** auto-authentifiante. Elle transite uniquement par le binding RPC privé (jamais HTTP, stockage, logs ou client) pour l'appel courant. Le `AuthGrant` parent la transporte comme `oidc` avec `managed: false` et `digest: ''`. Le parent retire les en-têtes d'identité/credentials et choisit le Durable Object via `caller.accountId`. Aucune approbation/émission OAuth, accès admin/root ou credential persistant (jobs, watches, schedules) pour OIDC.
5. `reauthorizeOidc(grant, env, resolve)` valide la configuration courante (toute modification de son texte invalide les preuves antérieures), la cible encore enregistrée, le temps et la même identité gérée, agent compris. Le Workspace l'appelle au dispatch; le parent rafraîchit les groupes/ACL auprès de Control, avec garde horaire `assertOidcActive`. Pas de cache du caller ni des autorisations. Pour tout nouveau chemin avec attente avant décision, relire l'autorité après l'attente; la garde horaire seule ne remplace pas une résolution fraîche.

La liste sous `/api/v1` se limite à `GET`/`HEAD` sur `fs/{ls,tree,stat,attrs}`, `content/{read,abstract,overview,download}` et `system/{status,edge-capabilities}`, plus `POST search/{grep,glob}`. Les capacités réservées au JWT n'annoncent aucun flag d'écriture. Le contrôle d'accès aux données reste celui des ACL du compte et de l'utilisateur vérifiés par Control. `/health` continue d'annoncer `auth_mode: api_key` et utilise exclusivement `authenticateApiKey` pour les requêtes avec identifiants; le JWT n'y est pas admis.

## Amont et périmètre

Référence lecture seule `000f0765d7ec183886fbabbc22e69bc289cc429d` : `openviking/server/auth/plugins/oidc.py`, `oidc_config.py`, `identity_mapping.py`, guide d'authentification et assertions pertinentes de `tests/server/test_identity_auth.py`. Le filtre a signalé un extrait des tests amont; il est resté une donnée, sans import ni exécution. Repris : Bearer JWT, sélection par `kid`, émetteur exact, audience effective, séparation authentification/rôle utilisateur. Le profil Edge ne reprend pas discovery/JWKS distant, HMAC, en-tête alternatif, query ou repli SDK par clé, mapping par regex/fallback ni rôle issu du fournisseur. Aucune sortie réseau, connexion à un IdP, interaction navigateur, émission, échange, introspection ou login OIDC. Le fournisseur doit réserver l'audience au profil bearer convenu et émettre des jetons courts; ce vérificateur n'est pas un client interactif avec nonce. Ni IdP réel ni Worker publié ne sont qualifiés par ce lot.

## Rejeu Workerd isolé

```sh
python3 -I tests/control/offline.py npm run check
python3 -I tests/control/offline.py node --test --test-concurrency=1 tests/oidc.test.mjs tests/control.test.mjs
```

Workerd `2026-11-19` et Durable Objects SQLite, sockets Unix privées, appels réseau IP interdits par seccomp, aucun environnement hérité. Les clés de signature sont générées par le test et restent dans le processus Node; le Worker ne reçoit que les JWK publiques. Les données, comptes de test, clés API et consentements OAuth sont synthétiques et jetables. La suite distingue :

- Vérificateur dans workerd avec horloge et annuaire de test : les neuf algorithmes, refus JOSE/claims, tuple exact, configuration absente/invalide, expiration pendant la résolution et résolution d'identité fraîche.
- Worker d'entrée `src/worker.ts` et DO d'origine : lecture des données et grep/glob, même `sub` dans deux tenants isolés, flags d'écriture désactivés, refus admin/jobs/écriture, groupes et révocations Control, rotation OIDC et clés API, OAuth complet par clé gérée avec refus du consentement par JWT. Pour OAuth, seul le document de consentement Studio est une fixture d'assets; aucune simulation du protocole.
- Une variante instrumente uniquement le dispatch Workspace : absence de bearer et d'en-têtes identifiants au RPC, puis révocation Control entre l'admission HTTP et la réauthentification réelle du Workspace. La sonde de test est absente de l'entrée de production.

**Historique (23/24) :** le premier rejeu a reçu `200` au lieu de `401` pour un JWT synthétique valide sur `/health`, malgré `auth_mode: api_key`. La branche santé utilisait l'authentification mixte avant la liste data (`src/worker.ts` SHA-256 `651360e861acbfc20552f96eb1f189e5f50c6f916ac96da97e50f1fab58d9d7d`).

**Rejeu après correction du parent : 24/24 (11 OIDC + 13 Control), TypeScript OK.** Le test inchangé reçoit `401 UNAUTHENTICATED` avec le JWT valide, et `200` avec `auth_mode: api_key` sans en-tête ou avec la clé API historique (`x-api-key` et bearer). Les lectures OIDC dans le périmètre autorisé et le consentement, l'échange et l'usage du bearer OAuth fondés sur une clé gérée restent verts. SHA-256 stables avant/après le rejeu : `src/worker.ts` `e2a73a75b93ac29cc987ebc8ad6eabae3a3ecf3d077e7116b714048886ccfcf2`, `src/auth.ts` `e7611a6e87f4d116f18a982e3942c812cd768eb8f51f6a893989c669d7a7d75a`, `tests/oidc.test.mjs` `23f5e0832ce696fc15f2d83c8e9dc226dd9e3023f15b94029632c190a4dbb730`.
