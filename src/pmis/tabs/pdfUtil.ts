/** Tiện ích PDF dùng chung cho Tab 5 và Tab 6. */

import { MAX_FILE_BYTES, u8ToBase64 as b64 } from './transfer';

/** Giới hạn tệp nộp: lớn hơn ~2,4 MB tự chuyển sang gửi theo khúc (xem transfer.ts); trần = MAX_FILE_MB ở Apps Script. */
export const MAX_UPLOAD_BYTES = MAX_FILE_BYTES;
export const u8ToBase64 = b64;

export function saveBytes(bytes: Uint8Array, name: string, mime = 'application/pdf'): void {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([ab], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fmtBytes = (n: number): string => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

export const GIAI_DOAN = [
  { v: 'P1', t: 'P1 – Chuẩn bị đầu tư' }, { v: 'P2', t: 'P2 – Thiết kế – Dự toán' }, { v: 'P3', t: 'P3 – Lựa chọn nhà thầu' },
  { v: 'P4', t: 'P4 – Thi công – Giám sát' }, { v: 'P5', t: 'P5 – Nghiệm thu – Bàn giao' }, { v: 'P6', t: 'P6 – Quyết toán – Bảo hành' },
] as const;

export async function sha256Text(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface LedgerRow {
  stt: number | string; thoi_gian: string; nguoi_thuc_hien: string; hanh_dong: string; doi_tuong: string; noi_dung: string; prev_hash: string; hash: string;
}
export interface ChainReport { ok: boolean; checked: number; badAt: (number | string)[]; reasons: string[] }

/**
 * Kiểm tra chuỗi băm của sổ nhật ký. `rows` theo thứ tự CŨ → MỚI. Công thức khớp `audit_` trong Apps Script:
 * hash = SHA-256(prev_hash + thoi_gian + nguoi_thuc_hien + hanh_dong + doi_tuong + noi_dung).
 * Dòng đầu của đoạn được tin prev_hash làm mốc (chỉ kiểm tra các dòng đã tải).
 */
export async function verifyChain(rows: LedgerRow[]): Promise<ChainReport> {
  const bad: (number | string)[] = [];
  const reasons: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const want = await sha256Text(String(r.prev_hash ?? '') + r.thoi_gian + r.nguoi_thuc_hien + r.hanh_dong + r.doi_tuong + r.noi_dung);
    if (want !== String(r.hash)) { bad.push(r.stt); reasons.push(`Dòng ${r.stt}: mã băm không khớp nội dung.`); }
    if (i > 0 && String(r.prev_hash ?? '') !== String(rows[i - 1].hash)) { bad.push(r.stt); reasons.push(`Dòng ${r.stt}: không nối với dòng trước.`); }
  }
  return { ok: bad.length === 0, checked: rows.length, badAt: Array.from(new Set(bad)), reasons };
}
