# F4 — Approved web documents and GitHub documentation

The new modes are off by default. The operator provides both a private service binding `WEB_SOURCE` and a validated version-1 `OPENVIKING_EDGE_WEB_CATALOG`. In `GET /api/v1/system/edge-capabilities`, `htmlImport`, `siteImport` and `gitDocsImport` are independent booleans. Each requires a direct User/Admin Data key, Control, Workspace, an embedding binding and a corresponding catalogue entry for the authenticated account. They report a configured mount, not a probe of a particular snapshot. Root, Gateway, OIDC and OAuth grants cannot use it. Studio P20 keeps the existing Add Resource dialog and job recovery; it never sends a provider credential, private collection ID or repo URL.

## Resource API

Use authenticated `POST /api/v1/resources`:

| Mode | Source fields | What is committed |
|---|---|---|
| HTML | `path`: exact approved HTTPS `.html`/`.htm`, `args: {"web_mode":"html"}` | One `.txt` resource, normalized from inert HTML. No links followed. |
| Linked site documents | `path`: exact enabled catalogue entry page, `args: {"site":true}` | A new folder with one indexed `.txt` file per selected page. No replacement or merge into an existing site folder. |
| GitHub documentation | `add_type: "git"`, `path`: operator-issued alias, e.g. `seabird-docs` | One pinned GitHub Contents API `.md`/`.txt` file as UTF-8 text in a `.txt` resource. No Git commands or navigation to provider links. |

An omitted destination uses `viking://~/resources`. Where applicable, supply `parent` for a collision-safe new leaf or `to` for an exact file or new site folder (mutually exclusive). Explicit `create_parent: true` can create missing parents. Exact file replacement keeps its existing ACL and tags. Studio asks for consent on the exact path and clears it when source or destination changes. `wait: false` uses the existing durable `add_resource` queue and returns `task_id` and canonical `root_uri`; poll `/api/v1/tasks/{task_id}`. Success includes `documents`, the canonical URIs that were indexed, and a warning if the site page/depth bound was reached. `wait: true` (or omitted) runs synchronously with conflict detection. Both modes publish through Filesystem and return searchable resources, not a task-only receipt. These modes index vectors but do not generate summaries or treat source text as instructions. The default unflagged F3 text import, F3 watches and staged uploads are unchanged.

## Private source contract

The application never connects to the submitted host. It only reads the matching immutable object by a catalogue-owned ID through the named service binding. `src/web/snapshot-service.ts` is a read-only implementation for a dedicated private `WEB_SNAPSHOTS` R2 binding. It implements only `GET` on the exact service routes below, does not list, write or call upstream, and has no public route in the application. Do not expose the snapshot service on a public hostname. Provision objects separately, after verifying public documentary origin and permission to import; F4 does not take credentials or provision upstream data. Update the pin alongside each new snapshot and refresh the approved `robots.txt` policy before publishing a new set. An absent robots policy is not assumed: a pinned empty policy is accepted when the operator has independently verified that no policy applies.

The catalogue is `{ "version": 1, "sites": [...], "git": [...] }`. It is bounded to 48 Ki characters, 32 site rows, 24 pages per site and 32 Git rows. Rows have these exact fields:

| Row | Fields |
|---|---|
| Site | `account` (Data account ID), `entry` (one of this site's exact page URLs), `name` (new folder basename), `explore` (boolean), `robots: {id,sha256}`, `pages: [{url,id,sha256,name},…]` (`name` is the visible `.txt` basename, unique in the site). Every page is on exactly the entry's HTTPS origin. |
| Git | `account`, `alias` (client-facing slug), `collection` (private binding ID), `repository` (`owner/repo`), `revision` (full 40-hex Git SHA), `file` (exact `.md`/`.txt` path), `name` (visible `.txt` basename), `sha256` (raw Contents JSON). |

IDs and aliases use `[a-z0-9][a-z0-9_-]{0,63}`. Snapshot SHA-256s are lowercase hex over the exact bytes. Each object has private `customMetadata.sourceUrl` equal to its verified source URI. The fixed binding origin is `https://web-source.invalid`, not a network hostname contacted by the app:

| Binding path | R2 key | Expected source receipt and type |
|---|---|---|
| `/v1/robots/{id}` | `robots/{id}` | Catalogue origin + `/robots.txt`; `text/plain`. |
| `/v1/html/{id}` | `html/{id}` | Catalogue page URL; `text/html`. |
| `/v1/git/{collection}` | `git/{collection}` | `https://api.github.com/repos/{repository}/contents/{file}?ref={revision}`; `application/json`. This is an identity string, not a fetch destination. |

At each hop the application sends only a fresh read request with a fixed `Accept` value. It requires a 200 octet-stream response, identity encoding, exact `X-OV-Web-Source-URL` and `X-OV-Web-Source-Type`, consistent byte length when present, and the pinned SHA-256. Redirects, partial or mismatched replies, missing objects and unexpected types fail closed; no direct fallback. Git additionally checks the Contents representation (`file`, name, path, canonical base64, byte count, Git blob identity, valid UTF-8; no submodules/symlink record). Provider URLs in that representation are never used. Do not point the binding at a general-purpose proxy or an internal data service.

HTML is parsed with Workerd `HTMLRewriter` in two inert passes: strip active/hidden elements including scripts, styles, templates and forms, then extract text and candidate links. The original markup is never sent to the application client. Entity normalization is limited to numeric and common named forms; no browser/CSS rendering, script evaluation, embedded documents or prompt-generation pipeline. Only ordinary document anchors may select another exact, already listed same-origin page; no `<base>`, downloads, discovered hosts, sitemap, query, fragment, path patterns or URL normalization changing the client input.

Exploration is breadth-first, sequential, at most **6 pages** including the entry, **2 links deep**, **192 KiB** aggregate raw bytes including policy, and **8 seconds** for the source read (including policy, authentication checks between reads, and extraction). Individual caps are 16 KiB robots, 64 KiB HTML and 96 KiB raw Git JSON; stored UTF-8 is capped at 64 KiB per file. Excess bytes or deadline abort the import without a partial directory. `robots.txt` is evaluated at the source origin before opening each allowed document: `OpenVikingEdgeImport` group, else `*`; longest prefix or exact `$` match, allow wins ties. Unsupported path wildcards, percent escapes or nonzero crawl delay in the applicable group yield a refusal, not a bypass. Denied links are skipped; a denied entry is refused. Sitemap directives never introduce destinations.

## Authority and concurrency

The same F-SEC-01 Data lease and member floor fence the task's admission, each source hop, indexing and publication. ACLs and destination revisions are rechecked under that lease. Async insertion includes the file/subtree reservation, which pins the source plan (including policy and snapshot identities), and the SQLite transaction publishes the files, indexes, terminal success and reservation release together. An interrupted/revoked job does not silently restart a write. Sync imports recheck the original plan and active reservations, then publish once in a transaction or return a conflict. Site paths are always create-only. None of this grants rights outside the existing workspace.

## Upstream compatibility and exclusions

Pin `000f0765d7ec183886fbabbc22e69bc289cc429d`: `server/routers/resources.py` and `server/resource_ingest.py` use the same resource endpoint; `web_importer.py` and `web_crawler/` supply the crawl family; `web_feed_accessor.py` recognizes RSS 2.0, Atom and XML sitemap mirroring; `connector/routing.py` recognizes `tos` and `git`, and the pin has a Feishu accessor. F4's `site` is not amont feed discovery or Scrapy. For Git, the upstream Python SDK requires `to` with `add_type`; use an exact `.txt` with that SDK. The F4 API (including Studio) also accepts `parent` or a private default; the `path` is a catalogue alias rather than a repo URL. There is **no** support for Git clone/archives/SSH, moving refs, other Git hosting, TOS, Feishu, RSS/Atom/sitemaps, user-provided connector authentication, remote parsers or web/connector watches. This is not a live provider integration or a deployment.
