// Thin client for the TCAdmin v3 REST API, scoped to the "Game Updates"
// endpoints this sync needs. Full API reference: {baseUrl}/scalar/

export interface ExistingUpdate {
  updateId: number;
  gameId: number;
  name: string | null;
  groupName: string | null;
  source: string | null;
  icon: string | null;
}

export interface NewUpdate {
  name: string;
  groupName?: string;
  comments?: string;
  source?: string;
  saveAsFilename?: string;
  extractPath?: string;
  reinstallable: boolean;
  defaultInstall: boolean;
  viewOrder: number;
  icon?: string;
  roles?: number[];
  scripts?: number[];
}

/** Full record shape returned by the single-item GET, used as the PUT body for edits. */
export interface FullUpdate extends NewUpdate {
  updateId: number;
  gameId: number;
}

export class TCAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      // Confirmed against the live panel: Cloudflare's edge is caching GET
      // /api/Game/{id}/Updates responses (cf-cache-status: HIT, Age in the
      // thousands of seconds) despite it being a dynamic API — a stale hit
      // made the sync's dedup logic think old data was current. `no-store`
      // plus the cache-busting query param on GETs (see listAllUpdates)
      // belt-and-braces this; the real fix is a Cache Rule on the zone
      // excluding /api/* from caching.
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        // Confirmed against the live panel: TCAdmin's ApiKey auth reads the
        // key from X-Api-Key, not Authorization: Bearer (that scheme gets an
        // explicit 401; X-Api-Key and "Authorization: ApiKey <key>" both
        // work — X-Api-Key is used here since it's the more conventional of
        // the two working options).
        "X-Api-Key": this.apiKey,
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TCAdmin API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${body}`);
    }

    if (res.status === 200 && res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return res.json();
  }

  /** Fetches every existing Update for a game, paging through the full result set. */
  async listAllUpdates(gameId: string): Promise<ExistingUpdate[]> {
    const pageSize = 200;
    let page = 1;
    const all: ExistingUpdate[] = [];

    for (;;) {
      // Cache-buster: this exact query string is what got stuck cached at
      // Cloudflare's edge before (see the note in `request`). A varying
      // param guarantees each call is a fresh URL.
      const cacheBuster = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await this.request<{ count: number; data: ExistingUpdate[] }>(
        `/api/Game/${gameId}/Updates?Page=${page}&PageSize=${pageSize}&_cb=${cacheBuster}`
      );
      all.push(...(result.data ?? []));
      if (all.length >= result.count || !result.data || result.data.length < pageSize) {
        break;
      }
      page += 1;
    }

    return all;
  }

  async createUpdate(gameId: string, update: NewUpdate): Promise<void> {
    await this.request(`/api/Game/${gameId}/Updates`, {
      method: "POST",
      body: JSON.stringify(update),
    });
  }

  /** Full single-item fetch (includes roles/scripts) — required before a PUT, since PUT replaces the whole record. */
  async getUpdate(gameId: string, updateId: number): Promise<FullUpdate> {
    const cacheBuster = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return this.request<FullUpdate>(`/api/Game/${gameId}/Updates/${updateId}?_cb=${cacheBuster}`);
  }

  async updateUpdate(gameId: string, updateId: number, update: FullUpdate): Promise<void> {
    await this.request(`/api/Game/${gameId}/Updates/${updateId}`, {
      method: "PUT",
      body: JSON.stringify(update),
    });
  }

  async deleteUpdate(gameId: string, updateId: number): Promise<void> {
    await this.request(`/api/Game/${gameId}/Updates/${updateId}`, { method: "DELETE" });
  }
}
