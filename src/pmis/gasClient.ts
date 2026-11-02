/**
 * gasClient.ts — máy khách gọi `/api/gas` với SWR phía trình duyệt.
 *
 *  - call(action, payload, {swr}) : nếu đã có bản lưu → trả NGAY (vài ms), đồng thời làm mới nền và gọi onUpdate
 *    khi dữ liệu đổi. Chưa có → chờ mạng.
 *  - Bản lưu giữ trong bộ nhớ và (nếu có namespace) trong sessionStorage để lần mở lại hiện tức thì (<100ms).
 *    sessionStorage chỉ sống trong 1 tab và bị xoá khi đóng tab; khoá có email người dùng để máy dùng chung không lẫn.
 *  - Cùng một khoá chỉ có 1 yêu cầu bay (dedupe). Thao tác ghi → xoá cache đọc rồi báo cho người đăng ký.
 *  - Không bao giờ lưu mật khẩu/ID token; token được lấy mới qua getIdToken cho từng yêu cầu.
 */

export type IdTokenProvider = () => Promise<string>;

export interface GasClientOptions {
  getIdToken: IdTokenProvider;
  endpoint?: string;
  fetchFn?: typeof fetch;
  /** Email người dùng (hoặc mã bất kỳ) để cách ly sessionStorage; bỏ trống = chỉ cache trong bộ nhớ. */
  namespace?: string;
  /** Bản lưu cũ hơn mức này (ms) sẽ bị bỏ khi nạp từ sessionStorage. Mặc định 30 phút. */
  maxAgeMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | null;
}

export interface CallOptions<T> {
  /** true (mặc định cho action đọc): trả bản lưu ngay rồi làm mới nền. */
  swr?: boolean;
  onUpdate?: (data: T, meta: { fromCache: false }) => void;
  onError?: (e: Error) => void;
  signal?: AbortSignal;
}

export class GasError extends Error {
  constructor(public code: string, public status = 0) { super(code); this.name = 'GasError'; }
}

export function stableKey(action: string, payload: unknown): string {
  const s = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return '[' + v.map(s).join(',') + ']';
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + s(o[k])).join(',') + '}';
  };
  return action + '|' + s(payload ?? {});
}

interface Entry { at: number; json: string; data: unknown }

export interface GasClient {
  call<T>(action: string, payload?: Record<string, unknown>, o?: CallOptions<T>): Promise<T>;
  /** Đọc tức thời từ bộ nhớ (không gọi mạng). */
  peek<T>(action: string, payload?: Record<string, unknown>): T | undefined;
  /** Gọi action ghi; xoá cache đọc khi thành công. */
  mutate<T>(action: string, payload?: Record<string, unknown>): Promise<T>;
  /** Gọi thẳng, KHÔNG cache, KHÔNG làm mất cache khác, KHÔNG báo subscriber. Dùng cho từng khúc tệp / phiên tải lên. */
  rpc<T>(action: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  invalidate(): void;
  subscribe(fn: () => void): () => void;
  setNamespace(ns: string | undefined): void;
}

const PREFIX = 'pmis:swr:v1:';

export function createGasClient(opt: GasClientOptions): GasClient {
  const endpoint = opt.endpoint ?? '/api/gas';
  const fetchFn = opt.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const maxAge = opt.maxAgeMs ?? 30 * 60_000;
  let ns = opt.namespace;
  const storage = opt.storage === undefined ? (typeof sessionStorage !== 'undefined' ? sessionStorage : null) : opt.storage;
  const mem = new Map<string, Entry>();
  const inflight = new Map<string, Promise<unknown>>();
  const subs = new Set<() => void>();

  const sKey = (k: string): string => PREFIX + (ns ?? '') + '|' + k;
  const notify = (): void => subs.forEach((f) => f());

  function readStore(k: string): Entry | undefined {
    if (!storage || !ns) return undefined;
    try {
      const raw = storage.getItem(sKey(k));
      if (!raw) return undefined;
      const e = JSON.parse(raw) as { at: number; json: string };
      if (Date.now() - e.at > maxAge) { storage.removeItem(sKey(k)); return undefined; }
      return { at: e.at, json: e.json, data: JSON.parse(e.json) };
    } catch { return undefined; }
  }
  function writeStore(k: string, e: Entry): void {
    if (!storage || !ns) return;
    try { storage.setItem(sKey(k), JSON.stringify({ at: e.at, json: e.json })); } catch { /* đầy bộ nhớ: bỏ qua */ }
  }
  function clearStore(): void {
    if (!storage) return;
    try {
      const del: string[] = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(PREFIX)) del.push(k); }
      del.forEach((k) => storage.removeItem(k));
    } catch { /* bỏ qua */ }
  }

  async function network<T>(action: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const idToken = await opt.getIdToken();
    const res = await fetchFn(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, idToken, payload }), signal, credentials: 'same-origin',
    });
    const j = await res.json().then((x: unknown) => x as { ok?: boolean; data?: T; error?: string } | null, () => null);
    if (!res.ok || !j) throw new GasError(j?.error || 'MAY_CHU_HTTP_' + res.status, res.status);
    if (!j.ok) throw new GasError(j.error || 'LOI_KHONG_XAC_DINH', res.status);
    return j.data as T;
  }

  function fetchAndStore<T>(k: string, action: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let p = inflight.get(k) as Promise<T> | undefined;
    if (!p) {
      p = network<T>(action, payload, signal).then((data) => {
        const e: Entry = { at: Date.now(), json: JSON.stringify(data), data };
        mem.set(k, e); writeStore(k, e);
        return data;
      }).finally(() => inflight.delete(k));
      inflight.set(k, p);
    }
    return p;
  }

  return {
    peek<T>(action: string, payload: Record<string, unknown> = {}) {
      const k = stableKey(action, payload);
      return (mem.get(k) ?? (() => { const e = readStore(k); if (e) mem.set(k, e); return e; })())?.data as T | undefined;
    },

    async call<T>(action: string, payload: Record<string, unknown> = {}, o: CallOptions<T> = {}) {
      const k = stableKey(action, payload);
      const swr = o.swr ?? true;
      let hit = swr ? mem.get(k) : undefined;
      if (swr && !hit) { hit = readStore(k); if (hit) mem.set(k, hit); }
      if (hit) {
        const before = hit.json;
        void fetchAndStore<T>(k, action, payload, o.signal).then((d) => {
          if (JSON.stringify(d) !== before) o.onUpdate?.(d, { fromCache: false });
        }).catch((e) => o.onError?.(e as Error));
        return hit.data as T;
      }
      return fetchAndStore<T>(k, action, payload, o.signal);
    },

    async mutate<T>(action: string, payload: Record<string, unknown> = {}) {
      const data = await network<T>(action, payload);
      mem.clear(); clearStore(); notify();
      return data;
    },

    rpc<T>(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal) { return network<T>(action, payload, signal); },

    invalidate() { mem.clear(); clearStore(); notify(); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    setNamespace(n) { ns = n; },
  };
}
