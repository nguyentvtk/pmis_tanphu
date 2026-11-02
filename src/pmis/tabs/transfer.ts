/**
 * transfer.ts — truyền tệp lớn qua proxy /api/gas bằng từng khúc nhỏ (không bị giới hạn ~4,5 MB của hàm serverless).
 *
 *  - Nộp tệp: ≤ DIRECT_MAX_BYTES gửi một lần (signedUpload / portalSubmit như cũ); lớn hơn thì
 *    uploadBegin → uploadChunk × n (mỗi khúc 2 MiB, tự tiếp tục nếu mất kết nối) → uploadFinish.
 *  - Tải tệp: driveFile theo {offset, length}, ghép lại và kiểm tra SHA-256.
 *  - Thư mục Drive: driveFolder / driveScan / driveRegister.
 * Giới hạn kích thước tối đa do máy chủ quyết định (Script property MAX_FILE_MB, mặc định 20); hằng số ở đây chỉ để báo sớm.
 */
import { GasError } from '../gasClient';
import type { GasClient } from '../gasClient';

export const DIRECT_MAX_BYTES = 2_400_000;
export const CHUNK_BYTES = 2 * 1024 * 1024;
/** Mức báo sớm ở giao diện; PHẢI ≤ MAX_FILE_MB (Script property, mặc định 20) trên Apps Script; muốn nâng thì sửa cả hai nơi. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface Progress { done: number; total: number }
export interface TransferOptions { onProgress?: (p: Progress) => void; signal?: AbortSignal; maxBytes?: number; chunkBytes?: number; retries?: number; backoffMs?: number }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function isRetryable(e: unknown): boolean {
  if (e instanceof GasError) return e.status >= 500 || e.status === 0 || /^(GAS_HTTP_|MAY_CHU_HTTP_5)/.test(e.code);
  return e instanceof TypeError; // lỗi mạng của fetch
}

async function withRetry<T>(fn: () => Promise<T>, o: TransferOptions): Promise<T> {
  const n = o.retries ?? 3;
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= n || !isRetryable(e) || o.signal?.aborted) throw e;
      await sleep((o.backoffMs ?? 600) * 2 ** i);
    }
  }
}

export function u8ToBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  return btoa(s);
}
export function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', ab))).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ───────────────────────── Nộp tệp ───────────────────────── */

export type UploadKind = 'signedUpload' | 'portalSubmit';

/**
 * Gửi PDF đã ký lên Drive + sổ. `meta` là các trường như khi gọi trực tiếp (không kèm base64/sha256).
 * Kết quả giống signedUpload / portalSubmit.
 */
export async function sendPdf<T>(client: GasClient, kind: UploadKind, meta: Record<string, unknown>, bytes: Uint8Array, sha256: string, o: TransferOptions = {}): Promise<T> {
  const max = o.maxBytes ?? MAX_FILE_BYTES;
  if (bytes.length > max) throw new GasError('FILE_QUA_LON', 413);
  o.onProgress?.({ done: 0, total: bytes.length });
  if (bytes.length <= DIRECT_MAX_BYTES) {
    const r = await client.mutate<T>(kind, { ...meta, base64: u8ToBase64(bytes), sha256 });
    o.onProgress?.({ done: bytes.length, total: bytes.length });
    return r;
  }
  const begin = await withRetry(() => client.rpc<{ uploadId: string; chunkBytes: number }>('uploadBegin', { kind, size: bytes.length, sha256, ten_file: meta.ten_file, meta }, o.signal), o);
  const step = Math.max(262144, Math.min(o.chunkBytes ?? begin.chunkBytes ?? CHUNK_BYTES, begin.chunkBytes ?? CHUNK_BYTES));
  let offset = 0, resumes = 0;
  while (offset < bytes.length) {
    if (o.signal?.aborted) throw new GasError('DA_HUY', 0);
    const end = Math.min(bytes.length, offset + step);
    try {
      const r = await withRetry(() => client.rpc<{ received: number }>('uploadChunk', { uploadId: begin.uploadId, offset, base64: u8ToBase64(bytes.subarray(offset, end)) }, o.signal), o);
      offset = r.received;
    } catch (e) {
      // Máy chủ đã nhận tới vị trí khác (khúc trước đã thành công nhưng phản hồi bị mất) → tiếp tục từ đó.
      const m = e instanceof GasError ? /^OFFSET_SAI_(\d+)$/.exec(e.code) : null;
      if (m && resumes++ < 5 && Number(m[1]) <= bytes.length) { offset = Number(m[1]); } else throw e;
    }
    o.onProgress?.({ done: offset, total: bytes.length });
  }
  return client.mutate<T>('uploadFinish', { uploadId: begin.uploadId });
}

/* ───────────────────────── Tải tệp ───────────────────────── */

interface DriveChunk { size: number; offset: number; length: number; done: boolean; base64: string; sha256: string }

/** Tải toàn bộ tệp từ Drive (qua action driveFile). Tối đa `concurrency` khúc song song; kiểm SHA-256 nếu sổ có ghi. */
export async function fetchDriveFile(client: GasClient, fileId: string, o: TransferOptions & { concurrency?: number } = {}): Promise<ArrayBuffer> {
  const first = await withRetry(() => client.rpc<DriveChunk>('driveFile', { fileId }, o.signal), o);
  if ((o.maxBytes ?? MAX_FILE_BYTES) < first.size) throw new GasError('FILE_QUA_LON', 413);
  const out = new Uint8Array(first.size);
  const put = (c: DriveChunk): void => { const u = base64ToU8(c.base64); if (c.offset + u.length > out.length) throw new GasError('KHUC_SAI_KICH_THUOC', 0); out.set(u, c.offset); };
  put(first);
  let got = first.length;
  o.onProgress?.({ done: got, total: first.size });
  if (!first.done) {
    const step = Math.max(1, first.length);
    const offsets: number[] = [];
    for (let off = first.length; off < first.size; off += step) offsets.push(off);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (o.signal?.aborted) throw new GasError('DA_HUY', 0);
        const i = next++; if (i >= offsets.length) return;
        const off = offsets[i];
        const c = await withRetry(() => client.rpc<DriveChunk>('driveFile', { fileId, offset: off, length: step }, o.signal), o);
        if (c.offset !== off || c.length <= 0) throw new GasError('KHUC_KHONG_KHOP', 0);
        put(c); got += c.length; o.onProgress?.({ done: got, total: first.size });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 3, offsets.length)) }, worker));
    if (got !== first.size) throw new GasError('TAI_THIEU_BYTE', 0);
  }
  if (first.sha256 && (await sha256Hex(out)) !== first.sha256.toLowerCase()) throw new GasError('SHA256_TEP_TAI_VE_KHONG_KHOP', 0);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/* ───────────────────────── Thư mục Drive ───────────────────────── */

export interface DriveFolderInfo { maDA: string; url: string; stages: { stage: string; url: string }[] }
export interface DriveScanFile { fileId: string; name: string; stage: string; size: number; isPdf: boolean; updated: string; url: string }
export interface DriveScanResult { maDA: string; files: DriveScanFile[]; truncated: boolean }
export interface DriveRegisterItem { fileId: string; giai_doan: string; so_ky_hieu?: string }
export interface DriveRegisterResult { results: { fileId: string; ok: boolean; error?: string; doc_id?: string; sha256?: string }[]; skipped: number }

export const driveFolder = (c: GasClient, maDA: string): Promise<DriveFolderInfo> => c.rpc('driveFolder', { maDA });
export const driveScan = (c: GasClient, maDA: string, stage?: string): Promise<DriveScanResult> => c.rpc('driveScan', stage ? { maDA, stage } : { maDA });
export const REGISTER_BATCH = 8;
/** Đăng ký theo từng lô ≤ 8 tệp (giới hạn thời gian của Apps Script). */
export async function driveRegister(c: GasClient, maDA: string, items: DriveRegisterItem[], onBatch?: (r: DriveRegisterResult['results']) => void): Promise<DriveRegisterResult['results']> {
  const all: DriveRegisterResult['results'] = [];
  for (let i = 0; i < items.length; i += REGISTER_BATCH) {
    const r = await c.mutate<DriveRegisterResult>('driveRegister', { maDA, items: items.slice(i, i + REGISTER_BATCH) });
    all.push(...r.results); onBatch?.(r.results);
  }
  return all;
}

/** Thông báo lỗi dễ hiểu cho các mã lỗi mới. */
export function transferErrorText(e: unknown): string {
  const code = e instanceof GasError ? e.code : String((e as Error)?.message ?? e);
  const map: Record<string, string> = {
    FILE_QUA_LON: 'Tệp vượt giới hạn dung lượng của hệ thống. Hãy dùng tuỳ chọn mở thư mục Google Drive.',
    PHIEN_TAI_LEN_KHONG_TON_TAI: 'Phiên tải lên đã hết hạn. Hãy thử lại.',
    KHONG_THAY_CHU_KY_SO_TRONG_PDF: 'Máy chủ không thấy chữ ký số trong tệp.',
    SHA256_KHONG_KHOP_TRONG_TRUYEN: 'Tệp bị sai lệch khi truyền (SHA-256 không khớp). Hãy thử lại.',
    TEP_DA_DANG_KY: 'Tệp đã có trong hồ sơ.',
    TEP_KHONG_NAM_TRONG_THU_MUC_DU_AN: 'Tệp không nằm đúng thư mục giai đoạn của dự án.',
    KHONG_PHAI_PDF: 'Tệp không phải PDF.',
    DA_HUY: 'Đã huỷ.',
  };
  return map[code] ?? code;
}
