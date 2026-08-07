# mcjarfiles-tcadmin-sync

A Cloudflare Worker that keeps your TCAdmin 3 Minecraft Java blueprint's
**Game Updates** list in sync with every server jar version available on
[mcjarfiles.com](https://mcjarfiles.com) (Paper, Purpur, Leaf, Folia,
Vanilla, Fabric, Velocity).

TCAdmin's built-in Updates feature is already a 1-click "pick a build,
install it" UI in the customer service panel — this worker just keeps that
list populated automatically, on a cron schedule, instead of you creating
hundreds of entries by hand. It never edits or deletes an Update it didn't
create, so anything you've customized in the panel is left alone.

## How it works

1. On a schedule (default every 5 minutes), the worker asks
   `mcjarfiles.com/api/get-versions/{type}/{variant}` for every configured
   server type.
2. It fetches your game's existing Updates from TCAdmin
   (`GET /api/Game/{gameId}/Updates`) and diffs by (group, version name).
3. For every version TCAdmin doesn't have yet, it creates a new Update
   (`POST /api/Game/{gameId}/Updates`) whose `source` is
   `mcjarfiles.com/api/get-jar/{type}/{variant}/{version}` — TCAdmin downloads
   the actual jar itself the moment a customer clicks Install, so the file
   served is always mcjarfiles' current build for that version.
4. Every Update is saved as `minecraft_server.jar`, so one startup command and one
   post-install script work across every server type/version.
5. It also creates one evergreen Update per variant in a separate **"Latest"**
   group — `source` points at `mcjarfiles.com/api/get-latest-jar/{type}/{variant}`,
   which mcjarfiles resolves to whichever build is newest *at install time*.
   These never need updating as new versions ship (there's nothing to diff —
   they're created once and left alone), so customers who don't care about
   picking an exact version can just install "Latest Paper" and always get
   the current one.

## One-time setup

### 1. Generate a TCAdmin API key

In the panel, go to **Profile → API Keys → Create API Key**. Under the
`Game` module, check only:

- **Game - Get** — lets the worker list existing Updates to diff against.
- **Game - Update** — lets it create new Update entries.

There's no permission scoped just to Updates specifically — they're managed
through the general Game entity endpoints, so these two are the narrowest
option available. Leave `Create`, `Delete`, `Import`, `Move`, `Query Tool`,
and `Rcon Tool` unchecked (`Create`/`Delete` in particular would let the key
create or delete entire game blueprints, not just Updates). Copy the key —
it's only shown once.

> The OpenAPI spec at `{your-panel}/swagger/v1/swagger.json` doesn't declare
> the auth header TCAdmin expects, and `Authorization: Bearer <key>` (the
> ASP.NET convention this panel uses everywhere else) turned out to be
> wrong — confirmed against the live panel, the key goes in an `X-Api-Key`
> header instead (see `TCAdminClient.request` in `src/tcadmin.ts`).

### 2. Find your game ID and customer role ID

- Game ID: open your Minecraft Java blueprint in the panel and check the
  URL, or call `GET /api/Game/Search?Filter=ShortName==minecraft`.
- Customer role ID: `GET /api/Role/Search`. **This is required** — a TCAdmin
  Update with no roles assigned is admin-only, so without it customers
  won't see anything this worker creates.

### 3. Add the bootstrap script to TCAdmin (optional but recommended)

Paste [`tcadmin-scripts/after-update-install.cs`](tcadmin-scripts/after-update-install.cs)
into a new C# script on the game blueprint, enable it for the
`AfterUpdateInstall` event, and save. It accepts the Minecraft EULA and
seeds `server.properties` with the service's real port on first install —
without touching your blueprint's existing startup command.

Copy its Script ID into `TCADMIN_BOOTSTRAP_SCRIPT_ID` in `wrangler.jsonc` so
every Update the worker creates gets it attached automatically. Leave it
blank to skip this and manage EULA/properties yourself.

### 4. Configure and deploy the worker

```bash
npm install
```

Edit `wrangler.jsonc`:

- `TCADMIN_BASE_URL` — your panel URL (already set to
  `https://gamecp-beta.hyperlayer.net`).
- `TCADMIN_GAME_ID` — from step 2.
- `TCADMIN_CUSTOMER_ROLE_IDS` — from step 2 (comma-separated if more than one).
- `TCADMIN_BOOTSTRAP_SCRIPT_ID` — from step 3, or leave blank.
- `MCJARFILES_VARIANTS` — leave blank for the sensible default set (see
  `src/variants.ts`), or override e.g. `servers/paper,servers/purpur`.

Set the two secrets (never go in `wrangler.jsonc`):

```bash
npx wrangler secret put TCADMIN_API_KEY
npx wrangler secret put SYNC_TRIGGER_SECRET
```

Then deploy:

```bash
npm run deploy
```

### 5. Run it once and check the panel

The cron fires on its own schedule, but you can trigger a run immediately:

```bash
curl "https://mcjarfiles-tcadmin-sync.<your-subdomain>.workers.dev/sync?secret=<SYNC_TRIGGER_SECRET>"
```

It returns a JSON summary per server type (versions found / created /
errors). Check the game blueprint's Updates page in TCAdmin — you should see
groups like "Paper", "Purpur", "Vanilla" populated with every version, and a
customer with the configured role should be able to install one from their
service panel.

### Icons

Every Update `sync` creates gets an icon automatically (see `icon` in
`src/variants.ts` — one per server type, sourced from the same icons
mcjarfiles.com itself uses). If you added icon support after some Updates
already existed, backfill them once (repeatable/idempotent — safe to run
again, it only touches records whose icon doesn't match yet):

```bash
curl "https://mcjarfiles-tcadmin-sync.<your-subdomain>.workers.dev/backfill-icons?secret=<SYNC_TRIGGER_SECRET>"
```

It only updates up to 10 records per call (same rate-limit reasoning as
`sync`'s creates), so call it a few times in a row — or just wait, since it's
safe to leave for a future manual run — until `checked` comes back `0`.

### Duplicate cleanup

`sync`'s dedup check reads TCAdmin's Update list before creating anything.
If that read ever comes back stale or incomplete for any reason (this
happened once here — see the Cloudflare edge-cache note in
`src/tcadmin.ts` — before `cache: "no-store"` and the cache-busting param
were added), multiple runs can each create their own copy of the same
version. `/dedupe-updates` cleans that up: for every `(groupName, name)`
pair with more than one record, it keeps one (preferring a copy that
already has its icon set) and deletes the rest via the API.

```bash
curl "https://mcjarfiles-tcadmin-sync.<your-subdomain>.workers.dev/dedupe-updates?secret=<SYNC_TRIGGER_SECRET>"
```

Repeatable/idempotent and capped at 15 deletes per call — same pattern as
the other maintenance endpoints. Call it until `duplicateGroups` comes back
`0`. Shouldn't be needed in normal operation now that the cache bug is
fixed; it's here as a one-time cleanup tool and a safety net.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
```

## Adjusting the sync schedule

Edit the cron expression in `wrangler.jsonc` (`triggers.crons`). Every run
diffs against what's already in TCAdmin, so a run that finds nothing new
does one cheap read pass and exits — 5 minutes is safe to leave as-is if you
want new versions to show up as fast as possible.
