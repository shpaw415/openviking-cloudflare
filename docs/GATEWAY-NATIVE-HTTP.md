# Gateway Edge — transports Responses et Messages natifs (F5)

Les nouvelles sorties HTTP sont **fermées par défaut**. Elles nécessitent un bail modèle Control et une clé Data directe du Workspace. Le propriétaire du déploiement peut désigner au plus un modèle par protocole via `OPENVIKING_EDGE_GATEWAY_NATIVE` (JSON, sans secret) :

```json
[
  {"protocol":"responses","api_base":"https://api.openai.com/v1","model":"fixture-openai","capabilities":["image","tools"]},
  {"protocol":"anthropic","api_base":"https://api.anthropic.com/v1","model":"fixture-anthropic","capabilities":["image","tools"]}
]
```

| Protocole de la règle Workspace | Sortie fixe | Authentification du fournisseur |
|---|---|---|
| `responses` | `POST https://api.openai.com/v1/responses` | `Authorization: Bearer …` |
| `anthropic` | `POST https://api.anthropic.com/v1/messages` | `x-api-key: …`, `anthropic-version: 2023-06-01` |

L'exemple ne configure rien. Chaque base exacte doit **déjà** avoir une entrée valable dans `OPENVIKING_EDGE_PROVIDERS` ; ce lot n’ajoute ni secret, ni destination à cet inventaire. Le code construit seulement les en-têtes ci-dessus et `Content-Type`/`Accept` ; pas d’en-tête client, de query, de redirection suivie ni de relance. La valeur absente ou `[]` préserve les transports F4 ; une entrée valide remplace seulement l’inventaire de la liaison `operator` **pour son protocole**, même si sa clé manque (route opérateur fermée pour ce protocole). Un JSON invalide ferme les deux protocoles opérateur non-Chat, sans affecter Chat ou Workers AI. Une règle enregistrée pour un ancien modèle n’est pas réécrite ; vérifier `/gateway/admin/upstreams` et le catalogue, puis adapter la règle si nécessaire. Une règle inclut seulement des modèles admis, pas de base ni d’en-tête. Le `test` d’une règle native utilise le même POST fixe et un prompt public constant, pas de contexte utilisateur.

Ce montage ne choisit ni le VLM général ni le fournisseur d’embedding, de génération de sessions, de Compile ou de Bot. Chat conserve son transport et ses options. Le natif partage les plafonds de génération applicables au Workspace (`vlm.max_tokens`, `timeout` et `max_concurrent` si présents), sans transférer les réglages d’échantillonnage/raisonnement du VLM général à un fournisseur différent. Aucun droit nouveau pour Root, OIDC, OAuth ou clés Gateway dédiées ; les routes Workers AI gardent leur politique existante. `OPENVIKING_EDGE_OPERATOR_STREAMING=1` reste nécessaire pour le vrai SSE HTTP.

## Contrat porté

- **Responses** : chaîne ou messages typés normalisés, rôles `system`/`developer` distincts et `instructions` séparées, `max_output_tokens`, texte et fonctions client. Toujours `store:false` chez OpenAI : la conservation ou la reprise demandée reste intégralement locale (texte seulement, route et empreinte du protocole et de la base). Pas d’envoi d’identifiant local ou de `previous_response_id` fournisseur. Une réponse F4 Chat ne peut pas être reprise sur le nouveau transport, même si le modèle et la base sont les mêmes.
- **Messages** : `system` séparé, rôles utilisateur/assistant, `max_tokens`, texte et blocs typés. Les résultats `tool_result` d’un même groupe vont ensemble et conservent `is_error`. Les blocs uniquement textuels suivent la normalisation Edge F4 (jointure par saut de ligne) ; le Gateway projette une réponse texte agrégée et des identifiants de réponse locaux. Ce n’est pas un proxy transparent.
- **Entrée riche** : déclarations `image`, `document` et `tools` indépendantes, opt-in par modèle. Même validation F4 des PNG/JPEG et, lorsque Transferts est monté, même vérification de pièce sous autorité Data exacte et `assertCurrent()` avant l’envoi et aux effets visibles. Pas d’URL d’image externe ni de champ `file_id` envoyé au fournisseur. Les schémas, appels et résultats de fonctions client suivent le [sous-ensemble F4](GATEWAY-MULTIMODAL.md) et ne sont pas exécutés par le serveur.
- **Texte, rappel, capture** : politiques, budgets d’entrée, garde du rappel/ACL et publication F4 conservés ; tours riches privés de rappel/profil/capture/conservation, comme F4. Un tour incomplet typé ne déclenche ni capture ni conservation. Le JSON et le SSE ne publient pas les objets, erreurs, identifiants de réponse ou en-têtes bruts du fournisseur. L’usage annoncé provient des champs portés, pas d’une estimation.
- **SSE** : trames natives bornées, protocole et ordre vérifiés, traitement incrémental UTF‑8 et filtre F4 à frontières publiques. Responses exige le terminal natif cohérent avec les items et deltas reçus ; Messages exige `message_delta` puis `message_stop`. Les arguments ne sortent qu’après validation du tour terminal fournisseur. Une erreur, un résumé incohérent ou un EOF nu ne produit jamais de terminal Edge de réussite. Un texte partiel déjà émis ne peut pas être retiré. La publication et la rupture réutilisent les clôtures d’autorité et le registre d’annulation du Gateway.

## Capacités de finition, fermées par défaut

| Capability | Effet et entrées supportées |
|---|---|
| `document` | Texte UTF-8 `.txt`, 64 Kio/bloc, budget commun 128 Kio/4 blocs. Responses accepte `input_file` avec `filename` + `file_data` (base64 ou URL de données `text/plain`) ou le seul `file_id` local `att_…`. En sortie du Gateway, URL de données et nom validé. Messages accepte `document.source` `text`, `base64` ou `file` local ; projection vers la source native `text` / `text/plain` sans envoi de l'identifiant. Une pièce stockée reste sous sa révision, son expiration et le triplet tenant/membre/agent. Aucun URL externe, Office, archive ou PDF injecté au modèle. |
| `sampling` | `temperature` (Responses 0–2, Messages 0–1), `top_p` (0–1), nombres finis ; Messages n'admet pas les deux simultanément. Ni repli ni surcharge des réglages VLM généraux. |
| `stop_sequences` | Messages uniquement : 1–4 chaînes distinctes, max. 128 octets chacune ; la réponse JSON/SSE expose `stop_sequence` seulement s'il correspond à une séquence demandée et passe le filtre. |
| `structured` | `text.format` (Responses) ou `output_config.format` (Messages) avec `json_schema` strict, objet borné sans références externes, validé sur la réponse complète avant émission. JSON non-stream, sans fonctions, reprise ni capture/rappel/profil. |
| `count_tokens` | Messages uniquement : POST natif `/v1/messages/count_tokens`, sans paramètre de génération ni injection de rappel ; projection de `input_tokens` fourni par le tokenizer du fournisseur, pas une mesure calculée par Edge. Rien à conserver. |
| `local_read` | Opt-in par modèle natif, clé Data directe et en-tête `X-OpenViking-Allow-Read: viking://resources/…` portant une URI canonique précise. Une seule lecture de fichier texte SQLite (8 Kio max.), bail Data, ACL et révision revalidés avant lecture, continuation et publication. Deux appels au même modèle : sélection validée de `openviking_read` puis réponse JSON ou SSE natif ; aucune nouvelle invocation possible. Hors capture/rappel/profil/conservation et outils client. Le catalogue générique, les profils `gateway_tools` et les outils système restent refusés. |

L’entrée/sortie WAV native est activable pour Chat sur `https://api.openai.com/v1` seulement : `audio` pour WAV entrant, `audio_output` dans `OPENVIKING_EDGE_GATEWAY_CAPABILITIES` pour `modalities:["text","audio"]` avec `audio:{"voice":"alloy","format":"wav"}` (autres voix dans l'allowlist du DTO). Réponse non-stream avec octets PCM WAV bornés et transcript contrôlés, identifiant d’affichage local non réutilisable. Pas d'audio entrant/sortant inventé sur Responses/Messages, pas de WAV SSE, d'image générée, de PDF natif, de raisonnement (items/deltas/signatures), de citations, de variantes beta, de sessions gérées fournisseur ni d'arrière-plan. Les réponses non portées sont refusées sans fallback. La réception locale n'est pas une mesure de compatibilité avec des fournisseurs distants ou tous les SDK.
