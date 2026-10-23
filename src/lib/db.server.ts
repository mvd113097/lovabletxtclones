import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  saveNovelToFirestore,
  deleteNovelFromFirestore,
  saveChapterToFirestore,
  saveSettingsToFirestore,
  syncDownFromFirestore,
} from "./firestore.server";

export interface NovelRow {
  id: string;
  title: string;
  status: "running" | "paused" | "done";
  total_chapters: number;
  created_at: string;
  finished_at: string | null;
  notified: boolean;
}

export interface ChapterRow {
  novel_id: string;
  idx: number;
  title: string;
  source_text: string;
  translated_title: string | null;
  translated_text: string | null;
  status: "pending" | "working" | "done";
  engine: string | null;
  attempts: number;
  locked_at: string | null;
  last_error: string | null;
  word_count: number;
  partial: Record<string, unknown>;
}

export interface AppSettingsRow {
  id: number;
  passcode_hash: string | null;
  telegram_chat_id: string | null;
  gemini_api_key?: string | null;
  cron_secret: string;
  tick_url: string;
}

interface DbData {
  settings: AppSettingsRow;
  novels: NovelRow[];
  chapters: ChapterRow[];
}

const DATA_DIR = path.resolve(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "megatxt-db.json");

function getDefaultSettings(): AppSettingsRow {
  return {
    id: 1,
    passcode_hash: null,
    telegram_chat_id: null,
    gemini_api_key: process.env["GEMINI_API_KEY"] ?? null,
    cron_secret: crypto.randomBytes(24).toString("hex"),
    tick_url: "/api/public/tick",
  };
}

export function getSavedGeminiKey(): string {
  if (process.env["NODE_ENV"] === "test" || process.env["VITEST"]) return "";
  const db = loadDb();
  return db.settings.gemini_api_key ?? "";
}

let dbData: DbData | null = null;
let hasHydratedFromFirestore = false;
let isHydratingFromFirestore = false;

function saveDbLocalOnly() {
  if (!dbData) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(dbData, null, 2), "utf-8");
  } catch (err) {
    console.error("[MegaTXT DB] Failed to persist local cache:", err);
  }
}

export async function hydrateFromFirestore(force = false) {
  if (!force && (hasHydratedFromFirestore || isHydratingFromFirestore)) return;
  isHydratingFromFirestore = true;
  try {
    const data = await syncDownFromFirestore();
    if (data) {
      const current = loadDb();
      if (data.novels && data.novels.length > 0) {
        const localMap = new Map(current.novels.map((n) => [n.id, n]));
        for (const cloudNovel of data.novels) {
          const local = localMap.get(cloudNovel.id);
          if (!local) {
            current.novels.push(cloudNovel);
          } else {
            local.status = cloudNovel.status;
            local.finished_at = cloudNovel.finished_at;
            local.total_chapters = cloudNovel.total_chapters;
          }
        }
      }
      if (data.chapters && data.chapters.length > 0) {
        const localChapMap = new Map(current.chapters.map((c) => [`${c.novel_id}_${c.idx}`, c]));
        for (const cloudChap of data.chapters) {
          const key = `${cloudChap.novel_id}_${cloudChap.idx}`;
          const local = localChapMap.get(key);
          if (!local) {
            current.chapters.push(cloudChap);
          } else if (cloudChap.status === "done" && local.status !== "done") {
            Object.assign(local, cloudChap);
          }
        }
      }
      if (data.settings && data.settings.passcode_hash) {
        current.settings = data.settings;
      }
      saveDbLocalOnly();
      console.log(
        `[Firestore] Synced ${current.novels.length} novels and ${current.chapters.length} chapters.`,
      );
    }
    hasHydratedFromFirestore = true;
  } catch (err) {
    console.warn("[Firestore] Hydration warning:", err);
  } finally {
    isHydratingFromFirestore = false;
  }
}

function loadDb(): DbData {
  if (!hasHydratedFromFirestore && !isHydratingFromFirestore) {
    hydrateFromFirestore().catch(() => {});
  }
  if (dbData) return dbData;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DbData>;
      dbData = {
        settings: parsed.settings ?? getDefaultSettings(),
        novels: parsed.novels ?? [],
        chapters: parsed.chapters ?? [],
      };
      // Unstick any chapters orphaned by process restarts or crashes
      const twoMinAgo = Date.now() - 2 * 60 * 1000;
      let unstuck = false;
      for (const ch of dbData.chapters) {
        if (ch.status === "working") {
          const lockedAt = ch.locked_at ? new Date(ch.locked_at).getTime() : 0;
          if (lockedAt < twoMinAgo) {
            ch.status = "pending";
            ch.locked_at = null;
            unstuck = true;
          }
        }
      }
      if (unstuck) saveDb();
      return dbData;
    }
  } catch (err) {
    console.warn("[MegaTXT DB] Could not read db file, initializing fresh store:", err);
  }
  dbData = {
    settings: getDefaultSettings(),
    novels: [],
    chapters: [],
  };
  saveDb();
  return dbData;
}

function saveDb() {
  if (!dbData) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(dbData, null, 2), "utf-8");
  } catch (err) {
    console.error("[MegaTXT DB] Failed to persist data:", err);
  }
}

// Self-perpetuating cloud translation loop: keeps active HTTP connections so Cloud Run never throttles CPU
let tickActive = false;

export function ensureTick() {
  if (tickActive) return;
  tickActive = true;

  (async () => {
    console.log("[MegaTXT Background Engine] Starting background translation runner...");
    while (tickActive) {
      const db = loadDb();
      const runningNovels = db.novels.filter((n) => n.status === "running");
      if (!runningNovels.length) {
        console.log("[MegaTXT Background Engine] No running novels. Runner idle.");
        tickActive = false;
        break;
      }

      const port = process.env.PORT || 3000;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/public/tick`, {
          signal: AbortSignal.timeout(50_000),
        });
        const data = (await res.json().catch(() => null)) as {
          processed?: number;
          remaining?: number;
        } | null;
        if (data && data.remaining === 0) {
          console.log("[MegaTXT Background Engine] All chapters complete!");
          tickActive = false;
          break;
        }
      } catch {
        // Fallback direct run if internal network is not yet ready
        try {
          const { runTick } = await import("./worker.server");
          const r = await runTick();
          if (r.remaining === 0) {
            tickActive = false;
            break;
          }
        } catch (innerErr) {
          console.warn("[MegaTXT Background Engine] Worker cycle error:", innerErr);
        }
      }

      // Small pause between batches
      await new Promise((r) => setTimeout(r, 1500));
    }
  })().catch((err) => {
    console.error("[MegaTXT Background Engine] Uncaught error:", err);
    tickActive = false;
  });
}

export function stopTick() {
  tickActive = false;
}

// Auto-start worker if any novel is currently marked running
setTimeout(() => {
  try {
    const db = loadDb();
    if (db.novels.some((n) => n.status === "running")) {
      ensureTick();
    }
  } catch {
    // Ignored
  }
}, 1000);

export function claimChapters(_limit: number): ChapterRow[] {
  const db = loadDb();
  const runningNovelIds = new Set(db.novels.filter((n) => n.status === "running").map((n) => n.id));
  if (!runningNovelIds.size) return [];

  const now = Date.now();
  const fourMinAgo = now - 4 * 60 * 1000;
  const candidates = db.chapters.filter((c) => {
    if (!runningNovelIds.has(c.novel_id)) return false;
    if (c.status === "pending") return true;
    if (c.status === "working") {
      const lockedAt = c.locked_at ? new Date(c.locked_at).getTime() : 0;
      return lockedAt < fourMinAgo;
    }
    return false;
  });

  const novelCreatedMap = new Map(db.novels.map((n) => [n.id, new Date(n.created_at).getTime()]));
  candidates.sort((a, b) => {
    const na = novelCreatedMap.get(a.novel_id) ?? 0;
    const nb = novelCreatedMap.get(b.novel_id) ?? 0;
    if (na !== nb) return na - nb;
    return a.idx - b.idx;
  });

  const claimed = candidates.slice(0, _limit);
  const nowIso = new Date().toISOString();
  for (const c of claimed) {
    c.status = "working";
    c.locked_at = nowIso;
    c.attempts = (c.attempts || 0) + 1;
    saveChapterToFirestore(c).catch(() => {});
  }
  saveDb();
  return claimed;
}

export function novelProgress() {
  const db = loadDb();
  return db.novels.map((n) => {
    const nChapters = db.chapters.filter((c) => c.novel_id === n.id);
    const total = nChapters.length;
    const done = nChapters.filter((c) => c.status === "done").length;
    const google = nChapters.filter((c) => c.engine === "google").length;
    const byIdx = new Map(nChapters.map((c) => [c.idx, c]));

    let ready = 0;
    for (let i = 0; i < n.total_chapters; i++) {
      const c = byIdx.get(i);
      if (c && c.status === "done") {
        ready++;
      } else {
        break;
      }
    }

    let readyWords = 0;
    for (let i = 0; i < ready; i++) {
      readyWords += byIdx.get(i)?.word_count ?? 0;
    }

    const lastError =
      nChapters.find((c) => c.last_error && c.status !== "done")?.last_error ?? null;

    return {
      novel_id: n.id,
      total,
      done,
      google,
      ready,
      ready_words: readyWords,
      last_error: lastError,
    };
  });
}

// Compatible Supabase Admin query mock builder
type FilterOp = (row: Record<string, unknown>) => boolean;

class QueryBuilder {
  private table: string;
  private filters: FilterOp[] = [];
  private orderField?: string;
  private orderAscending = true;
  private rangeStart = 0;
  private rangeEnd?: number;
  private isSingle = false;
  private isMaybeSingle = false;
  private isCount = false;
  private selectFields?: string;

  private updatePatch?: Record<string, unknown>;
  private insertData?: Record<string, unknown>;
  private isUpdate = false;
  private isDelete = false;
  private isInsert = false;

  constructor(table: string) {
    this.table = table;
  }

  select(fields = "*", options?: { count?: string; head?: boolean }) {
    this.selectFields = fields;
    if (options?.count) this.isCount = true;
    return this;
  }

  eq(col: string, val: unknown) {
    if (col === "novels.status" && this.table === "chapters") {
      this.filters.push((r) => {
        const db = loadDb();
        const novel = db.novels.find((n) => n.id === r["novel_id"]);
        return novel?.status === val;
      });
      return this;
    }
    this.filters.push((r) => r[col] === val);
    return this;
  }

  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] !== val);
    return this;
  }

  is(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  order(col: string, { ascending = true } = {}) {
    this.orderField = col;
    this.orderAscending = ascending;
    return this;
  }

  range(from: number, to: number) {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  maybeSingle() {
    this.isMaybeSingle = true;
    return this;
  }

  private getTableRows(): Record<string, unknown>[] {
    const db = loadDb();
    if (this.table === "app_settings") return [db.settings as unknown as Record<string, unknown>];
    if (this.table === "novels") return db.novels as unknown as Record<string, unknown>[];
    if (this.table === "chapters") return db.chapters as unknown as Record<string, unknown>[];
    return [];
  }

  private project(row: Record<string, unknown>) {
    if (!row || !this.selectFields || this.selectFields === "*") return row;
    const fields = this.selectFields.split(",").map((f) => f.trim());
    const res: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.includes("!")) continue;
      res[f] = row[f];
    }
    return res;
  }

  insert(data: Record<string, unknown>) {
    this.isInsert = true;
    this.insertData = data;
    return this;
  }

  async upsert(
    items: Record<string, unknown>[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    const db = loadDb();
    if (this.table === "chapters") {
      for (const item of items) {
        const existing = db.chapters.find(
          (c) => c.novel_id === item["novel_id"] && c.idx === item["idx"],
        );
        if (existing) {
          if (!options?.ignoreDuplicates) {
            Object.assign(existing, item);
          }
          saveChapterToFirestore(existing).catch(() => {});
        } else {
          const ch: ChapterRow = {
            novel_id: item["novel_id"] as string,
            idx: item["idx"] as number,
            title: (item["title"] as string) ?? "",
            source_text: (item["source_text"] as string) ?? "",
            translated_title: null,
            translated_text: null,
            status: (item["status"] as "pending" | "working" | "done") ?? "pending",
            engine: null,
            attempts: 0,
            locked_at: null,
            last_error: null,
            word_count: 0,
            partial: {},
          };
          db.chapters.push(ch);
          saveChapterToFirestore(ch).catch(() => {});
        }
      }
      saveDb();
      return { error: null };
    }
    return { error: null };
  }

  update(patch: Record<string, unknown>) {
    this.isUpdate = true;
    this.updatePatch = patch;
    return this;
  }

  delete() {
    this.isDelete = true;
    return this;
  }

  // Thenable to support `await query`
  then(resolve: (res: unknown) => void, reject?: (err: unknown) => void) {
    try {
      if (this.isInsert && this.insertData) {
        const db = loadDb();
        if (this.table === "novels") {
          const item: NovelRow = {
            id: (this.insertData["id"] as string) ?? crypto.randomUUID(),
            title: (this.insertData["title"] as string) ?? "Untitled",
            status: (this.insertData["status"] as "running" | "paused" | "done") ?? "paused",
            total_chapters: (this.insertData["total_chapters"] as number) ?? 0,
            created_at: new Date().toISOString(),
            finished_at: null,
            notified: false,
          };
          db.novels.unshift(item);
          saveDb();
          saveNovelToFirestore(item).catch(() => {});
          const proj = this.project(item as unknown as Record<string, unknown>);
          resolve({ data: this.isSingle ? proj : [proj], error: null });
          return;
        }
        resolve({ data: null, error: null });
        return;
      }

      const rows = this.getTableRows();
      let matched = rows.filter((r) => this.filters.every((f) => f(r)));

      if (this.isUpdate && this.updatePatch) {
        for (const r of matched) {
          Object.assign(r, this.updatePatch);
          if (this.table === "novels") saveNovelToFirestore(r as NovelRow).catch(() => {});
          if (this.table === "chapters") saveChapterToFirestore(r as ChapterRow).catch(() => {});
          if (this.table === "app_settings")
            saveSettingsToFirestore(r as AppSettingsRow).catch(() => {});
        }
        saveDb();
      } else if (this.isDelete) {
        if (this.table === "novels") {
          const db = loadDb();
          const toDeleteIds = new Set(matched.map((n) => n["id"] as string));
          db.novels = db.novels.filter((n) => !toDeleteIds.has(n.id));
          db.chapters = db.chapters.filter((c) => !toDeleteIds.has(c.novel_id));
          saveDb();
          for (const toDelId of toDeleteIds) {
            deleteNovelFromFirestore(toDelId).catch(() => {});
          }
        }
      }

      if (this.orderField) {
        const field = this.orderField;
        const asc = this.orderAscending;
        matched.sort((a, b) => {
          const va = a[field] as string | number;
          const vb = b[field] as string | number;
          if (va < vb) return asc ? -1 : 1;
          if (va > vb) return asc ? 1 : -1;
          return 0;
        });
      }

      const totalCount = matched.length;

      if (this.rangeEnd !== undefined) {
        matched = matched.slice(this.rangeStart, this.rangeEnd + 1);
      }

      if (this.isSingle) {
        const singleRow = matched[0] ? this.project(matched[0]) : null;
        if (!singleRow) {
          resolve({ data: null, error: new Error("Row not found"), count: totalCount });
          return;
        }
        resolve({ data: singleRow, error: null, count: totalCount });
        return;
      }

      if (this.isMaybeSingle) {
        const singleRow = matched[0] ? this.project(matched[0]) : null;
        resolve({ data: singleRow, error: null, count: totalCount });
        return;
      }

      const projected = matched.map((r) => this.project(r));
      resolve({ data: projected, count: totalCount, error: null });
    } catch (err) {
      if (reject) reject(err);
      else resolve({ data: null, error: err });
    }
  }
}

export function createEmbeddedSupabaseAdmin() {
  return {
    from: (table: string) => new QueryBuilder(table),
    rpc: async (func: string, args?: Record<string, unknown>) => {
      if (func === "claim_chapters") {
        const limit = Number(args?.["_limit"] ?? 3);
        const claimed = claimChapters(limit);
        return { data: claimed, error: null };
      }
      if (func === "novel_progress") {
        const prog = novelProgress();
        return { data: prog, error: null };
      }
      if (func === "ensure_tick") {
        ensureTick();
        return { error: null };
      }
      if (func === "stop_tick") {
        stopTick();
        return { error: null };
      }
      return { data: null, error: null };
    },
  };
}
