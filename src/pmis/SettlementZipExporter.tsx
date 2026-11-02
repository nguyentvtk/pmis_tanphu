'use client';
/**
 * SettlementZipExporter.tsx — Đóng gói hồ sơ quyết toán 6 giai đoạn (.zip) theo TT 73/2026/TT-BTC.
 *
 * Với một maDA: gom PDF ĐÃ KÝ SỐ (tải trực tiếp + đồng bộ từ ICT vbdh.tayninh.gov.vn) vào
 * P1…P6, sinh manifest.json (SHA-256), BANG_KE_HO_SO.xlsx, BAO_CAO_HO_SO_THIEU.xlsx và điền
 * file Excel mẫu BCQT TT73 (Bia, TT73, 01…07) rồi đặt vào P6.
 *
 * Quy ước:
 *  - Chỉ PDF có chữ ký số (sniffPdfSignatureString) mới vào gói. Tệp chưa ký/không tải được
 *    KHÔNG vào gói mà được liệt kê trong BAO_CAO_HO_SO_THIEU.xlsx.
 *  - Không dùng thư viện UI ngoài. JSZip và ExcelJS được truyền qua `libs` (không phụ thuộc cứng).
 *  - Công thức của file mẫu được giữ nguyên; chỉ điền ô nhập liệu. Excel sẽ tính lại khi mở.
 *  - Tên thư mục P2–P5, danh mục hồ sơ bắt buộc và ánh xạ loại gói thầu → dòng Mẫu 04/02 là
 *    MẶC ĐỊNH do người làm đề xuất; cần Ban QLDA xác nhận (xem PHASES, REQUIRED_DOCS, contractKind, COST_ROWS).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { sniffPdfSignatureString, sha256Hex, PdfSignatureInfo } from './VgcaSignService';

/* ───────────────────────── Kiểu dữ liệu ───────────────────────── */

export type Row = Record<string, any>;

export interface TaiLieuRow {
  id: number | string;
  nguon?: string;            // 'PMS-eSign' | 'eSign Files' | 'ICT' | …
  ma_tl?: string;
  ten_tl: string;
  loai?: string;
  ma_da?: string;
  ma_gt?: string | null;
  trang_thai?: string;       // WORKING | SUBMITTED | SIGNED | SUPERSEDED
  sha256?: string | null;
  /** http(s) URL, URL ICT (vbdh.tayninh.gov.vn) hoặc storage://bucket/đường-dẫn. */
  url_nguon?: string | null;
  ngay_phat_hanh?: string | null;
}
export interface GoiThauRow { ma_gt: string; loai_gt?: string; ten_gt?: string; gia_goi_thau?: number | null; }
export interface HopDongRow {
  id?: number; ma_hd: string; ma_gt?: string | null; ten_hd?: string; loai_hd?: string | null; ngay_ky?: string | null;
  gia_hd?: number | null; gia_quyet_toan?: number | null; luy_ke_thanh_toan?: number | null;
  nha_thau_id?: number | null; nha_thau_ten?: string;
}
/** Bảng du_an (= sheet “Dự án”) kèm nguồn vốn và 11 cấu phần Tổng mức đầu tư. */
export interface DuAnRow {
  ma_da: string; ten_da: string; nguon?: string | null; ghi_chu?: string | null;
  nguon_von?: 'tinh' | 'xa' | null; tong_muc_dau_tu?: number | null;
  tmdt_bt_htdtc?: number | null; tmdt_xay_dung?: number | null; tmdt_thiet_bi?: number | null; tmdt_qlda?: number | null;
  tmdt_tv_khao_sat_lap_bc?: number | null; tmdt_tv_tham_tra?: number | null; tmdt_tv_dau_thau?: number | null;
  tmdt_tv_giam_sat?: number | null; tmdt_tv_khac?: number | null; tmdt_chi_phi_khac?: number | null; tmdt_du_phong?: number | null;
}
export interface NghiemThuRow {
  ma_hsnt?: string; ma_hd: string; ma_da?: string; hop_dong_id?: number | null;
  ngay_de_nghi?: string | null; ngay_nt?: string | null; gia_tri_nt?: number | null; trang_thai_hsnt?: string | null;
}
export interface PhuLucRow {
  ma_plhd: string; ma_hd: string; ma_da?: string; hop_dong_id?: number | null; noi_dung?: string | null;
  ngay_ky?: string | null; gia_tri?: number | null; ngay_ky_sau_30_9?: string | null;
}
export interface SettlementData {
  duAn: DuAnRow;
  goiThau: GoiThauRow[];
  hopDong: HopDongRow[];
  taiLieu: TaiLieuRow[];
  /** Bảng nghiem_thu (sheet “Nghiệm thu”). */
  nghiemThu: NghiemThuRow[];
  /** Bảng phu_luc_hd (sheet “Phụ lục HĐ”). */
  phuLuc: PhuLucRow[];
  /** Dòng của dự án trong quyet_toan_daht (sheet “Quyết toán DAHT”) — thông tin đơn vị cho mẫu TT73. */
  quyetToan: Row | null;
}
export interface SettlementSource {
  listProjects?(): Promise<{ maDA: string; tenDA: string }[]>;
  load(maDA: string): Promise<SettlementData>;
  /** Trả byte PDF; trả null hoặc ném Error(mã) nếu không lấy được. */
  fetchPdf(t: TaiLieuRow): Promise<ArrayBuffer | null>;
}
export interface Libs { JSZip: any; ExcelJS: any }

export interface Defaults {
  chuDauTu: string;            // Ban QLDA ĐTXD xã Tân Phú
  diaDiem: string;             // “Xã Tân Phú”
}
export const DEFAULTS: Defaults = {
  chuDauTu: 'Ban Quản lý dự án Đầu tư xây dựng xã Tân Phú',
  diaDiem: 'Xã Tân Phú',
};

/* ───────────────────────── Giai đoạn & danh mục ───────────────────────── */

export const PHASES = [
  { key: 'P1_Chuan_bi_dau_tu', ten: 'Chuẩn bị đầu tư' },
  { key: 'P2_Thiet_ke_Du_toan', ten: 'Thiết kế – Dự toán' },
  { key: 'P3_Lua_chon_nha_thau', ten: 'Lựa chọn nhà thầu – Hợp đồng' },
  { key: 'P4_Thi_cong_Giam_sat', ten: 'Thi công – Giám sát – Thanh toán' },
  { key: 'P5_Nghiem_thu_Ban_giao', ten: 'Nghiệm thu – Bàn giao' },
  { key: 'P6_Quyet_toan_Bao_hanh', ten: 'Quyết toán – Bảo hành' },
] as const;
export type PhaseKey = typeof PHASES[number]['key'];

export const norm = (s: unknown): string =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

const PHASE_RULES: [PhaseKey, RegExp][] = [
  ['P6_Quyet_toan_Bao_hanh', /quyet toan|kiem toan|bao hanh|thanh ly|tt ?73|tham tra.*quyet/],
  ['P5_Nghiem_thu_Ban_giao', /nghiem thu|ban giao|hoan cong|dua vao su dung/],
  ['P3_Lua_chon_nha_thau', /lua chon nha thau|lcnt|khlcnt|hsmt|hsdt|moi thau|chi dinh thau|trung thau|ky ket|hop dong|\bhd[-/ ]/],
  ['P4_Thi_cong_Giam_sat', /thanh toan|tam ung|khoi luong|nhat ky|giam sat|phu luc|bien ban hien truong|thi cong|vat lieu|thi nghiem/],
  ['P2_Thiet_ke_Du_toan', /thiet ke|du toan|bvtc|tham tra|tham dinh/],
  ['P1_Chuan_bi_dau_tu', /chu truong|bao cao kinh te|bcktkt|nckt|phe duyet du an|khao sat|quy hoach|dau tu/],
];
const PHASE_BY_LOAI_GT: Record<string, PhaseKey> = {
  KSDC: 'P1_Chuan_bi_dau_tu', TVTK: 'P2_Thiet_ke_Du_toan', TVTT: 'P2_Thiet_ke_Du_toan',
  TVDT: 'P3_Lua_chon_nha_thau', TCXD: 'P4_Thi_cong_Giam_sat', TVGS: 'P4_Thi_cong_Giam_sat',
};

export function classifyPhase(t: TaiLieuRow, goiThau?: GoiThauRow): { phase: PhaseKey; by: 'TU_KHOA' | 'LOAI_GOI_THAU' | 'MAC_DINH' } {
  const text = norm(`${t.ten_tl} ${t.loai || ''}`);
  for (const [k, re] of PHASE_RULES) if (re.test(text)) return { phase: k, by: 'TU_KHOA' };
  if (goiThau?.loai_gt && PHASE_BY_LOAI_GT[goiThau.loai_gt]) return { phase: PHASE_BY_LOAI_GT[goiThau.loai_gt], by: 'LOAI_GOI_THAU' };
  return { phase: 'P4_Thi_cong_Giam_sat', by: 'MAC_DINH' };
}

export interface RequiredDoc { phase: PhaseKey; ten: string; re: RegExp; batBuoc: boolean }
export const REQUIRED_DOCS: RequiredDoc[] = [
  { phase: 'P1_Chuan_bi_dau_tu', ten: 'Quyết định phê duyệt dự án / báo cáo KT-KT', re: /phe duyet.*(du an|bao cao kinh te|bcktkt)/, batBuoc: true },
  { phase: 'P2_Thiet_ke_Du_toan', ten: 'Quyết định phê duyệt thiết kế BVTC – dự toán', re: /phe duyet.*(thiet ke|du toan)|(thiet ke|du toan).*phe duyet/, batBuoc: true },
  { phase: 'P2_Thiet_ke_Du_toan', ten: 'Báo cáo thẩm tra thiết kế – dự toán', re: /tham tra/, batBuoc: true },
  { phase: 'P3_Lua_chon_nha_thau', ten: 'Quyết định phê duyệt kế hoạch lựa chọn nhà thầu', re: /ke hoach lua chon nha thau|khlcnt/, batBuoc: true },
  { phase: 'P3_Lua_chon_nha_thau', ten: 'Quyết định phê duyệt kết quả lựa chọn nhà thầu', re: /ket qua (lua chon nha thau|lcnt|chi dinh thau)/, batBuoc: true },
  { phase: 'P5_Nghiem_thu_Ban_giao', ten: 'Biên bản nghiệm thu hoàn thành công trình', re: /nghiem thu/, batBuoc: true },
  { phase: 'P5_Nghiem_thu_Ban_giao', ten: 'Biên bản bàn giao đưa vào sử dụng', re: /ban giao/, batBuoc: true },
  { phase: 'P6_Quyet_toan_Bao_hanh', ten: 'Báo cáo kiểm toán (nếu có)', re: /kiem toan/, batBuoc: false },
  { phase: 'P6_Quyet_toan_Bao_hanh', ten: 'Quyết định phê duyệt quyết toán (khi đã có)', re: /phe duyet.*quyet toan/, batBuoc: false },
];

/* ───────────────────────── Tiện ích ───────────────────────── */

export function slug(s: string, max = 60): string {
  return norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'x';
}
const cap = (s: string) => s.replace(/(^|_)([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Lấy giá trị theo tên cột tiếng Việt, không phân biệt dấu/hoa thường/dấu cách. */
export function pick(row: Row | null | undefined, ...aliases: string[]): any {
  if (!row) return undefined;
  const keys = Object.keys(row);
  for (const a of aliases) {
    const na = norm(a).replace(/[^a-z0-9]/g, '');
    const k = keys.find((x) => norm(x).replace(/[^a-z0-9]/g, '') === na);
    if (k !== undefined && row[k] !== '' && row[k] != null) return row[k];
  }
  return undefined;
}
const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.\-]/g, '');
  const n = Number(s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
};
const toDate = (v: any): Date | null => {
  if (!v) return null;
  if (v instanceof Date) return v;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v));
  const d = m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};
const fmtDate = (v: any) => { const d = toDate(v); return d ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}` : ''; };

/* ───────────────────────── Phân loại hợp đồng → dòng Mẫu 04 / khối Mẫu 02 ───────────────────────── */

export type ContractKind =
  | 'XD' | 'TB' | 'TV_KS' | 'TV_TT' | 'TV_DT' | 'TV_GS' | 'TV_KHAC' | 'THAM_DINH_GIA' | 'BAO_HIEM' | 'KIEM_TOAN' | 'CP_KHAC' | 'CHUA';

/** Phân loại theo tên hợp đồng trước, rồi theo loại gói thầu (MẶC ĐỊNH đề xuất — chỉnh tại đây nếu cần). */
export function contractKind(h: HopDongRow, g?: GoiThauRow): ContractKind {
  const t = norm(`${h.ten_hd || ''}`);
  if (/bao hiem/.test(t)) return 'BAO_HIEM';
  if (/tham dinh gia/.test(t)) return 'THAM_DINH_GIA';
  if (/kiem toan/.test(t)) return 'KIEM_TOAN';
  if (/phe duyet quyet toan|tham tra quyet toan/.test(t)) return 'CP_KHAC';
  if (/thi nghiem|thu tinh/.test(t)) return 'TV_KHAC';
  if (/^thiet bi$|mua sam thiet bi|cung cap.*thiet bi/.test(t)) return 'TB';
  switch (g?.loai_gt) {
    case 'TCXD': return 'XD';
    case 'TVTK': case 'KSDC': return 'TV_KS';
    case 'TVTT': return 'TV_TT';
    case 'TVDT': return 'TV_DT';
    case 'TVGS': return 'TV_GS';
  }
  return h.ma_gt ? 'TV_KHAC' : 'CHUA';
}

export type CostKey = 'BT' | 'XD' | 'TB' | 'QLDA' | 'TV_KS' | 'TV_TT' | 'TV_DT' | 'TV_GS' | 'TV_KHAC' | 'CP_KHAC' | 'DU_PHONG' | 'CHUA';
/** Dòng của Mẫu số 04/QTDA. */
export const COST_ROWS: Record<CostKey, number> = { BT: 12, XD: 13, TB: 14, QLDA: 15, TV_KS: 17, TV_TT: 18, TV_DT: 19, TV_GS: 20, TV_KHAC: 21, CP_KHAC: 28, DU_PHONG: 38, CHUA: 37 };
/** Cột của bảng du_an chứa cấu phần Tổng mức đầu tư tương ứng. Tổng mức đầu tư = ROUNDDOWN(SUM(các cột này), -3). */
export const TMDT_FIELDS: Partial<Record<CostKey, keyof DuAnRow>> = {
  BT: 'tmdt_bt_htdtc', XD: 'tmdt_xay_dung', TB: 'tmdt_thiet_bi', QLDA: 'tmdt_qlda', TV_KS: 'tmdt_tv_khao_sat_lap_bc',
  TV_TT: 'tmdt_tv_tham_tra', TV_DT: 'tmdt_tv_dau_thau', TV_GS: 'tmdt_tv_giam_sat', TV_KHAC: 'tmdt_tv_khac',
  CP_KHAC: 'tmdt_chi_phi_khac', DU_PHONG: 'tmdt_du_phong',
};
export const costKeyOf = (k: ContractKind): CostKey =>
  k === 'THAM_DINH_GIA' ? 'TV_KHAC' : k === 'BAO_HIEM' || k === 'KIEM_TOAN' || k === 'CP_KHAC' ? 'CP_KHAC' : k === 'CHUA' ? 'CHUA' : k;

/** Khối hợp đồng ở Mẫu 02: [dòng tên nhà thầu, dòng hợp đồng, dòng phụ lục]. */
const CONTRACT_BLOCK: Partial<Record<ContractKind, [number, number, number]>> = {
  XD: [28, 29, 30], TB: [31, 32, 33], TV_KS: [36, 37, 38], TV_TT: [39, 40, 41], TV_DT: [42, 43, 44], TV_GS: [45, 46, 47],
  TV_KHAC: [51, 52, 53], THAM_DINH_GIA: [51, 52, 53], BAO_HIEM: [55, 56, 57], CP_KHAC: [55, 56, 57], KIEM_TOAN: [59, 60, 61],
};
const LEGAL_ROWS: [RegExp, number][] = [
  [/phe duyet.*(du an|bao cao kinh te|bcktkt)(?!.*dieu chinh)/, 11],
  [/ke hoach lua chon nha thau|khlcnt/, 12],
  [/dieu chinh.*(du an|bao cao kinh te)/, 13],
  [/dieu chinh nguon von/, 14],
  [/ket qua.*(lua chon nha thau|lcnt).*thi cong|thi cong.*ket qua/, 15],
];

const trimKey = (s: unknown) => String(s ?? '').trim();
/** Phụ lục của một hợp đồng (khớp theo hop_dong_id, nếu không thì theo mã DA + mã HĐ đã cắt khoảng trắng). */
export function phuLucOf(h: HopDongRow, maDA: string, all: PhuLucRow[]): PhuLucRow[] {
  return all.filter((p) => (p.hop_dong_id != null && p.hop_dong_id === h.id) || (p.hop_dong_id == null && (p.ma_da || maDA) === maDA && trimKey(p.ma_hd) === trimKey(h.ma_hd)))
    .sort((a, b) => String(a.ngay_ky || '9').localeCompare(String(b.ngay_ky || '9')) || a.ma_plhd.localeCompare(b.ma_plhd));
}

export interface GiaiNganNam { nam: number; tt: number; soHoSo: number; namUocTinh: boolean }
/** Giải ngân (đã thanh toán) theo năm từ bảng Nghiệm thu. Năm = năm Ngày NT, nếu trống thì Ngày đề nghị, nếu trống nữa thì năm ký hợp đồng (đánh dấu ước tính). */
export function giaiNganTheoNam(d: SettlementData): GiaiNganNam[] {
  const hdBy = new Map<string, HopDongRow>();
  for (const h of d.hopDong) { if (h.id != null) hdBy.set('i' + h.id, h); hdBy.set('m' + trimKey(h.ma_hd), h); }
  const acc = new Map<number, GiaiNganNam>();
  for (const n of d.nghiemThu) {
    if (norm(n.trang_thai_hsnt) !== 'da thanh toan' || n.gia_tri_nt == null) continue;
    let est = false;
    let y = toDate(n.ngay_nt)?.getUTCFullYear() ?? toDate(n.ngay_de_nghi)?.getUTCFullYear();
    if (y == null) {
      const h = (n.hop_dong_id != null && hdBy.get('i' + n.hop_dong_id)) || hdBy.get('m' + trimKey(n.ma_hd));
      y = h ? toDate(h.ngay_ky)?.getUTCFullYear() : undefined; est = true;
    }
    if (y == null) continue;
    const c = acc.get(y) || { nam: y, tt: 0, soHoSo: 0, namUocTinh: false };
    c.tt += n.gia_tri_nt; c.soHoSo++; c.namUocTinh = c.namUocTinh || est; acc.set(y, c);
  }
  return [...acc.values()].sort((a, b) => a.nam - b.nam);
}

export interface FillReport { missing: string[]; unmapped: string[]; notes: string[]; chenhLech: { giaiNganNghiemThu: number; luyKeHopDong: number } }

function isConst(v: any): boolean {
  return v != null && !(typeof v === 'object' && !(v instanceof Date) && ('formula' in v || 'sharedFormula' in v));
}
function clearConst(ws: any, a1: string) {
  const c = ws.getCell(a1);
  if (isConst(c.value)) c.value = null;
}
function clearRange(ws: any, cols: string[], r1: number, r2: number) {
  for (let r = r1; r <= r2; r++) for (const c of cols) clearConst(ws, c + r);
}
function setIf(ws: any, a1: string, v: any, rep: FillReport, label: string) {
  if (v === undefined || v === null || v === '') { rep.missing.push(label); return; }
  ws.getCell(a1).value = v;
}
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b || 0), 0);

export async function fillTt73Template(
  ExcelJS: any, templateBytes: ArrayBuffer | Uint8Array, d: SettlementData, defaults: Defaults = DEFAULTS, today = new Date(),
): Promise<{ bytes: Uint8Array; report: FillReport }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBytes);
  const rep: FillReport = { missing: [], unmapped: [], notes: [], chenhLech: { giaiNganNghiemThu: 0, luyKeHopDong: 0 } };
  // Công thức dùng chung (shared formula) sẽ hỏng khi ghi đè ô gốc → chuyển thành công thức riêng từng ô.
  wb.eachSheet((w: any) => w.eachRow({ includeEmpty: false }, (r: any) => r.eachCell({ includeEmpty: false }, (c: any) => {
    const v = c.value;
    if (v && typeof v === 'object' && (v.sharedFormula || v.shareType)) {
      const f = c.formula;
      if (f) c.value = { formula: f, result: v.result };
    }
  })));
  const Q = d.quyetToan;
  const A = d.duAn;
  const need = (n: string) => { const w = wb.getWorksheet(n); if (!w) throw new Error(`Mẫu thiếu sheet “${n}”.`); return w; };
  const tt = need('TT73'), s02 = need('02'), s03 = need('03'), s04 = need('04'), s07 = need('07'), bia = need('Bia');

  /* — Sửa các tham chiếu lỗi của mẫu gốc ở sheet Bia, bỏ sheet “6” cũ — */
  bia.getCell('B2').value = { formula: "UPPER('TT73'!C6)" };
  bia.getCell('B3').value = { formula: "UPPER('TT73'!C9)" };
  bia.getCell('C26').value = { formula: "'TT73'!C15" };
  bia.getCell('C27').value = { formula: "'TT73'!C9" };
  if (bia.getCell('F41').value && String(JSON.stringify(bia.getCell('F41').value)).includes('REF')) bia.getCell('F41').value = { formula: 'F40+1' };
  const old6 = wb.getWorksheet('6');
  if (old6) { wb.removeWorksheet(old6.id); rep.notes.push('Đã bỏ sheet “6” của mẫu (bản Mẫu 06/QTDA cũ theo TT 96/2021, chứa lỗi tham chiếu); dùng sheet “06” theo TT 73.'); }
  rep.notes.push('Sheet Bia: thay các công thức lỗi tham chiếu (REF) của mẫu bằng liên kết tới sheet TT73.');

  /* — TT73 (thông tin chung) — nguồn: du_an + quyet_toan_daht — */
  clearRange(tt, ['C'], 6, 13); clearRange(tt, ['C'], 15, 19); clearRange(tt, ['C'], 25, 26);
  const q = (k: string) => (Q ? Q[k] : undefined);
  setIf(tt, 'C6', q('co_quan_chu_quan'), rep, 'TT73!C6 Cấp quyết định đầu tư (quyet_toan_daht.co_quan_chu_quan)');
  setIf(tt, 'C7', q('co_quan_tham_tra'), rep, 'TT73!C7 Cơ quan thẩm tra quyết toán');
  setIf(tt, 'C8', q('co_quan_thanh_toan'), rep, 'TT73!C8 Cơ quan thanh toán');
  tt.getCell('C9').value = q('chu_dau_tu') || defaults.chuDauTu;
  tt.getCell('C10').value = q('chu_dau_tu') || defaults.chuDauTu;
  setIf(tt, 'C11', q('giam_doc_cdt'), rep, 'TT73!C11 Tên Giám đốc CĐT');
  setIf(tt, 'C12', q('nguoi_lap_bieu'), rep, 'TT73!C12 Người lập biểu');
  tt.getCell('C13').value = `${q('dia_danh') || defaults.diaDiem}, ngày ${today.getDate()} tháng ${today.getMonth() + 1} năm ${today.getFullYear()}`;
  tt.getCell('C15').value = q('ten_cong_trinh') || A.ten_da;
  setIf(tt, 'C16', A.tong_muc_dau_tu ?? num(q('tong_muc_dau_tu')), rep, 'TT73!C16 Tổng mức đầu tư (du_an: điền 11 cột tmdt_*)');
  const qdDa = d.taiLieu.find((t) => t.trang_thai !== 'SUPERSEDED' && /phe duyet.*(du an|bao cao kinh te|bcktkt)/.test(norm(t.ten_tl)));
  setIf(tt, 'C17', qdDa ? `Quyết định số ${qdDa.ma_tl || ''}${qdDa.ngay_phat_hanh ? ' ngày ' + fmtDate(qdDa.ngay_phat_hanh) : ''}` : q('can_cu_phap_ly_bo_sung'), rep, 'TT73!C17 Quyết định phê duyệt dự án');
  tt.getCell('C18').value = A.ma_da;
  setIf(tt, 'C19', A.nguon_von === 'tinh' ? 'Vốn ngân sách tỉnh' : A.nguon_von === 'xa' ? 'Vốn ngân sách xã' : undefined, rep, 'TT73!C19 Nguồn vốn');
  setIf(tt, 'C25', q('don_vi_tiep_nhan'), rep, 'TT73!C25 Đơn vị tiếp nhận sử dụng');
  setIf(tt, 'C26', toDate(q('ngay_dua_vao_su_dung')), rep, 'TT73!C26 Ngày đưa vào sử dụng');
  tt.getCell('C26').numFmt = 'dd/mm/yyyy';
  if (!Q) rep.missing.push('Chưa có dòng của dự án trong bảng quyet_toan_daht (sheet “Quyết toán DAHT”) — cần lập để điền đơn vị, người ký, ngày đưa vào sử dụng.');

  /* — Mẫu 04: chi phí đề nghị quyết toán — */
  clearRange(s04, ['C', 'D', 'E', 'F'], 12, 38);
  for (const r of [22, 29, 30, 31, 32, 33]) clearConst(s04, 'B' + r);
  s04.getCell('B21').value = 'Tư vấn khác (thí nghiệm, thẩm định giá…)';
  s04.getCell('B28').value = 'Chi phí khác (bảo hiểm, kiểm toán, thẩm tra quyết toán…)';
  s04.getCell('B37').value = 'Chi phí chưa phân loại';
  const gtBy = new Map(d.goiThau.map((g) => [g.ma_gt, g]));
  // Cột 3: Tổng mức đầu tư từng khoản mục — từ các cột tmdt_* của du_an
  let nTm = 0;
  for (const [k, f] of Object.entries(TMDT_FIELDS) as [CostKey, keyof DuAnRow][]) {
    const v = A[f] as number | null | undefined;
    if (v != null) { s04.getCell('C' + COST_ROWS[k]).value = Number(v); nTm++; }
  }
  if (!nTm) rep.missing.push('Mẫu 04 cột 3: chưa nhập 11 cột tmdt_* trong du_an (Tổng mức đầu tư = ROUNDDOWN(SUM(11 cột),-3)).');
  // Cột 5: Giá trị đề nghị quyết toán = Σ “Giá quyết toán” (hop_dong.gia_quyet_toan) của TẤT CẢ hợp đồng, phân theo loại
  const eBy = new Map<number, number>();
  const kinds = new Map<string, ContractKind>();
  for (const h of d.hopDong) {
    const g = h.ma_gt ? gtBy.get(h.ma_gt) : undefined;
    const kind = contractKind(h, g); kinds.set(trimKey(h.ma_hd), kind);
    const row = COST_ROWS[costKeyOf(kind)];
    if (kind === 'CHUA') rep.unmapped.push(`Mẫu 04: hợp đồng ${trimKey(h.ma_hd)} không có gói thầu/loại nhận diện được — đưa vào dòng “Chi phí chưa phân loại”.`);
    if (h.gia_quyet_toan == null) { rep.missing.push(`Hợp đồng ${trimKey(h.ma_hd)}: chưa có Giá quyết toán (hop_dong.gia_quyet_toan).`); continue; }
    eBy.set(row, (eBy.get(row) || 0) + h.gia_quyet_toan);
  }
  for (const [row, v] of eBy) s04.getCell('E' + row).value = v;
  // Cột 4: dự toán — tạm lấy giá gói thầu theo loại gói
  const dBy = new Map<number, number>();
  for (const g of d.goiThau) {
    const kind = contractKind({ ma_hd: '', ten_hd: '', ma_gt: g.ma_gt }, g);
    if (g.gia_goi_thau && kind !== 'CHUA') { const r = COST_ROWS[costKeyOf(kind)]; dBy.set(r, (dBy.get(r) || 0) + g.gia_goi_thau); }
  }
  for (const [row, v] of dBy) s04.getCell('D' + row).value = v;
  rep.notes.push('Mẫu 04 cột 4 (dự toán) tạm lấy bằng “giá gói thầu”; cần đối chiếu dự toán được phê duyệt.');
  rep.missing.push('Mẫu 04: chi phí Bồi thường–hỗ trợ–TĐC, Quản lý dự án và Dự phòng chưa có hợp đồng/số liệu nguồn ở cột 5 — nhập tay nếu phát sinh.');

  /* — Mẫu 02: danh mục văn bản & hợp đồng — */
  clearRange(s02, ['C', 'D', 'E', 'F'], 11, 24); clearRange(s02, ['C', 'D', 'F'], 27, 62);
  s02.getCell('B51').value = 'Tư vấn khác (thẩm định giá, thí nghiệm…)';
  const used = new Set<number>();
  for (const t of d.taiLieu) {
    if (t.trang_thai === 'SUPERSEDED') continue;
    const nt = norm(t.ten_tl);
    const hit = LEGAL_ROWS.find(([re, r]) => re.test(nt) && !used.has(r));
    if (!hit) continue;
    used.add(hit[1]);
    s02.getCell('C' + hit[1]).value = t.ma_tl || '';
    const dt = toDate(t.ngay_phat_hanh); if (dt) { s02.getCell('D' + hit[1]).value = dt; s02.getCell('D' + hit[1]).numFmt = 'dd/mm/yyyy'; }
  }
  rep.missing.push('Mẫu 02 mục A: cột “Cơ quan ban hành” và các quyết định chưa nhận diện được từ tên tài liệu — cần rà soát.');
  const blockAcc = new Map<number, { ten: Set<string>; so: string[]; ngay: Date | null; gia: number; pls: string[]; plNgay: Date | null; plGia: number }>();
  for (const h of d.hopDong) {
    const kind = kinds.get(trimKey(h.ma_hd)) || 'CHUA';
    const blk = CONTRACT_BLOCK[kind];
    if (!blk) { rep.unmapped.push(`Mẫu 02: hợp đồng ${trimKey(h.ma_hd)} chưa có khối tương ứng.`); continue; }
    const a = blockAcc.get(blk[0]) || { ten: new Set<string>(), so: [], ngay: null, gia: 0, pls: [], plNgay: null, plGia: 0 };
    if (h.nha_thau_ten) a.ten.add(h.nha_thau_ten);
    a.so.push(trimKey(h.ma_hd));
    const dt = toDate(h.ngay_ky); if (dt && (!a.ngay || dt < a.ngay)) a.ngay = dt;
    a.gia += h.gia_hd || 0;
    for (const p of phuLucOf(h, A.ma_da, d.phuLuc)) {
      a.pls.push(trimKey(p.ma_plhd));
      const pd = toDate(p.ngay_ky); if (pd && (!a.plNgay || pd > a.plNgay)) a.plNgay = pd;
      if (/gia hop dong/.test(norm(p.noi_dung)) && p.gia_tri) a.plGia += p.gia_tri;
    }
    blockAcc.set(blk[0], a);
  }
  for (const [kindKey, blk] of Object.entries(CONTRACT_BLOCK) as [ContractKind, [number, number, number]][]) {
    void kindKey; const a = blockAcc.get(blk[0]); if (!a) continue;
    s02.getCell('C' + blk[0]).value = [...a.ten].join('; ');
    s02.getCell('C' + blk[1]).value = a.so.join('; ');
    if (a.ngay) { s02.getCell('D' + blk[1]).value = a.ngay; s02.getCell('D' + blk[1]).numFmt = 'dd/mm/yyyy'; }
    if (a.gia) s02.getCell('F' + blk[1]).value = a.gia;
    if (a.pls.length) {
      s02.getCell('C' + blk[2]).value = a.pls.join('; ');
      if (a.plNgay) { s02.getCell('D' + blk[2]).value = a.plNgay; s02.getCell('D' + blk[2]).numFmt = 'dd/mm/yyyy'; }
      if (a.plGia) s02.getCell('F' + blk[2]).value = a.plGia;
    }
  }

  /* — Mẫu 03: giải ngân theo năm — nguồn: Nghiệm thu (Đã thanh toán), nguồn vốn: du_an.nguon_von — */
  const yearRow: Record<number, number> = { 2025: 28, 2026: 35 };
  for (const r of Object.values(yearRow)) for (const o of [2, 3]) for (const c of ['C', 'E', 'F']) { const cell = s03.getCell(c + (r + o)); cell.value = null; }
  const gn = giaiNganTheoNam(d);
  const rowTinh = (b: number) => b + 2, rowXa = (b: number) => b + 3;
  for (const y of gn) {
    const base = yearRow[y.nam];
    if (!base) { rep.unmapped.push(`Mẫu 03: năm ${y.nam} (${y.tt.toLocaleString('vi-VN')} đ) chưa có khối trong mẫu (chỉ 2025, 2026).`); continue; }
    const r = A.nguon_von === 'tinh' ? rowTinh(base) : rowXa(base);
    s03.getCell('E' + r).value = y.tt;
    if (y.namUocTinh) rep.notes.push(`Mẫu 03: một phần giải ngân năm ${y.nam} không có ngày nghiệm thu/đề nghị — năm lấy theo ngày ký hợp đồng.`);
  }
  // Ô công thức của mẫu (E37 = Mẫu 07 − năm trước) chỉ đúng cho dự án mẫu → thay bằng số liệu thật, 0 nếu không có
  for (const b of Object.values(yearRow)) {
    for (const row of [rowTinh(b), rowXa(b)]) {
      if (s03.getCell('E' + row).value == null) s03.getCell('E' + row).value = 0;
      s03.getCell('F' + row).value = 0;
      s03.getCell('D' + row).value = { formula: `E${row}+F${row}` };
      for (const [k, src] of [['G', 'C'], ['H', 'D'], ['I', 'E'], ['J', 'F']]) {
        const c = s03.getCell(k + row);
        if (c.value == null || (typeof c.value === 'object' && !(c.value instanceof Date) && (c.value as any).formula)) c.value = { formula: `${src}${row}` };
      }
    }
  }
  if (!gn.length) rep.missing.push('Mẫu 03: dự án chưa có hồ sơ nghiệm thu “Đã thanh toán” trong bảng Nghiệm thu — chưa có số liệu giải ngân.');
  rep.missing.push('Mẫu 03 cột “Số vốn được giao” theo năm: chưa có kế hoạch vốn trong dữ liệu — để trống, cần Phòng kế hoạch/tài chính bổ sung.');
  rep.notes.push('Mẫu 03: Tạm ứng để 0 (dữ liệu chưa tách tạm ứng); nguồn vốn lấy từ du_an.nguon_von (mặc định “xa”).');
  rep.notes.push('Mẫu 03 phần “số liệu của cơ quan kiểm soát, thanh toán” đang bằng số liệu chủ đầu tư (công thức mẫu); cần cập nhật khi có xác nhận Kho bạc.');
  rep.chenhLech.giaiNganNghiemThu = sum(gn.map((x) => x.tt));
  rep.chenhLech.luyKeHopDong = sum(d.hopDong.map((h) => h.luy_ke_thanh_toan));
  const delta = rep.chenhLech.luyKeHopDong - rep.chenhLech.giaiNganNghiemThu;
  if (gn.length && delta !== 0) rep.missing.push(`Giải ngân theo hồ sơ Nghiệm thu (${rep.chenhLech.giaiNganNghiemThu.toLocaleString('vi-VN')} đ) khác lũy kế thanh toán trong bảng Hợp đồng (${rep.chenhLech.luyKeHopDong.toLocaleString('vi-VN')} đ): chênh ${delta.toLocaleString('vi-VN')} đ — Mẫu 03 theo Nghiệm thu, Mẫu 07 theo Hợp đồng; cần đối chiếu.`);

  /* — Mẫu 07: công nợ — mỗi hợp đồng một dòng — */
  clearRange(s07, ['A', 'B', 'C', 'E', 'H'], 12, 25);
  const slots = 14;
  const rows07 = [...d.hopDong].sort((a, b) => String(a.ngay_ky || '').localeCompare(String(b.ngay_ky || '')) || a.ma_hd.localeCompare(b.ma_hd));
  rows07.slice(0, slots).forEach((h, i) => {
    const r = 12 + i;
    s07.getCell('A' + r).value = i + 1;
    s07.getCell('B' + r).value = h.nha_thau_ten || '';
    s07.getCell('C' + r).value = `Hợp đồng số ${trimKey(h.ma_hd)}${h.ngay_ky ? ' ngày ' + fmtDate(h.ngay_ky) : ''}`;
    s07.getCell('D' + r).value = h.gia_quyet_toan ?? 0;
    if (h.luy_ke_thanh_toan == null && h.gia_quyet_toan != null) rep.missing.push(`Hợp đồng ${trimKey(h.ma_hd)}: chưa có lũy kế thanh toán (Mẫu 07 cột 5 để 0).`);
    s07.getCell('E' + r).value = h.luy_ke_thanh_toan ?? 0;
    s07.getCell('F' + r).value = { formula: `MAX(D${r}-E${r},0)` };
    s07.getCell('G' + r).value = { formula: `MAX(E${r}-D${r},0)` };
  });
  for (let r = 12 + Math.min(rows07.length, slots); r <= 25; r++) { for (const c of ['D', 'F', 'G']) s07.getCell(c + r).value = null; }
  if (rows07.length > slots) rep.unmapped.push(`Mẫu 07: có ${rows07.length} hợp đồng nhưng mẫu chỉ có ${slots} dòng; ${rows07.length - slots} hợp đồng chưa đưa vào.`);

  rep.notes.push('Mẫu 05, 06 (phân loại tài sản, nguyên giá) và 12 không được điền tự động — kế toán nhập tay.');
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  const out = await wb.xlsx.writeBuffer();
  return { bytes: new Uint8Array(out as ArrayBuffer), report: rep };
}

/* ───────────────────────── Đóng gói ───────────────────────── */

export interface IncludedFile {
  path: string; phase: PhaseKey; phanLoaiBang: string; tl: TaiLieuRow; sha256: string; size: number;
  signature: PdfSignatureInfo; hashLech: boolean; nguonNhom: 'UPLOAD' | 'ICT';
}
export interface ExcludedFile { tl: TaiLieuRow; lyDo: 'CHUA_KY' | 'KHONG_TAI_DUOC' | 'KHONG_PHAI_PDF'; chiTiet: string }
export interface MissingItem { phase: string; muc: string; batBuoc: boolean; ghiChu: string }
export interface PackageResult {
  fileName: string; bytes: Uint8Array; manifest: any;
  included: IncludedFile[]; excluded: ExcludedFile[]; missing: MissingItem[]; fill: FillReport;
}

const isIct = (t: TaiLieuRow) => /ict|vbdh|tayninh/i.test(`${t.nguon || ''} ${t.url_nguon || ''}`);
const BCQT_NAME = (maDA: string) => `${maDA}_BCQT_TT73_2026.xlsx`;

async function xlsxSheet(ExcelJS: any, build: (wb: any) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
function styleHeader(ws: any, rowNo = 1) {
  const r = ws.getRow(rowNo);
  r.font = { name: 'Arial', bold: true };
  r.alignment = { vertical: 'middle', wrapText: true };
  r.eachCell((c: any) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE7F3' } }; c.border = { bottom: { style: 'thin' } }; });
  ws.views = [{ state: 'frozen', ySplit: rowNo }];
}

export async function buildSettlementPackage(
  maDA: string, source: SettlementSource, libs: Libs,
  opt: { templateBytes: ArrayBuffer | Uint8Array; defaults?: Defaults; now?: Date; onProgress?: (m: string) => void },
): Promise<PackageResult> {
  const say = opt.onProgress || (() => {});
  const now = opt.now || new Date();
  say('Đọc dữ liệu dự án…');
  const d = await source.load(maDA);
  const gtBy = new Map(d.goiThau.map((g) => [g.ma_gt, g]));

  const included: IncludedFile[] = [];
  const excluded: ExcludedFile[] = [];
  const usedNames = new Set<string>();
  const docs = d.taiLieu.filter((t) => t.trang_thai !== 'SUPERSEDED');
  let i = 0;
  for (const t of docs) {
    say(`Kiểm tra tệp ${++i}/${docs.length}: ${t.ten_tl}`);
    let buf: ArrayBuffer | null = null;
    let fetchErr = '';
    try { buf = await source.fetchPdf(t); } catch (e: any) { buf = null; fetchErr = String(e?.message || e); }
    if (!buf) { excluded.push({ tl: t, lyDo: 'KHONG_TAI_DUOC', chiTiet: explainFetchError(fetchErr) }); continue; }
    const sig = sniffPdfSignatureString(buf);
    if (!sig.signed) {
      excluded.push({ tl: t, lyDo: sig.reasons.some((r) => /Không phải tệp PDF/.test(r)) ? 'KHONG_PHAI_PDF' : 'CHUA_KY', chiTiet: sig.reasons.join(' ') });
      continue;
    }
    const sha = await sha256Hex(buf);
    const { phase, by } = classifyPhase(t, t.ma_gt ? gtBy.get(t.ma_gt) : undefined);
    let base = `${slug(t.ma_tl || String(t.id), 30)}_${slug(t.ten_tl, 70)}.pdf`;
    let path = `${phase}/${base}`; let n = 2;
    while (usedNames.has(path)) path = `${phase}/${base.replace(/\.pdf$/, '')}_${n++}.pdf`;
    usedNames.add(path);
    included.push({
      path, phase, phanLoaiBang: by, tl: t, sha256: sha, size: buf.byteLength, signature: sig,
      hashLech: !!t.sha256 && t.sha256.toLowerCase() !== sha, nguonNhom: isIct(t) ? 'ICT' : 'UPLOAD',
    });
    (included[included.length - 1] as any)._buf = buf;
  }

  /* Thiếu hồ sơ */
  const missing: MissingItem[] = [];
  for (const rq of REQUIRED_DOCS) {
    const ok = included.some((f) => f.phase === rq.phase && rq.re.test(norm(f.tl.ten_tl)));
    if (!ok) missing.push({ phase: rq.phase, muc: rq.ten, batBuoc: rq.batBuoc, ghiChu: 'Chưa có bản PDF đã ký số trong hệ thống.' });
  }
  const nghiemThuOf = (h: HopDongRow) => d.nghiemThu.filter((n) => (n.hop_dong_id != null && n.hop_dong_id === h.id) || (n.hop_dong_id == null && String(n.ma_hd).trim() === String(h.ma_hd).trim() && (!n.ma_da || n.ma_da === maDA)));
  const doiChieu: { ma_hd: string; nhaThau: string; qt: number | null; luyKe: number | null; nt: number; soHs: number }[] = [];
  for (const h of d.hopDong) {
    const hd = String(h.ma_hd).trim();
    const ok = h.ma_gt ? included.some((f) => f.tl.ma_gt === h.ma_gt && /hop dong|hd/.test(norm(`${f.tl.ten_tl} ${f.tl.loai || ''}`))) : false;
    if (!ok) missing.push({ phase: 'P3_Lua_chon_nha_thau', muc: `Hợp đồng ${hd}${h.nha_thau_ten ? ' – ' + h.nha_thau_ten : ''}`, batBuoc: true, ghiChu: 'Chưa có bản hợp đồng PDF đã ký số gắn với gói thầu.' });
    const nts = nghiemThuOf(h);
    const paid = nts.filter((n) => norm(n.trang_thai_hsnt) === 'da thanh toan');
    const ntSum = paid.reduce((a, n) => a + (n.gia_tri_nt || 0), 0);
    if (!nts.length) missing.push({ phase: 'P5_Nghiem_thu_Ban_giao', muc: `Nghiệm thu hợp đồng ${hd}`, batBuoc: true, ghiChu: 'Không có hồ sơ trong bảng Nghiệm thu.' });
    if (h.gia_quyet_toan != null && nts.length && ntSum !== h.gia_quyet_toan) missing.push({ phase: 'P6_Quyet_toan_Bao_hanh', muc: `Đối chiếu hợp đồng ${hd}`, batBuoc: true, ghiChu: `Giá quyết toán ${h.gia_quyet_toan.toLocaleString('vi-VN')} đ ≠ tổng nghiệm thu đã thanh toán ${ntSum.toLocaleString('vi-VN')} đ.` });
    doiChieu.push({ ma_hd: hd, nhaThau: h.nha_thau_ten || '', qt: h.gia_quyet_toan ?? null, luyKe: h.luy_ke_thanh_toan ?? null, nt: ntSum, soHs: paid.length });
  }

  /* Excel BCQT theo mẫu TT73 */
  say('Điền mẫu báo cáo quyết toán TT 73/2026/TT-BTC…');
  const fill = await fillTt73Template(libs.ExcelJS, opt.templateBytes, d, opt.defaults || DEFAULTS, now);
  for (const m of fill.report.missing) {
    const i = m.indexOf(': ');
    missing.push({ phase: 'P6_Quyet_toan_Bao_hanh', muc: i > 0 && i < 70 ? m.slice(0, i) : 'Số liệu mẫu TT73', batBuoc: true, ghiChu: i > 0 && i < 70 ? m.slice(i + 2) : m });
  }
  const bcqtPath = `${PHASES[5].key}/${BCQT_NAME(maDA)}`;

  /* BANG_KE_HO_SO.xlsx */
  say('Lập bảng kê & báo cáo thiếu hồ sơ…');
  const phaseOrder = (k: string) => PHASES.findIndex((p) => p.key === k);
  const sorted = [...included].sort((a, b) => phaseOrder(a.phase) - phaseOrder(b.phase) || a.path.localeCompare(b.path));
  const bangKe = await xlsxSheet(libs.ExcelJS, (wb) => {
    const ws = wb.addWorksheet('Bảng kê hồ sơ');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 }, { header: 'Giai đoạn', key: 'gd', width: 30 }, { header: 'Mã tài liệu', key: 'ma', width: 18 },
      { header: 'Tên tài liệu', key: 'ten', width: 50 }, { header: 'Mã gói thầu', key: 'gt', width: 16 }, { header: 'Nguồn', key: 'ng', width: 12 },
      { header: 'Người ký (chứng thư)', key: 'k', width: 26 }, { header: 'Thời điểm ký', key: 'tg', width: 22 }, { header: 'Cơ quan cấp CTS', key: 'ca', width: 28 },
      { header: 'Dung lượng (byte)', key: 'sz', width: 16 }, { header: 'SHA-256', key: 'h', width: 66 }, { header: 'Đường dẫn trong gói', key: 'p', width: 60 },
      { header: 'Ghi chú', key: 'gc', width: 40 },
    ];
    sorted.forEach((f, idx) => ws.addRow({
      stt: idx + 1, gd: PHASES.find((p) => p.key === f.phase)!.ten, ma: f.tl.ma_tl || '', ten: f.tl.ten_tl, gt: f.tl.ma_gt || '',
      ng: f.nguonNhom === 'ICT' ? 'ICT' : 'Tải lên', k: f.signature.signerName, tg: f.signature.signTime, ca: f.signature.issuerName,
      sz: f.size, h: f.sha256, p: f.path,
      gc: [f.phanLoaiBang === 'MAC_DINH' ? 'Giai đoạn xếp mặc định, cần rà soát' : '', f.hashLech ? 'SHA-256 khác bản đã đăng ký' : '',
        f.signature.coversWholeFile ? '' : 'Có dữ liệu sau chữ ký', f.signature.issuerLooksVgca ? '' : 'Chứng thư không nhận diện là VGCA'].filter(Boolean).join('; '),
    }));
    ws.eachRow((r: any) => { r.font = { name: 'Arial', size: 10 }; });
    styleHeader(ws);
    const last = ws.rowCount + 1;
    ws.getCell(`D${last}`).value = 'Tổng số tệp'; ws.getCell(`D${last}`).font = { name: 'Arial', bold: true };
    ws.getCell(`E${last}`).value = { formula: `COUNTA(D2:D${last - 1})` };
    ws.getCell(`J${last}`).value = { formula: `SUM(J2:J${last - 1})` };
    ws.getCell(`J${last}`).numFmt = '#,##0';
  });
  const thieuX = await xlsxSheet(libs.ExcelJS, (wb) => {
    const w1 = wb.addWorksheet('Thiếu hồ sơ');
    w1.columns = [{ header: 'STT', width: 6 }, { header: 'Giai đoạn', width: 34 }, { header: 'Nội dung thiếu', width: 60 }, { header: 'Bắt buộc', width: 12 }, { header: 'Ghi chú', width: 70 }];
    missing.forEach((m, k) => w1.addRow([k + 1, PHASES.find((p) => p.key === m.phase)?.ten || m.phase, m.muc, m.batBuoc ? 'Có' : 'Không', m.ghiChu]));
    w1.eachRow((r: any) => { r.font = { name: 'Arial', size: 10 }; }); styleHeader(w1);
    const w2 = wb.addWorksheet('Tệp bị loại');
    w2.columns = [{ header: 'STT', width: 6 }, { header: 'Mã tài liệu', width: 18 }, { header: 'Tên tài liệu', width: 56 }, { header: 'Mã gói thầu', width: 16 }, { header: 'Nguồn', width: 14 }, { header: 'Lý do', width: 20 }, { header: 'Chi tiết', width: 70 }];
    excluded.forEach((e, k) => w2.addRow([k + 1, e.tl.ma_tl || '', e.tl.ten_tl, e.tl.ma_gt || '', e.tl.nguon || '', ({ CHUA_KY: 'Chưa ký số', KHONG_TAI_DUOC: 'Không tải được', KHONG_PHAI_PDF: 'Không phải PDF' } as any)[e.lyDo], e.chiTiet]));
    w2.eachRow((r: any) => { r.font = { name: 'Arial', size: 10 }; }); styleHeader(w2);
    const w4 = wb.addWorksheet('Đối chiếu thanh toán');
    w4.columns = [{ header: 'Mã hợp đồng', width: 32 }, { header: 'Nhà thầu', width: 44 }, { header: 'Giá quyết toán (HĐ)', width: 20 }, { header: 'Lũy kế thanh toán (HĐ)', width: 22 }, { header: 'Σ Nghiệm thu đã TT', width: 20 }, { header: 'Số hồ sơ NT', width: 12 }, { header: 'Chênh (Lũy kế − NT)', width: 20 }];
    doiChieu.forEach((r, k) => { const row = k + 2; w4.addRow([r.ma_hd, r.nhaThau, r.qt, r.luyKe, r.nt, r.soHs, { formula: `D${row}-E${row}` }]); });
    w4.eachRow((r: any) => { r.font = { name: 'Arial', size: 10 }; }); styleHeader(w4);
    for (const c of ['C', 'D', 'E', 'G']) w4.getColumn(c).numFmt = '#,##0';
    const w3 = wb.addWorksheet('Chưa ánh xạ & lưu ý');
    w3.columns = [{ header: 'Loại', width: 16 }, { header: 'Nội dung', width: 120 }];
    fill.report.unmapped.forEach((u) => w3.addRow(['Chưa ánh xạ', u]));
    fill.report.notes.forEach((u) => w3.addRow(['Lưu ý', u]));
    w3.eachRow((r: any) => { r.font = { name: 'Arial', size: 10 }; }); styleHeader(w3);
  });

  /* manifest.json */
  const [hBk, hTh, hBc] = await Promise.all([sha256Hex(bangKe), sha256Hex(thieuX), sha256Hex(fill.bytes)]);
  const manifest = {
    maDA, tenDA: d.duAn.ten_da, thongTu: '73/2026/TT-BTC', taoLuc: now.toISOString(), thuatToanBam: 'SHA-256',
    ghiChu: 'Chỉ gồm PDF đã có chữ ký số (kiểm tra sự hiện diện chữ ký ở phía client, chưa xác thực chuỗi chứng thư).',
    soTep: included.length, soTepBiLoai: excluded.length, soMucThieu: missing.length,
    tep: [
      ...sorted.map((f) => ({
        path: f.path, sha256: f.sha256, size: f.size, giaiDoan: f.phase, maTL: f.tl.ma_tl || null, maGT: f.tl.ma_gt || null,
        nguon: f.nguonNhom, nguoiKy: f.signature.signerName || null, thoiDiemKy: f.signature.signTime || null, hashLech: f.hashLech,
      })),
      { path: bcqtPath, sha256: hBc, size: fill.bytes.length, giaiDoan: 'P6_Quyet_toan_Bao_hanh', loai: 'BCQT_TT73' },
      { path: 'BANG_KE_HO_SO.xlsx', sha256: hBk, size: bangKe.length, loai: 'BANG_KE' },
      { path: 'BAO_CAO_HO_SO_THIEU.xlsx', sha256: hTh, size: thieuX.length, loai: 'BAO_CAO_THIEU' },
    ],
    biLoai: excluded.map((e) => ({ maTL: e.tl.ma_tl || null, ten: e.tl.ten_tl, lyDo: e.lyDo })),
  };

  /* ZIP */
  say('Nén gói hồ sơ…');
  const zip = new libs.JSZip();
  for (const p of PHASES) zip.folder(p.key);
  for (const f of included) zip.file(f.path, (f as any)._buf);
  zip.file(bcqtPath, fill.bytes);
  zip.file('BANG_KE_HO_SO.xlsx', bangKe);
  zip.file('BAO_CAO_HO_SO_THIEU.xlsx', thieuX);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const bytes: Uint8Array = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  for (const f of included) delete (f as any)._buf;
  const fileName = `${maDA}_${cap(slug(d.duAn.ten_da, 60))}_Ho_So_Quyet_Toan_TT73.zip`;
  return { fileName, bytes, manifest, included, excluded, missing, fill: fill.report };
}

/* ───────────────────────── Tải PDF: trực tiếp / cầu nối ICT / Storage ───────────────────────── */

/** Cầu nối tới userscript IctTayNinhBridge.user.js (giao thức postMessage PMIS_APP ⇄ PMIS_ICT_BRIDGE). */
export interface IctBridge { request<T = any>(type: string, payload?: unknown, timeoutMs?: number): Promise<T> }

export function createWindowIctBridge(win: Window = window): IctBridge {
  return {
    request<T>(type: string, payload?: unknown, timeoutMs = 90000) {
      return new Promise<T>((resolve, reject) => {
        const id = (globalThis.crypto && 'randomUUID' in globalThis.crypto) ? (globalThis.crypto as any).randomUUID() : String(Date.now()) + Math.random();
        const done = (fn: () => void) => { clearTimeout(timer); win.removeEventListener('message', onMsg as any); fn(); };
        const onMsg = (ev: MessageEvent) => {
          if (ev.source !== win || ev.origin !== win.location.origin) return;
          const m = ev.data;
          if (!m || m.source !== 'PMIS_ICT_BRIDGE' || m.id !== id) return;
          done(() => (m.ok ? resolve(m.data as T) : reject(new Error(String(m.error)))));
        };
        const timer = setTimeout(() => done(() => reject(new Error(type === 'PING' ? 'KHONG_CO_CAU_NOI' : 'CAU_NOI_QUA_THOI_GIAN'))), timeoutMs);
        win.addEventListener('message', onMsg as any);
        win.postMessage({ source: 'PMIS_APP', id, type, payload }, win.location.origin);
      });
    },
  };
}

const ICT_HOST = 'vbdh.tayninh.gov.vn';
export const isIctUrl = (u: string) => { try { return new URL(u, 'https://' + ICT_HOST).hostname === ICT_HOST; } catch { return false; } };

export interface PdfFetcherOptions {
  ict?: IctBridge;
  fetchFn?: typeof fetch;
  /** Tải tệp trong Supabase Storage cho URL dạng storage://bucket/đường-dẫn. */
  storageDownload?: (bucket: string, path: string) => Promise<ArrayBuffer | null>;
}

/**
 * Tạo hàm tải PDF cho SettlementSource.fetchPdf:
 *  - URL vbdh.tayninh.gov.vn → đi qua cầu nối ICT (trình duyệt đã đăng nhập ICT; tránh CORS);
 *  - storage://bucket/path    → Supabase Storage;
 *  - http(s) khác             → fetch trực tiếp.
 * Lỗi được ném dưới dạng mã (CHUA_DANG_NHAP_ICT, KHONG_CO_CAU_NOI, HTTP_404, CORS_HOAC_MANG…) để báo cáo thiếu hồ sơ nêu đúng lý do.
 */
export function createPdfFetcher(o: PdfFetcherOptions = {}): (t: TaiLieuRow) => Promise<ArrayBuffer | null> {
  let bridgeOk: boolean | null = null;
  return async (t) => {
    const url = (t.url_nguon || '').trim();
    if (!url) throw new Error('KHONG_CO_DUONG_DAN');
    const m = /^storage:\/\/([^/]+)\/(.+)$/.exec(url);
    if (m) {
      if (!o.storageDownload) throw new Error('KHONG_CO_STORAGE');
      return o.storageDownload(m[1], m[2]);
    }
    if (isIctUrl(url) || (/ict/i.test(t.nguon || '') && url.startsWith('/'))) {
      if (!o.ict) throw new Error('KHONG_CO_CAU_NOI');
      if (bridgeOk === null) {
        try { await o.ict.request('PING', undefined, 1500); bridgeOk = true; } catch { bridgeOk = false; }
      }
      if (!bridgeOk) throw new Error('KHONG_CO_CAU_NOI');
      const r = await o.ict.request<{ buffer: ArrayBuffer }>('FETCH_FILE', { url });
      return r.buffer;
    }
    try {
      const res = await (o.fetchFn || fetch)(url, { credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP_' + res.status);
      return await res.arrayBuffer();
    } catch (e: any) {
      if (/^HTTP_/.test(String(e?.message))) throw e;
      throw new Error('CORS_HOAC_MANG');
    }
  };
}

export function explainFetchError(code: string): string {
  const c = (code || '').replace(/^Error:\s*/, '');
  if (!c) return 'Không tải được nội dung tệp.';
  if (c === 'CHUA_DANG_NHAP_ICT') return 'Chưa đăng nhập vbdh.tayninh.gov.vn trong trình duyệt này — đăng nhập rồi tạo lại gói.';
  if (c === 'KHONG_CO_CAU_NOI') return 'Chưa cài/chạy userscript cầu nối ICT (IctTayNinhBridge.user.js) trên trang PMIS — không tải được tệp ICT.';
  if (c === 'ICT_ENDPOINT_CHUA_CAU_HINH') return 'Cầu nối ICT chưa được cấu hình endpoint.';
  if (c === 'TEP_KHONG_PHAI_PDF') return 'Đường dẫn ICT không trả về PDF (có thể hết phiên đăng nhập).';
  if (c === 'CAU_NOI_QUA_THOI_GIAN') return 'Cầu nối ICT không phản hồi kịp (quá 90 giây).';
  if (c === 'KHONG_CO_DUONG_DAN') return 'Tài liệu chưa có đường dẫn nguồn (url_nguon).';
  if (c === 'KHONG_CO_STORAGE') return 'Chưa cấu hình tải từ Supabase Storage.';
  if (c === 'CORS_HOAC_MANG') return 'Trình duyệt chặn (CORS) hoặc lỗi mạng khi tải trực tiếp — dùng cầu nối hoặc Storage.';
  if (/^HTTP_\d+/.test(c)) return `Máy chủ trả mã ${c.slice(5)}.`;
  return c;
}

/* ───────────────────────── Nguồn dữ liệu Supabase ───────────────────────── */

export interface SbQ extends PromiseLike<{ data: any[] | null; error: { message: string } | null }> {
  eq(c: string, v: unknown): SbQ; in(c: string, v: unknown[]): SbQ;
}
export interface SbFromLike { from(t: string): { select(cols: string): SbQ } }

export interface SupabaseSourceOptions {
  /** Cách lấy PDF — mặc định createPdfFetcher() (fetch trực tiếp). Truyền createPdfFetcher({ ict: createWindowIctBridge(), … }) để tải tệp ICT. */
  pdfFetcher?: (t: TaiLieuRow) => Promise<ArrayBuffer | null>;
}

async function q(p: SbQ): Promise<any[]> {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data || [];
}
const N = (v: any) => (v == null || v === '' ? null : Number(v));
const MONEY_DA = ['tong_muc_dau_tu', 'tmdt_bt_htdtc', 'tmdt_xay_dung', 'tmdt_thiet_bi', 'tmdt_qlda', 'tmdt_tv_khao_sat_lap_bc', 'tmdt_tv_tham_tra', 'tmdt_tv_dau_thau', 'tmdt_tv_giam_sat', 'tmdt_tv_khac', 'tmdt_chi_phi_khac', 'tmdt_du_phong'];

export function createSupabaseSettlementSource(sb: SbFromLike, o: SupabaseSourceOptions = {}): SettlementSource {
  const fetcher = o.pdfFetcher || createPdfFetcher();
  return {
    async listProjects() {
      const rows = await q(sb.from('du_an').select('ma_da,ten_da'));
      return rows.map((r) => ({ maDA: String(r.ma_da), tenDA: r.ten_da })).sort((a, b) => a.maDA.localeCompare(b.maDA));
    },
    async load(maDA) {
      const [da, goiThau, hop, tl, nt, pl, qt] = await Promise.all([
        q(sb.from('du_an').select('*').eq('ma_da', maDA)),
        q(sb.from('goi_thau').select('*').eq('ma_da', maDA)),
        q(sb.from('hop_dong').select('*').eq('ma_da', maDA)),
        q(sb.from('tai_lieu').select('*').eq('ma_da', maDA)),
        q(sb.from('nghiem_thu').select('*').eq('ma_da', maDA)),
        q(sb.from('phu_luc_hd').select('*').eq('ma_da', maDA)),
        q(sb.from('quyet_toan_daht').select('*').eq('ma_da', maDA)),
      ]);
      if (!da.length) throw new Error(`Không tìm thấy dự án ${maDA}.`);
      const duAn: any = { ...da[0], ma_da: String(da[0].ma_da) };
      for (const k of MONEY_DA) duAn[k] = N(duAn[k]);
      const ids = Array.from(new Set(hop.map((h) => h.nha_thau_id).filter((x) => x != null)));
      const ntRows = ids.length ? await q(sb.from('nha_thau').select('id,ten').in('id', ids)) : [];
      const ntBy = new Map(ntRows.map((x) => [x.id, x.ten]));
      return {
        duAn, taiLieu: tl,
        goiThau: goiThau.map((g) => ({ ...g, gia_goi_thau: N(g.gia_goi_thau) })),
        hopDong: hop.map((h) => ({ ...h, gia_hd: N(h.gia_hd), gia_quyet_toan: N(h.gia_quyet_toan), luy_ke_thanh_toan: N(h.luy_ke_thanh_toan), nha_thau_ten: ntBy.get(h.nha_thau_id) || h.nha_thau_ten_goc || '' })),
        nghiemThu: nt.map((n) => ({ ...n, gia_tri_nt: N(n.gia_tri_nt) })),
        phuLuc: pl.map((p) => ({ ...p, gia_tri: N(p.gia_tri) })),
        quyetToan: qt[0] || null,
      };
    },
    fetchPdf: (t) => fetcher(t),
  };
}

/* ───────────────────────── Giao diện ───────────────────────── */

export interface SettlementZipExporterProps {
  source: SettlementSource;
  libs: Libs;
  /** Trả byte file Excel mẫu BCQT TT73. */
  loadTemplate: () => Promise<ArrayBuffer>;
  defaultMaDA?: string;
  defaults?: Defaults;
}

const CSS = `
.sze{--bg:#fff;--fg:#1c2430;--mut:#667085;--bd:#d8dee8;--ac:#1f5fbf;--ok:#1a7f4b;--wr:#b54708;--er:#b42318;font:14px/1.5 system-ui,Arial,sans-serif;color:var(--fg);background:var(--bg);padding:16px;max-width:980px;margin:0 auto}
@media (prefers-color-scheme:dark){.sze{--bg:#10151c;--fg:#e6eaf0;--mut:#98a2b3;--bd:#2c3644;--ac:#6ea8ff;--ok:#4cc38a;--wr:#f6a35a;--er:#ff8a80}}
.sze h2{margin:0 0 12px;font-size:18px}.sze .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.sze select,.sze input{padding:8px;border:1px solid var(--bd);border-radius:6px;background:transparent;color:inherit;min-width:220px}
.sze button{padding:8px 14px;border-radius:6px;border:1px solid var(--ac);background:var(--ac);color:#fff;cursor:pointer}
.sze button:disabled{opacity:.5;cursor:default}.sze .mut{color:var(--mut)}
.sze table{border-collapse:collapse;width:100%;margin:8px 0 16px}.sze th,.sze td{border-bottom:1px solid var(--bd);padding:6px 8px;text-align:left;vertical-align:top}
.sze .k{display:inline-block;padding:1px 8px;border-radius:10px;border:1px solid var(--bd);margin-right:6px}
.sze .ok{color:var(--ok)}.sze .wr{color:var(--wr)}.sze .er{color:var(--er)}
`;

export default function SettlementZipExporter({ source, libs, loadTemplate, defaultMaDA, defaults }: SettlementZipExporterProps) {
  const [projects, setProjects] = useState<{ maDA: string; tenDA: string }[]>([]);
  const [maDA, setMaDA] = useState(defaultMaDA || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<PackageResult | null>(null);

  useEffect(() => { source.listProjects?.().then(setProjects).catch((e) => setErr(String(e.message || e))); }, [source]);
  const valid = useMemo(() => /^\d{7}$/.test(maDA), [maDA]);

  const run = useCallback(async () => {
    setBusy(true); setErr(''); setRes(null);
    try {
      const tpl = await loadTemplate();
      const r = await buildSettlementPackage(maDA, source, libs, { templateBytes: tpl, defaults, onProgress: setMsg });
      setRes(r); setMsg('Đã tạo xong gói hồ sơ.');
    } catch (e: any) { setErr(e?.message || String(e)); setMsg(''); } finally { setBusy(false); }
  }, [maDA, source, libs, loadTemplate, defaults]);

  const download = useCallback(() => {
    if (!res) return;
    const ab = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([ab], { type: 'application/zip' }));
    const a = document.createElement('a'); a.href = url; a.download = res.fileName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, [res]);

  const perPhase = (k: string) => res?.included.filter((f) => f.phase === k).length || 0;
  const batBuocThieu = res?.missing.filter((m) => m.batBuoc).length || 0;

  return (
    <div className="sze">
      <style>{CSS}</style>
      <h2>Đóng gói hồ sơ quyết toán — TT 73/2026/TT-BTC</h2>
      <div className="row">
        {projects.length ? (
          <select value={maDA} onChange={(e) => setMaDA(e.target.value)} aria-label="Chọn dự án">
            <option value="">— Chọn dự án —</option>
            {projects.map((p) => <option key={p.maDA} value={p.maDA}>{p.maDA} · {p.tenDA}</option>)}
          </select>
        ) : (
          <input value={maDA} onChange={(e) => setMaDA(e.target.value.replace(/\D/g, '').slice(0, 7))} placeholder="Mã dự án (7 chữ số)" aria-label="Mã dự án" />
        )}
        <button disabled={!valid || busy} onClick={run}>{busy ? 'Đang xử lý…' : 'Tạo gói hồ sơ'}</button>
        {res && <button onClick={download}>Tải {res.fileName}</button>}
      </div>
      {msg && <div className="mut" role="status">{msg}</div>}
      {err && <div className="er" role="alert">{err}</div>}
      {res && (
        <>
          <p>
            <span className="k ok">{res.included.length} PDF đã ký vào gói</span>
            <span className={`k ${res.excluded.length ? 'wr' : ''}`}>{res.excluded.length} tệp bị loại</span>
            <span className={`k ${batBuocThieu ? 'er' : 'ok'}`}>{batBuocThieu} mục bắt buộc còn thiếu</span>
          </p>
          <table>
            <thead><tr><th>Giai đoạn</th><th>Số PDF đã ký</th></tr></thead>
            <tbody>{PHASES.map((p) => <tr key={p.key}><td>{p.key} <span className="mut">· {p.ten}</span></td><td>{perPhase(p.key)}</td></tr>)}</tbody>
          </table>
          {res.excluded.length > 0 && (
            <>
              <strong>Tệp bị loại (không vào gói)</strong>
              <table><tbody>{res.excluded.slice(0, 20).map((e, i) => (
                <tr key={i}><td>{e.tl.ten_tl}</td><td className="wr">{({ CHUA_KY: 'Chưa ký số', KHONG_TAI_DUOC: 'Không tải được', KHONG_PHAI_PDF: 'Không phải PDF' } as any)[e.lyDo]}</td></tr>
              ))}</tbody></table>
            </>
          )}
          <div className="mut">Chi tiết đầy đủ trong BAO_CAO_HO_SO_THIEU.xlsx. Mẫu 05, 06 cần kế toán nhập tay.</div>
        </>
      )}
    </div>
  );
}
