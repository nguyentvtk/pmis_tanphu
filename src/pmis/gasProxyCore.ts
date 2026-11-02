/**
 * gasProxyCore.ts — lõi của API Proxy `/api/gas` (không phụ thuộc Next.js nên kiểm thử được).
 *
 * Việc làm:
 *  1. Xác thực Google ID token MỘT lần cho mỗi token (tokeninfo, kiểm aud/email_verified/exp) rồi nhớ kết quả
 *     đến hết hạn → các lần gọi sau không tốn mạng. Khoá cache theo EMAIL đã xác thực, không theo chuỗi token
 *     do client gửi, nên không ai đọc được cache của người khác bằng token giả.
 *  2. Cache SWR cho action chỉ-đọc: còn "tươi" → trả ngay (HIT); quá tươi nhưng chưa "ôi" → trả bản cũ ngay
 *     (STALE) và làm mới nền; chưa có → hỏi Apps Script (MISS). Cùng một khoá chỉ có 1 yêu cầu bay (dedupe).
 *  3. Action ghi → chuyển thẳng cho Apps Script, thành công thì xoá toàn bộ cache (đơn giản, an toàn).
 *  4. Chỉ cho các action nằm trong danh sách trắng đi qua; giới hạn kích thước thân yêu cầu.
 *
 * Bộ nhớ cache nằm trong tiến trình (mỗi instance serverless có cache riêng). Đủ cho quy mô một Ban QLDA;
 * muốn dùng chung nhiều instance thì thay `Cache` bằng Redis/KV mà không đổi logic.
 */

export interface ReadPolicy { freshMs: number; staleMs: number }

/** Action đọc + thời gian cache. Điều chỉnh theo độ "nóng" của dữ liệu. */
export const READ_ACTIONS: Record<string, ReadPolicy> = {
  bootstrap:       { freshMs: 15_000, staleMs: 10 * 60_000 },
  ganttBootstrap:  { freshMs: 15_000, staleMs: 10 * 60_000 },
  masterOverview:  { freshMs: 30_000, staleMs: 30 * 60_000 },
  ledgerList:      { freshMs: 10_000, staleMs: 5 * 60_000 },
  portalList:      { freshMs: 10_000, staleMs: 5 * 60_000 },
};
export const WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'createTask', 'receiveTask', 'addProgress', 'confirmTask', 'ingestIct', 'addFieldReport',
  'portalSubmit', 'portalReply', 'portalReview', 'signedUpload',
  'uploadFinish', 'driveRegister', // hoàn tất nộp tệp lớn / đăng ký tệp tự tải lên Drive: đổi dữ liệu nên xoá cache
]);

/** Action đi thẳng, không cache và không xoá cache (từng khúc tệp, phiên tải lên, thư mục Drive). */
export const PASSTHROUGH_ACTIONS: ReadonlySet<string> = new Set([
  'driveFile', 'uploadBegin', 'uploadChunk', 'driveFolder', 'driveScan',
]);

export const MAX_BODY_BYTES = 4_400_000; // dưới giới hạn 4,5 MB của hàm serverless

export type CacheState = 'HIT' | 'STALE' | 'MISS' | 'BYPASS';
export interface ProxyResult { status: number; body: string; cache: CacheState }

export interface ProxyOptions {
  gasUrl: string;
  clientId: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Chạy việc nền sau khi đã trả lời (vd `after` của Next, `waitUntil` của Vercel). */
  defer?: (p: Promise<unknown>) => void;
  maxEntries?: number;
}

interface Entry { at: number; body: string }

const json = (status: number, o: unknown, cache: CacheState = 'BYPASS'): ProxyResult => ({ status, body: JSON.stringify(o), cache });

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createGasProxy(opt: ProxyOptions) {
  const fetchFn = opt.fetchFn ?? fetch;
  const now = opt.now ?? Date.now;
  const maxEntries = opt.maxEntries ?? 500;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<string>>();
  const tokens = new Map<string, { email: string; exp: number }>();
  const tokenPending = new Map<string, Promise<{ email: string; exp: number }>>();

  async function verify(idToken: string): Promise<string> {
    const key = await sha256(idToken);
    const t = tokens.get(key);
    if (t && t.exp > now() + 5_000) return t.email;
    tokens.delete(key);
    let p = tokenPending.get(key);
    if (!p) {
      p = (async () => {
        const r = await fetchFn('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) throw new Error('ID_TOKEN_KHONG_HOP_LE');
        const j = (await r.json()) as { aud?: string; email?: string; email_verified?: string | boolean; exp?: string | number };
        if (j.aud !== opt.clientId) throw new Error('ID_TOKEN_SAI_AUDIENCE');
        if (String(j.email_verified) !== 'true') throw new Error('EMAIL_CHUA_XAC_THUC');
        const exp = Number(j.exp) * 1000;
        if (!(exp > now())) throw new Error('ID_TOKEN_HET_HAN');
        const v = { email: String(j.email).toLowerCase(), exp };
        tokens.set(key, v);
        return v;
      })().finally(() => tokenPending.delete(key));
      tokenPending.set(key, p);
    }
    return (await p).email;
  }

  async function callGas(action: string, idToken: string, payload: unknown): Promise<string> {
    const res = await fetchFn(opt.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // tránh preflight CORS của Apps Script
      body: JSON.stringify({ action, idToken, payload }),
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error('GAS_HTTP_' + res.status);
    return await res.text();
  }

  const isOk = (body: string): boolean => { try { return (JSON.parse(body) as { ok?: boolean }).ok === true; } catch { return false; } };

  function put(key: string, body: string): void {
    cache.delete(key);
    cache.set(key, { at: now(), body });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
  }

  /** Làm mới một khoá, gộp các yêu cầu trùng. */
  function refresh(key: string, action: string, idToken: string, payload: unknown): Promise<string> {
    let p = inflight.get(key);
    if (!p) {
      p = callGas(action, idToken, payload)
        .then((body) => { if (isOk(body)) put(key, body); return body; })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  async function handle(rawBody: string): Promise<ProxyResult> {
    if (rawBody.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'YEU_CAU_QUA_LON' });
    let req: { action?: unknown; idToken?: unknown; payload?: unknown };
    try { req = JSON.parse(rawBody) as typeof req; } catch { return json(400, { ok: false, error: 'JSON_KHONG_HOP_LE' }); }
    const action = typeof req.action === 'string' ? req.action : '';
    const idToken = typeof req.idToken === 'string' ? req.idToken : '';
    const payload = req.payload ?? {};
    const read = READ_ACTIONS[action];
    if (!read && !WRITE_ACTIONS.has(action) && !PASSTHROUGH_ACTIONS.has(action)) return json(400, { ok: false, error: 'ACTION_KHONG_HOP_LE' });
    if (!idToken) return json(401, { ok: false, error: 'THIEU_ID_TOKEN' });

    let email: string;
    try { email = await verify(idToken); } catch (e) { return json(401, { ok: false, error: String((e as Error).message) }); }

    try {
      if (!read) {
        const body = await callGas(action, idToken, payload);
        if (PASSTHROUGH_ACTIONS.has(action)) return { status: 200, body, cache: 'BYPASS' };
        cache.clear(); // sau mọi thao tác ghi, bỏ cache để lần đọc kế tiếp thấy dữ liệu mới
        return { status: 200, body, cache: 'BYPASS' };
      }
      const key = email + '|' + action + '|' + stableStringify(payload);
      const hit = cache.get(key);
      const age = hit ? now() - hit.at : Infinity;
      if (hit && age < read.freshMs) return { status: 200, body: hit.body, cache: 'HIT' };
      if (hit && age < read.staleMs) {
        const bg = refresh(key, action, idToken, payload).catch(() => undefined);
        opt.defer ? opt.defer(bg) : void bg;
        return { status: 200, body: hit.body, cache: 'STALE' };
      }
      const body = await refresh(key, action, idToken, payload);
      return { status: 200, body, cache: 'MISS' };
    } catch (e) {
      return json(502, { ok: false, error: String((e as Error).message || 'GAS_LOI') });
    }
  }

  return { handle, stats: () => ({ entries: cache.size, tokens: tokens.size, inflight: inflight.size }), clear: () => cache.clear() };
}
