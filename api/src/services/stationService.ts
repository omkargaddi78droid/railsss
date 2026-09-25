// In-memory station master with exact and prefix lookup. The source is MongoDB when configured
// (collection `stations`), otherwise data/processed/stations.json produced by the preprocessing step.
import { readFile } from "node:fs/promises";
import type { Db } from "mongodb";

export interface Station {
  code: string;
  name: string;
  all_known_names: string[];
  train_count: number;
}

export interface StationHit {
  code: string;
  name: string;
  label: string;          // "BADNERA JN. (BD)"
  train_count: number;
}

function lowerBound(arr: string[], key: string): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class StationService {
  private byCode = new Map<string, Station>();
  // parallel sorted arrays for O(log n + k) prefix search
  private codeKeys: string[] = [];
  private codeRefs: Station[] = [];
  private nameKeys: string[] = [];
  private nameRefs: Station[] = [];
  source = "none";

  constructor(stations: Station[] = [], source = "memory") {
    this.load(stations, source);
  }

  load(stations: Station[], source: string): void {
    this.byCode = new Map(stations.map((s) => [s.code, s]));
    const byCodeSorted = [...stations].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    this.codeKeys = byCodeSorted.map((s) => s.code);
    this.codeRefs = byCodeSorted;
    // index every known name (canonical + variants) so e.g. "SAWAI MADHOPUR" finds SWM
    const names: [string, Station][] = [];
    for (const s of stations) {
      const keys = new Set([s.name, ...(s.all_known_names ?? [])].map((n) => n.toUpperCase().trim()).filter(Boolean));
      for (const k of keys) names.push([k, s]);
    }
    names.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    this.nameKeys = names.map((n) => n[0]);
    this.nameRefs = names.map((n) => n[1]);
    this.source = source;
  }

  get size(): number {
    return this.byCode.size;
  }

  get(code: string): Station | undefined {
    return this.byCode.get(code.trim().toUpperCase());
  }

  static hit(s: Station): StationHit {
    return { code: s.code, name: s.name, label: `${s.name} (${s.code})`, train_count: s.train_count };
  }

  /**
   * Prefix search over station codes and names (no fuzzy matching). Ranking: exact code, code
   * prefix, name prefix; ties broken by number of trains serving the station, then code.
   */
  search(query: string, limit = 10): StationHit[] {
    const q = query.trim().toUpperCase().replace(/\s+/g, " ");
    if (!q) return [];
    const scored = new Map<string, { s: Station; tier: number }>();
    const add = (s: Station, tier: number) => {
      const prev = scored.get(s.code);
      if (!prev || tier < prev.tier) scored.set(s.code, { s, tier });
    };
    const exact = this.byCode.get(q);
    if (exact) add(exact, 0);
    const scan = (keys: string[], refs: Station[], tier: number) => {
      // collect generously, rank afterwards; bounded so a 1-letter query stays cheap
      for (let i = lowerBound(keys, q), n = 0; i < keys.length && keys[i].startsWith(q) && n < 400; i++, n++) add(refs[i], tier);
    };
    scan(this.codeKeys, this.codeRefs, 1);
    scan(this.nameKeys, this.nameRefs, 2);
    return [...scored.values()]
      .sort((a, b) => a.tier - b.tier || b.s.train_count - a.s.train_count || (a.s.code < b.s.code ? -1 : 1))
      .slice(0, limit)
      .map((x) => StationService.hit(x.s));
  }
}

export async function loadStationsFromFile(path: string): Promise<Station[]> {
  return JSON.parse(await readFile(path, "utf8")) as Station[];
}

export async function loadStationsFromMongo(db: Db): Promise<Station[]> {
  return db
    .collection<Station>("stations")
    .find({}, { projection: { _id: 0, code: 1, name: 1, all_known_names: 1, train_count: 1 } })
    .toArray();
}
