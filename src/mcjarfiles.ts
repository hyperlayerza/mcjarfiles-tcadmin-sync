// Thin client for the mcjarfiles.com public REST API.
// Docs: https://mcjarfiles.com/api-docs — no auth required, plain GET JSON.

const BASE_URL = "https://mcjarfiles.com/api";

/** Lists every available version for a type/variant, newest first. */
export async function getVersions(type: string, variant: string): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/get-versions/${type}/${variant}`);
  if (!res.ok) {
    throw new Error(`mcjarfiles get-versions ${type}/${variant} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** The direct-download URL for a specific version's jar (not a static file name). */
export function jarDownloadUrl(type: string, variant: string, version: string): string {
  return `${BASE_URL}/get-jar/${type}/${variant}/${encodeURIComponent(version)}`;
}

/**
 * The direct-download URL for whichever build is newest at install time —
 * mcjarfiles resolves this dynamically, so this URL never needs updating as
 * new versions ship. Good for a "Latest" Update that never goes stale.
 */
export function latestJarDownloadUrl(type: string, variant: string): string {
  return `${BASE_URL}/get-latest-jar/${type}/${variant}`;
}
