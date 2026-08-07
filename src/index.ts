import { resolveVariants } from "./variants";
import { getVersions, jarDownloadUrl, latestJarDownloadUrl } from "./mcjarfiles";
import { TCAdminClient, type ExistingUpdate, type NewUpdate } from "./tcadmin";

interface IconBackfillResult {
  checked: number;
  updated: number;
  errors: string[];
}

interface DedupeResult {
  duplicateGroups: number;
  deleted: number;
  errors: string[];
}

export interface Env {
  TCADMIN_BASE_URL: string;
  TCADMIN_GAME_ID: string;
  TCADMIN_CUSTOMER_ROLE_IDS: string;
  TCADMIN_BOOTSTRAP_SCRIPT_ID: string;
  MCJARFILES_VARIANTS: string;
  TCADMIN_API_KEY: string;
  SYNC_TRIGGER_SECRET: string;
}

interface SyncSummary {
  groupName: string;
  found: number;
  created: number;
  errors: string[];
}

const dedupeKey = (groupName: string, name: string) => `${groupName.toLowerCase()}::${name.toLowerCase()}`;

// Every Update saves under this exact name, regardless of server type/
// version, so one startup command and one bootstrap script work everywhere.
const SAVE_AS_FILENAME = "minecraft_server.jar";

// One evergreen Update per variant, grouped together, that always installs
// whatever mcjarfiles.com resolves as newest at install time — the source
// URL (get-latest-jar) never needs updating as new versions ship, so unlike
// the per-version groups these are created once and then just sit there.
const LATEST_GROUP_NAME = "Latest";

// Two hard limits showed up running this against the real panel: Cloudflare
// itself rate-limits bursts of requests to the panel's domain (429, "error
// code: 1015"), and a Worker invocation has a cap on total subrequests. A
// full first-time backfill can be a few hundred versions, well past both.
// So each run only creates up to this many, with a small delay between
// writes — since every run only creates what's still missing, a capped run
// just means the backlog finishes across a few 5-minute cron ticks instead
// of one request.
const MAX_CREATES_PER_RUN = 15;
const DELAY_BETWEEN_CREATES_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CreateBudget {
  used: number;
  max: number;
}

/** Creates one Update if its (groupName, name) key isn't already present, respecting the shared per-run write budget. */
async function createUpdateIfMissing(
  client: TCAdminClient,
  gameId: string,
  existingKeys: Set<string>,
  budget: CreateBudget,
  roles: number[],
  scripts: number[] | undefined,
  params: { groupName: string; name: string; source: string; icon: string; viewOrder: number }
): Promise<"created" | "skipped" | "budget-exhausted" | { error: string }> {
  const key = dedupeKey(params.groupName, params.name);
  if (existingKeys.has(key)) return "skipped";
  if (budget.used >= budget.max) return "budget-exhausted";

  const update: NewUpdate = {
    name: params.name.slice(0, 200),
    groupName: params.groupName,
    source: params.source,
    saveAsFilename: SAVE_AS_FILENAME,
    icon: params.icon,
    reinstallable: true,
    defaultInstall: false,
    viewOrder: params.viewOrder,
    roles,
    scripts,
  };

  try {
    await client.createUpdate(gameId, update);
    existingKeys.add(key);
    budget.used += 1;
    if (budget.used < budget.max) await sleep(DELAY_BETWEEN_CREATES_MS);
    return "created";
  } catch (err) {
    // A write failure this run (rate limit, transient error, ...) is
    // usually a sign to back off rather than hammer the next one
    // immediately — the record stays missing and gets retried next run.
    await sleep(DELAY_BETWEEN_CREATES_MS);
    return { error: String(err) };
  }
}

async function sync(env: Env): Promise<SyncSummary[]> {
  if (!env.TCADMIN_GAME_ID || env.TCADMIN_GAME_ID === "REPLACE_ME") {
    throw new Error("TCADMIN_GAME_ID is not configured (see wrangler.jsonc).");
  }
  if (!env.TCADMIN_CUSTOMER_ROLE_IDS || env.TCADMIN_CUSTOMER_ROLE_IDS === "REPLACE_ME") {
    throw new Error("TCADMIN_CUSTOMER_ROLE_IDS is not configured — updates would be created admin-only.");
  }
  if (!env.TCADMIN_API_KEY) {
    // Every write would otherwise 401 silently (it's caught per-item into
    // that version's errors array), burning through the create cap on
    // guaranteed failures and looking like nothing is happening at all.
    throw new Error("TCADMIN_API_KEY secret is not set (wrangler secret put TCADMIN_API_KEY).");
  }

  const roles = env.TCADMIN_CUSTOMER_ROLE_IDS.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  const scripts = env.TCADMIN_BOOTSTRAP_SCRIPT_ID ? [Number(env.TCADMIN_BOOTSTRAP_SCRIPT_ID)] : undefined;

  const client = new TCAdminClient(env.TCADMIN_BASE_URL, env.TCADMIN_API_KEY);
  const variants = resolveVariants(env.MCJARFILES_VARIANTS);

  const existing = await client.listAllUpdates(env.TCADMIN_GAME_ID);
  const existingKeys = new Set(existing.map((u) => dedupeKey(u.groupName ?? "", u.name ?? "")));

  const summaries: SyncSummary[] = [];
  const budget: CreateBudget = { used: 0, max: MAX_CREATES_PER_RUN };

  // The "Latest" group first — it's just one evergreen entry per variant
  // (found: variants.length, never more), so it's cheap and worth getting
  // done before the potentially-hundreds-deep per-version backfill below
  // eats the whole budget.
  const latestSummary: SyncSummary = { groupName: LATEST_GROUP_NAME, found: variants.length, created: 0, errors: [] };
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const result = await createUpdateIfMissing(client, env.TCADMIN_GAME_ID, existingKeys, budget, roles, scripts, {
      groupName: LATEST_GROUP_NAME,
      name: v.groupName,
      source: latestJarDownloadUrl(v.type, v.variant),
      icon: v.icon,
      viewOrder: i,
    });
    if (result === "created") latestSummary.created += 1;
    else if (typeof result === "object") latestSummary.errors.push(`${v.groupName}: ${result.error}`);
  }
  summaries.push(latestSummary);

  for (const v of variants) {
    const summary: SyncSummary = { groupName: v.groupName, found: 0, created: 0, errors: [] };

    if (budget.used >= budget.max) {
      summaries.push(summary);
      continue;
    }

    let versions: string[];
    try {
      versions = await getVersions(v.type, v.variant);
    } catch (err) {
      summary.errors.push(String(err));
      summaries.push(summary);
      continue;
    }

    summary.found = versions.length;

    // mcjarfiles returns newest-first; keep that as install-list order.
    for (let i = 0; i < versions.length && budget.used < budget.max; i++) {
      const version = versions[i];
      const result = await createUpdateIfMissing(client, env.TCADMIN_GAME_ID, existingKeys, budget, roles, scripts, {
        groupName: v.groupName,
        name: version,
        source: jarDownloadUrl(v.type, v.variant, version),
        icon: v.icon,
        viewOrder: i,
      });
      if (result === "created") summary.created += 1;
      else if (typeof result === "object") summary.errors.push(`${version}: ${result.error}`);
    }

    summaries.push(summary);
  }

  return summaries;
}

const MAX_ICON_BACKFILL_PER_RUN = 10;

/**
 * One-time (repeatable/idempotent) pass to set icons on Updates created
 * before icon support was added. Not run by the cron — trigger manually via
 * /backfill-icons until `checked` comes back 0. Kept separate from `sync`
 * so the recurring job's request budget stays focused on new versions.
 */
async function backfillIcons(env: Env): Promise<IconBackfillResult> {
  if (!env.TCADMIN_GAME_ID || env.TCADMIN_GAME_ID === "REPLACE_ME") {
    throw new Error("TCADMIN_GAME_ID is not configured (see wrangler.jsonc).");
  }
  if (!env.TCADMIN_API_KEY) {
    throw new Error("TCADMIN_API_KEY secret is not set (wrangler secret put TCADMIN_API_KEY).");
  }

  const client = new TCAdminClient(env.TCADMIN_BASE_URL, env.TCADMIN_API_KEY);
  const variants = resolveVariants(env.MCJARFILES_VARIANTS);
  const iconByGroup = new Map(variants.map((v) => [v.groupName.toLowerCase(), v.icon]));

  const existing = await client.listAllUpdates(env.TCADMIN_GAME_ID);
  const needsIcon = existing.filter((u) => {
    const expected = iconByGroup.get((u.groupName ?? "").toLowerCase());
    return expected && u.icon !== expected;
  });

  const result: IconBackfillResult = { checked: needsIcon.length, updated: 0, errors: [] };

  for (const u of needsIcon.slice(0, MAX_ICON_BACKFILL_PER_RUN)) {
    try {
      // PUT replaces the whole record, so fetch the full DTO (roles/scripts
      // included) first rather than risk clobbering it with a partial body.
      const full = await client.getUpdate(env.TCADMIN_GAME_ID, u.updateId);
      full.icon = iconByGroup.get((u.groupName ?? "").toLowerCase());
      await client.updateUpdate(env.TCADMIN_GAME_ID, u.updateId, full);
      result.updated += 1;
    } catch (err) {
      result.errors.push(`updateId ${u.updateId} (${u.name}): ${err}`);
    }
    await sleep(DELAY_BETWEEN_CREATES_MS);
  }

  return result;
}

const MAX_DELETES_PER_RUN = 15;

/**
 * One-time (repeatable/idempotent) cleanup for duplicate Updates created
 * during the window before the Cloudflare edge-cache fix (see the note in
 * src/tcadmin.ts) — every `sync` run's dedup check was reading a stale
 * cached list, so several runs in a row didn't see versions earlier runs
 * had already created and recreated them. Not run by the cron; trigger
 * manually via /dedupe-updates until `duplicateGroups` comes back 0.
 */
async function dedupeUpdates(env: Env): Promise<DedupeResult> {
  if (!env.TCADMIN_GAME_ID || env.TCADMIN_GAME_ID === "REPLACE_ME") {
    throw new Error("TCADMIN_GAME_ID is not configured (see wrangler.jsonc).");
  }
  if (!env.TCADMIN_API_KEY) {
    throw new Error("TCADMIN_API_KEY secret is not set (wrangler secret put TCADMIN_API_KEY).");
  }

  const client = new TCAdminClient(env.TCADMIN_BASE_URL, env.TCADMIN_API_KEY);
  const existing = await client.listAllUpdates(env.TCADMIN_GAME_ID);

  const groups = new Map<string, ExistingUpdate[]>();
  for (const u of existing) {
    const key = dedupeKey(u.groupName ?? "", u.name ?? "");
    const bucket = groups.get(key) ?? [];
    bucket.push(u);
    groups.set(key, bucket);
  }

  const toDelete: ExistingUpdate[] = [];
  let duplicateGroups = 0;
  for (const records of groups.values()) {
    if (records.length <= 1) continue;
    duplicateGroups += 1;
    // Keep one per group: prefer a copy that already has its icon set (from
    // the icon backfill), then the lowest updateId (the original, oldest
    // copy) among any remaining ties.
    const [, ...rest] = [...records].sort((a, b) => {
      const aHasIcon = a.icon ? 0 : 1;
      const bHasIcon = b.icon ? 0 : 1;
      return aHasIcon !== bHasIcon ? aHasIcon - bHasIcon : a.updateId - b.updateId;
    });
    toDelete.push(...rest);
  }

  const result: DedupeResult = { duplicateGroups, deleted: 0, errors: [] };

  for (const u of toDelete.slice(0, MAX_DELETES_PER_RUN)) {
    try {
      await client.deleteUpdate(env.TCADMIN_GAME_ID, u.updateId);
      result.deleted += 1;
    } catch (err) {
      result.errors.push(`updateId ${u.updateId} (${u.groupName}/${u.name}): ${err}`);
    }
    await sleep(DELAY_BETWEEN_CREATES_MS);
  }

  return result;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      sync(env).then((summaries) => {
        console.log("mcjarfiles sync complete", JSON.stringify(summaries));
      })
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/sync" && request.method === "GET") {
      if (url.searchParams.get("secret") !== env.SYNC_TRIGGER_SECRET || !env.SYNC_TRIGGER_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const summaries = await sync(env);
        return Response.json({ ok: true, summaries });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/backfill-icons" && request.method === "GET") {
      if (url.searchParams.get("secret") !== env.SYNC_TRIGGER_SECRET || !env.SYNC_TRIGGER_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const result = await backfillIcons(env);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/dedupe-updates" && request.method === "GET") {
      if (url.searchParams.get("secret") !== env.SYNC_TRIGGER_SECRET || !env.SYNC_TRIGGER_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const result = await dedupeUpdates(env);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    return new Response(
      "mcjarfiles-tcadmin-sync: GET /sync?secret=... to trigger manually, GET /backfill-icons?secret=... to backfill icons on older Updates, GET /dedupe-updates?secret=... to remove duplicate Updates.",
      { status: 200 }
    );
  },
};
