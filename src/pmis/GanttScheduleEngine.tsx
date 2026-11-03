'use client';
/**
 * GanttScheduleEngine.tsx - Gantt Split-View + động cơ EVM (PV / EV / SV) + báo cáo hiện trường cập nhật tức thì.
 *
 * Phụ thuộc: react >= 18 (Next.js App Router). Không dùng thư viện UI/biểu đồ ngoài.
 * Dùng:
 *   <GanttScheduleEngine gasUrl={process.env.NEXT_PUBLIC_GAS_URL!} getIdToken={getGoogleIdToken} />
 * Nguồn dữ liệu: tab `Gantt`, `Báo cáo`, `Holidays` (+ `DuAn` để lấy tên dự án) của Master DB, qua action
 * ganttBootstrap / addFieldReport trong GanttBridge.gs. Tên dự án chỉ tra từ DuAn, không sao chép vào Gantt.
 * Khóa công tác là `ma_cong_tac` (dạng 8179900-001, tiền tố là maDA) nên hai công tác trùng tên ở hai dự án
 * khác nhau luôn là hai dòng riêng. Có thể thay nguồn dữ liệu bằng prop `dataSource`.
 *
 * QUY ƯỚC (theo dữ liệu thật của file WA | NNN):
 *  - Gantt: trạng thái từng công tác chỉ có "Hoàn thành" hoặc để trống.
 *  - Báo cáo: `phan_tram` là tiến độ LŨY KẾ CỦA DỰ ÁN (không phải của công tác); `giai_ngan` là giải ngân LŨY KẾ
 *    CỦA DỰ ÁN, đơn vị đồng (lấy giá trị mới nhất, không cộng dồn); `ma_cong_tac` (nếu có) chỉ đánh dấu
 *    công tác đang thi công.
 *  - BAC dự án = tổng giá trị các công tác. Công tác thiếu giá trị được ước tính theo ngày làm việc (có cảnh báo).
 *  - PV = BAC x tỷ lệ kế hoạch tại ngày xét, tuyến tính theo NGÀY LÀM VIỆC (loại thứ 7, CN và ngày `Holidays`).
 *  - EV dự án = max(BAC x % báo cáo mới nhất, tổng giá trị công tác đã Hoàn thành): cả hai đều là cận dưới của
 *    khối lượng đã làm. EV công tác = giá trị nếu Hoàn thành, ngược lại 0. SV = EV - PV, SPI = EV / PV.
 *  - Trạng thái cấp dự án dùng SPI. Công tác: Hoàn thành / Quá hạn (qua ngày KT mà chưa đánh dấu Hoàn thành) /
 *    Chưa bắt đầu; công tác đang trong thời hạn thì kế thừa trạng thái của dự án (vì chưa có % riêng).
 *  - 7 trạng thái (ngưỡng chỉnh qua prop `evm`):
 *      CHUA_BAT_DAU       chưa có tiến độ và (chưa đến ngày bắt đầu, hoặc mới qua <= `graceDays` ngày làm việc đầu)
 *      HOAN_THANH         tiến độ >= 100%
 *      QUA_HAN            quá ngày kết thúc mà chưa đạt 100%
 *      VUOT_TIEN_DO       SPI >= 1,05 và EV hơn PV quá 2 điểm %
 *      DUNG_TIEN_DO       |EV% - PV%| <= 2 điểm %, hoặc SPI trong [0,95; 1,05)
 *      CHAM_NHE           0,85 <= SPI < 0,95
 *      CHAM_NGHIEM_TRONG  SPI < 0,85
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// Next.js vẫn render phía máy chủ cho 'use client'; useLayoutEffect trên máy chủ gây cảnh báo.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/* ============================== Kiểu dữ liệu ============================== */
export type Mode = 'Ngày' | 'Tuần' | 'Tháng' | 'Quý';
export const MODES: Mode[] = ['Ngày', 'Tuần', 'Tháng', 'Quý'];

export type EvmStatus =
  | 'CHUA_BAT_DAU' | 'HOAN_THANH' | 'QUA_HAN' | 'VUOT_TIEN_DO' | 'DUNG_TIEN_DO' | 'CHAM_NHE' | 'CHAM_NGHIEM_TRONG';

export interface GanttRow {
  ma_da: string | number; ma_cong_tac: string; ten_cong_tac: string; ngay_bd: string; ngay_kt: string; gia_tri: number | string;
  trang_thai?: string; nguoi_phu_trach?: string; ghi_chu?: string;
}
export interface FieldReport {
  report_id: string; client_id?: string; ma_da: string | number; ma_cong_tac?: string; ma_nv?: string; ho_ten?: string;
  /** yyyy-MM-ddTHH:mm:ss hoặc chỉ ngày (dd/MM/yyyy, yyyy-MM-dd) với dữ liệu cũ */
  thoi_gian: string;
  /** % lũy kế của DỰ ÁN */ phan_tram: number | string;
  /** giải ngân lũy kế của DỰ ÁN, đồng */ giai_ngan?: number | string;
  hang_muc?: string; kho_khan?: string; thoi_tiet?: string; so_cong_nhan?: number | string; kiem_dinh?: string;
  anh?: string; ghi_chu?: string; task_id?: string; pending?: boolean;
}
export interface HolidayRow { ngay: string; ten?: string }
export interface ProjectRow { ma_da: string | number; ten_da: string }
export interface TaskLite { task_id: string; ma_da: string | number; tieu_de: string; trang_thai?: string }
export interface Me { ma_nv: string; ho_ten: string; role: 'DIRECTOR' | 'SPECIALIST' }
export interface GanttPayload {
  me: Me; projects: ProjectRow[]; gantt: GanttRow[]; reports: FieldReport[]; holidays: HolidayRow[]; tasks: TaskLite[];
}
export interface PhotoInput { name: string; mime: string; base64: string }
export interface ReportInput {
  client_id: string; ma_da: string; phan_tram: number; giai_ngan: number; ghi_chu: string;
  ma_cong_tac?: string; task_id?: string; hang_muc: string; kho_khan: string; thoi_tiet: string; so_cong_nhan: number | null; kiem_dinh: string;
  anh: PhotoInput[];
  /** Đánh dấu `ma_cong_tac` là Hoàn thành (cần chọn công tác). Máy chủ ghi lại người, báo cáo và thời điểm để tính KPI. */
  danh_dau_hoan_thanh?: boolean;
}
export interface GanttDataSource {
  load(): Promise<GanttPayload>;
  addReport(input: ReportInput): Promise<FieldReport>;
  /** Đánh dấu / hủy hoàn thành một công tác (hủy: chỉ Giám đốc). Bỏ trống nếu nguồn không hỗ trợ. */
  setTaskDone?(maCongTac: string, done: boolean, lyDo?: string): Promise<void>;
}

export interface EvmConfig {
  vuot: number; dung: number; chamNhe: number; // ngưỡng SPI
  epsilonPct: number;                           // dung sai (điểm %) coi là đúng tiến độ
  graceDays: number;                            // số ngày làm việc đầu được chờ báo cáo đầu tiên, chưa coi là chậm
  useWorkingDays: boolean;
}
export const DEFAULT_EVM: EvmConfig = { vuot: 1.05, dung: 0.95, chamNhe: 0.85, epsilonPct: 2, graceDays: 2, useWorkingDays: true };

/* ============================== Ngày, số, tiền ============================== */
const DAY_MS = 86400000;
export const dayNum = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

/** Chuỗi yyyy-mm-dd[...] hoặc dd/mm/yyyy -> số ngày kể từ 1970-01-01 (UTC); không hợp lệ -> null. */
export function parseDay(v: unknown): number | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(s);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/.exec(s);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const n = dayNum(y, mo, d);
  const c = new Date(n * DAY_MS);
  return c.getUTCMonth() + 1 === mo && c.getUTCDate() === d ? n : null;
}
export const ymd = (n: number) => { const c = new Date(n * DAY_MS); return { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() }; };
const p2 = (x: number) => (x < 10 ? '0' : '') + x;
export const isoOf = (n: number) => { const t = ymd(n); return `${t.y}-${p2(t.m)}-${p2(t.d)}`; };
export const fmtDMY = (n: number) => { const t = ymd(n); return `${p2(t.d)}/${p2(t.m)}/${t.y}`; };
export const fmtDM = (n: number) => { const t = ymd(n); return `${p2(t.d)}/${p2(t.m)}`; };
/** 0 = Chủ nhật ... 6 = Thứ bảy */
export const dow = (n: number) => (((n + 4) % 7) + 7) % 7;
const mondayOf = (n: number) => n - ((dow(n) + 6) % 7);

/** Ngày hôm nay theo giờ Việt Nam. */
export function todayVN(now: Date = new Date()): number {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parseDay(s) as number;
}

/** "1.234.567", "1,5", 1500000, "45%" -> số. Không đọc được -> NaN. */
export function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  let s = String(v).trim().replace(/[\s ]/g, '').replace(/(đ|vnđ|vnd|%)$/i, '');
  if (s === '') return NaN;
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    // dấu cuối cùng là dấu thập phân
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (dots > 1 || (dots === 1 && /^\d{1,3}\.\d{3}$/.test(s))) s = s.replace(/\./g, '');
  else if (commas > 1) s = s.replace(/,/g, '');
  else if (commas === 1) s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

const nf0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
export const fmtVnd = (n: number) => nf0.format(Math.round(n)) + ' đ';
export function fmtMoneyShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return nf1.format(n / 1e9) + ' tỷ';
  if (a >= 1e6) return nf1.format(n / 1e6) + ' tr';
  return nf0.format(n);
}
export const fmtPct = (p: number) => nf1.format(p) + '%';

/* ============================== Lịch làm việc ============================== */
export class Calendar {
  readonly lo: number;
  readonly hi: number;
  private cum: Int32Array;
  constructor(lo: number, hi: number, private holidays: Map<number, string>, private weekendDays: number[] = [0, 6]) {
    this.lo = lo; this.hi = Math.max(hi, lo);
    this.cum = new Int32Array(this.hi - this.lo + 1);
    let c = 0;
    for (let d = this.lo; d <= this.hi; d++) { if (!this.isOff(d)) c++; this.cum[d - this.lo] = c; }
  }
  holidayName(d: number) { return this.holidays.get(d); }
  isHoliday(d: number) { return this.holidays.has(d); }
  isWeekend(d: number) { return this.weekendDays.includes(dow(d)); }
  isOff(d: number) { return this.isWeekend(d) || this.isHoliday(d); }
  /** Số ngày làm việc trong [a, b] (gồm cả hai đầu), chỉ trong phạm vi lịch. */
  work(a: number, b: number): number {
    a = Math.max(a, this.lo); b = Math.min(b, this.hi);
    if (b < a) return 0;
    return this.cum[b - this.lo] - (a > this.lo ? this.cum[a - this.lo - 1] : 0);
  }
}

/* ============================== Động cơ EVM ============================== */
export interface TaskModel {
  ma_cong_tac: string; ma_da: string; ten: string; bd: number; kt: number; bac: number;
  hasValue: boolean; estimated: boolean; done: boolean;
}
export interface Metrics {
  bac: number; pvPct: number; pv: number; evPct: number; ev: number; sv: number; spi: number | null; timePct: number;
}
export interface TaskEvm extends Metrics { status: EvmStatus; overdueDays: number; inherited: boolean; current: boolean }
export interface ProjectEvm extends Metrics {
  status: EvmStatus; giaiNgan: number; giaiNganPct: number | null; nTasks: number; nDone: number; nOverdue: number;
  bd: number; kt: number; reportedPct: number | null; donePct: number; last?: FieldReport; nReports: number;
}
export interface Totals { bac: number; pv: number; ev: number; pvPct: number; evPct: number; sv: number; spi: number | null; giaiNgan: number; giaiNganPct: number | null }

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const isDone = (s: unknown) => String(s ?? '').normalize('NFC').toLowerCase().includes('hoàn thành');

/** Tỷ lệ kế hoạch (0..1) tại ngày D. */
export function plannedFraction(t: { bd: number; kt: number }, D: number, cal: Calendar, cfg: EvmConfig): number {
  if (D < t.bd) return 0;
  if (D >= t.kt) return 1;
  if (cfg.useWorkingDays) {
    const tot = cal.work(t.bd, t.kt);
    if (tot > 0) return cal.work(t.bd, D) / tot;
  }
  return (D - t.bd + 1) / (t.kt - t.bd + 1);
}

const tsOf = (r: FieldReport) => String(r.thoi_gian ?? '');
/** Báo cáo mới nhất (theo thời gian; hòa thì lấy dòng sau) có ngày <= asOf. */
export function latestReport(reports: FieldReport[], asOf: number): FieldReport | undefined {
  let best: FieldReport | undefined;
  for (const r of reports) {
    const d = parseDay(r.thoi_gian);
    if (d == null || d > asOf) continue;
    if (!best || (parseDay(r.thoi_gian) as number) > (parseDay(best.thoi_gian) as number) || (parseDay(r.thoi_gian) === parseDay(best.thoi_gian) && tsOf(r) >= tsOf(best))) best = r;
  }
  return best;
}

export function classify(
  a: { pvPct: number; evPct: number; spi: number | null; asOf: number; bd: number; kt: number; elapsedWork: number }, cfg: EvmConfig,
): EvmStatus {
  if (a.evPct >= 100 - 1e-9) return 'HOAN_THANH';
  if (a.asOf > a.kt) return 'QUA_HAN';
  if (a.evPct === 0 && (a.asOf < a.bd || a.elapsedWork <= cfg.graceDays)) return 'CHUA_BAT_DAU';
  const diff = a.evPct - a.pvPct;
  if (Math.abs(diff) <= cfg.epsilonPct) return 'DUNG_TIEN_DO';
  if (a.spi == null) return diff > 0 ? 'VUOT_TIEN_DO' : 'DUNG_TIEN_DO'; // pv = 0 mà ev > 0
  if (a.spi >= cfg.vuot) return 'VUOT_TIEN_DO';
  if (a.spi >= cfg.dung) return 'DUNG_TIEN_DO';
  if (a.spi >= cfg.chamNhe) return 'CHAM_NHE';
  return 'CHAM_NGHIEM_TRONG';
}

const GOING: EvmStatus[] = ['VUOT_TIEN_DO', 'DUNG_TIEN_DO', 'CHAM_NHE', 'CHAM_NGHIEM_TRONG'];

/** Một dự án: PV cộng từ các công tác; EV = max(% báo cáo mới nhất, các công tác đã Hoàn thành). */
export function evmOfProject(tasks: TaskModel[], reports: FieldReport[], asOf: number, cal: Calendar, cfg: EvmConfig): ProjectEvm {
  const bac = tasks.reduce((s, t) => s + t.bac, 0);
  const pv = tasks.reduce((s, t) => s + t.bac * plannedFraction(t, asOf, cal, cfg), 0);
  const doneVal = tasks.reduce((s, t) => s + (t.done ? t.bac : 0), 0);
  const last = latestReport(reports, asOf);
  const reportedPct = last ? clamp(parseNum(last.phan_tram) || 0, 0, 100) : null;
  const allDone = tasks.length > 0 && tasks.every((t) => t.done);
  const donePct = bac > 0 ? (doneVal / bac) * 100 : allDone ? 100 : 0;
  const evPct = allDone ? 100 : Math.max(reportedPct ?? 0, donePct);
  const ev = bac > 0 ? (bac * evPct) / 100 : 0;
  const pvPct = bac > 0 ? (pv / bac) * 100 : 0;
  const spi = pv > 0 ? ev / pv : null;
  const bd = Math.min(...tasks.map((t) => t.bd)), kt = Math.max(...tasks.map((t) => t.kt));
  const status = classify({ pvPct, evPct, spi, asOf, bd, kt, elapsedWork: cal.work(bd, asOf) }, cfg);
  let giaiNgan = 0;
  const gl = last ? parseNum(last.giai_ngan) : NaN;
  if (isFinite(gl) && gl > 0) giaiNgan = gl;
  return {
    bac, pv, pvPct, ev, evPct, sv: ev - pv, spi, timePct: clamp(((asOf - bd + 1) / (kt - bd + 1)) * 100, 0, 100), status,
    giaiNgan, giaiNganPct: bac > 0 ? (giaiNgan / bac) * 100 : null, nTasks: tasks.length, nDone: tasks.filter((t) => t.done).length,
    nOverdue: tasks.filter((t) => !t.done && asOf > t.kt).length, bd, kt, reportedPct, donePct, last, nReports: reports.length,
  };
}

/** Một công tác: tiến độ chỉ có Hoàn thành hoặc chưa; công tác đang trong thời hạn kế thừa trạng thái của dự án. */
export function evmOfTask(t: TaskModel, prj: ProjectEvm, current: boolean, asOf: number, cal: Calendar, cfg: EvmConfig): TaskEvm {
  const pvPct = plannedFraction(t, asOf, cal, cfg) * 100;
  const pv = (t.bac * pvPct) / 100;
  const evPct = t.done ? 100 : 0, ev = t.done ? t.bac : 0;
  let status: EvmStatus, inherited = false;
  if (t.done) status = 'HOAN_THANH';
  else if (asOf > t.kt) status = 'QUA_HAN';
  else if (asOf < t.bd) status = 'CHUA_BAT_DAU';
  else { status = GOING.includes(prj.status) ? prj.status : 'DUNG_TIEN_DO'; inherited = true; }
  return {
    bac: t.bac, pv, pvPct, ev, evPct, sv: ev - pv, spi: pv > 0 ? ev / pv : null,
    timePct: clamp(((asOf - t.bd + 1) / (t.kt - t.bd + 1)) * 100, 0, 100), status,
    overdueDays: !t.done && asOf > t.kt ? asOf - t.kt : 0, inherited, current,
  };
}

/** Tổng hợp nhiều dự án (cộng giá trị). */
export function sumProjects(list: ProjectEvm[]): Totals {
  const bac = list.reduce((s, e) => s + e.bac, 0), pv = list.reduce((s, e) => s + e.pv, 0), ev = list.reduce((s, e) => s + e.ev, 0);
  const giaiNgan = list.reduce((s, e) => s + e.giaiNgan, 0);
  return {
    bac, pv, ev, pvPct: bac > 0 ? (pv / bac) * 100 : 0, evPct: bac > 0 ? (ev / bac) * 100 : 0, sv: ev - pv,
    spi: pv > 0 ? ev / pv : null, giaiNgan, giaiNganPct: bac > 0 ? (giaiNgan / bac) * 100 : null,
  };
}

/* ============================== Dựng mô hình từ dữ liệu Sheet ============================== */
export interface Warn { level: 'warn' | 'err'; text: string }
export interface ProjectModel { ma_da: string; ten_da: string; known: boolean; tasks: TaskModel[] }
export interface Model {
  projects: ProjectModel[]; tasks: TaskModel[]; reportsByProject: Map<string, FieldReport[]>;
  holidays: Map<number, string>; warnings: Warn[]; minDay: number; maxDay: number;
}

export function buildModel(p: Pick<GanttPayload, 'projects' | 'gantt' | 'reports' | 'holidays'>, weekendDays: number[] = [0, 6]): Model {
  const warnings: Warn[] = [];
  const names = new Map<string, string>();
  p.projects.forEach((x) => names.set(String(x.ma_da).trim(), String(x.ten_da)));

  const holidays = new Map<number, string>();
  p.holidays.forEach((h, i) => {
    const d = parseDay(h.ngay);
    if (d == null) { warnings.push({ level: 'warn', text: `Holidays dòng ${i + 2}: ngày "${h.ngay}" không đọc được.` }); return; }
    holidays.set(d, h.ten ? String(h.ten) : 'Ngày nghỉ');
  });

  const tasks: TaskModel[] = [];
  const seen = new Set<string>();
  p.gantt.forEach((g, i) => {
    const code = String(g.ma_cong_tac ?? '').trim();
    const where = `Gantt dòng ${i + 2} (${code || 'không mã'})`;
    if (!code) { warnings.push({ level: 'err', text: `${where}: thiếu Mã công tác - bỏ qua.` }); return; }
    if (seen.has(code)) { warnings.push({ level: 'err', text: `${where}: Mã công tác bị trùng - bỏ qua dòng này.` }); return; }
    const bd = parseDay(g.ngay_bd), kt = parseDay(g.ngay_kt);
    if (bd == null || kt == null) { warnings.push({ level: 'err', text: `${where}: ngày BĐ/KT không đọc được - bỏ qua.` }); return; }
    if (kt < bd) { warnings.push({ level: 'err', text: `${where}: ngày kết thúc trước ngày bắt đầu - bỏ qua.` }); return; }
    let ma_da = String(g.ma_da ?? '').trim();
    const prefix = code.split('-')[0];
    if (!/^\d{7}$/.test(ma_da)) {
      if (/^\d{7}$/.test(prefix)) ma_da = prefix;
      else { warnings.push({ level: 'err', text: `${where}: không xác định được maDA - bỏ qua.` }); return; }
    } else if (prefix !== ma_da) warnings.push({ level: 'warn', text: `${where}: tiền tố mã công tác khác maDA ${ma_da}.` });
    const val = parseNum(g.gia_tri);
    const hasValue = isFinite(val) && val > 0;
    seen.add(code);
    tasks.push({ ma_cong_tac: code, ma_da, ten: String(g.ten_cong_tac ?? ''), bd, kt, bac: hasValue ? val : 0, hasValue, estimated: false, done: isDone(g.trang_thai) });
  });

  // Công tác thiếu giá trị: ước tính = đơn giá trung bình theo ngày làm việc của dự án x số ngày làm việc của công tác
  if (tasks.length) {
    const cal = new Calendar(Math.min(...tasks.map((t) => t.bd)) - 1, Math.max(...tasks.map((t) => t.kt)) + 1, holidays, weekendDays);
    const byP = new Map<string, TaskModel[]>();
    tasks.forEach((t) => (byP.get(t.ma_da) ?? byP.set(t.ma_da, []).get(t.ma_da)!).push(t));
    byP.forEach((ts, ma) => {
      const missing = ts.filter((t) => !t.hasValue);
      if (!missing.length) return;
      const valued = ts.filter((t) => t.hasValue);
      const days = valued.reduce((s, t) => s + Math.max(1, cal.work(t.bd, t.kt)), 0);
      if (!valued.length || days === 0) {
        warnings.push({ level: 'warn', text: `${ma}: ${missing.length} công tác thiếu giá trị và không có công tác nào để ước tính - giá trị tính bằng 0.` });
        return;
      }
      const rate = valued.reduce((s, t) => s + t.bac, 0) / days;
      missing.forEach((t) => { t.bac = Math.round(rate * Math.max(1, cal.work(t.bd, t.kt))); t.estimated = true; });
      warnings.push({ level: 'warn', text: `${ma}: ${missing.length} công tác thiếu giá trị, đã ước tính theo ngày làm việc (${missing.map((t) => t.ma_cong_tac).join(', ')}).` });
    });
  }

  const byProject = new Map<string, TaskModel[]>();
  tasks.forEach((t) => (byProject.get(t.ma_da) ?? byProject.set(t.ma_da, []).get(t.ma_da)!).push(t));

  const reportsByProject = new Map<string, FieldReport[]>();
  const orphan = new Map<string, number>();
  p.reports.forEach((r, i) => {
    const ma = String(r.ma_da ?? '').trim();
    const pc = parseNum(r.phan_tram);
    const id = r.report_id || String(i + 2);
    if (!isFinite(pc) || pc < 0 || pc > 100) { warnings.push({ level: 'err', text: `Báo cáo ${id}: % tiến độ không hợp lệ - bỏ qua.` }); return; }
    if (parseDay(r.thoi_gian) == null) { warnings.push({ level: 'err', text: `Báo cáo ${id}: thời gian không đọc được - bỏ qua.` }); return; }
    if (!byProject.has(ma)) { orphan.set(ma, (orphan.get(ma) ?? 0) + 1); return; }
    const code = String(r.ma_cong_tac ?? '').trim();
    if (code && !seen.has(code)) warnings.push({ level: 'warn', text: `Báo cáo ${id}: Mã công tác "${code}" không có trong Gantt.` });
    else if (code && !code.startsWith(ma + '-')) warnings.push({ level: 'warn', text: `Báo cáo ${id}: Mã công tác "${code}" không thuộc dự án ${ma}.` });
    (reportsByProject.get(ma) ?? reportsByProject.set(ma, []).get(ma)!).push(r);
  });
  orphan.forEach((n, ma) => warnings.push({ level: 'warn', text: `${n} báo cáo của dự án ${ma}${names.has(ma) ? '' : ' (chưa có trong DuAn)'} chưa hiển thị vì dự án chưa có công tác trong sheet Gantt.` }));
  reportsByProject.forEach((list, ma) => {
    const sorted = [...list].sort((a, b) => (parseDay(a.thoi_gian) as number) - (parseDay(b.thoi_gian) as number) || tsOf(a).localeCompare(tsOf(b)));
    for (let i = 1; i < sorted.length; i++) {
      if (parseNum(sorted[i].phan_tram) < parseNum(sorted[i - 1].phan_tram)) {
        warnings.push({ level: 'warn', text: `${ma}: % giảm từ ${sorted[i - 1].phan_tram} xuống ${sorted[i].phan_tram} (báo cáo ${sorted[i].report_id}).` });
        break;
      }
    }
  });

  const projects: ProjectModel[] = [];
  const order = [...names.keys()].filter((k) => byProject.has(k));
  [...byProject.keys()].filter((k) => !names.has(k)).sort().forEach((k) => {
    warnings.push({ level: 'warn', text: `maDA ${k} có trong Gantt nhưng chưa có trong DuAn.` });
    order.push(k);
  });
  order.forEach((k) => {
    const ts = byProject.get(k)!.sort((a, b) => a.bd - b.bd || a.ma_cong_tac.localeCompare(b.ma_cong_tac));
    projects.push({ ma_da: k, ten_da: names.get(k) ?? '(chưa có trong DuAn)', known: names.has(k), tasks: ts });
  });

  const minDay = tasks.length ? Math.min(...tasks.map((t) => t.bd)) : 0;
  const maxDay = tasks.length ? Math.max(...tasks.map((t) => t.kt)) : 0;
  return { projects, tasks, reportsByProject, holidays, warnings, minDay, maxDay };
}

/* ============================== Hình học timeline ============================== */
export const PX_PER_DAY: Record<Mode, number> = { 'Ngày': 36, 'Tuần': 14, 'Tháng': 4.5, 'Quý': 1.6 };
export interface Seg { from: number; to: number; label: string; title?: string }

function groupDays(lo: number, hi: number, key: (d: number) => string, label: (d: number) => string): Seg[] {
  const out: Seg[] = [];
  let cur: Seg | null = null, curKey = '';
  for (let d = lo; d <= hi; d++) {
    const k = key(d);
    if (!cur || k !== curKey) { cur = { from: d, to: d, label: label(d) }; out.push(cur); curKey = k; } else cur.to = d;
  }
  return out;
}

/** Căn phạm vi theo chế độ: Tuần -> thứ Hai; Tháng/Quý -> đầu/cuối tháng, quý. */
export function alignRange(mode: Mode, lo: number, hi: number): [number, number] {
  if (mode === 'Ngày') return [lo, hi];
  if (mode === 'Tuần') return [mondayOf(lo), mondayOf(hi) + 6];
  const a = ymd(lo), b = ymd(hi);
  if (mode === 'Tháng') return [dayNum(a.y, a.m, 1), dayNum(b.y, b.m + 1, 1) - 1];
  const qa = Math.floor((a.m - 1) / 3) * 3 + 1, qb = Math.floor((b.m - 1) / 3) * 3 + 4;
  return [dayNum(a.y, qa, 1), dayNum(b.y, qb, 1) - 1];
}

export function headerSegments(mode: Mode, lo: number, hi: number): { top: Seg[]; bottom: Seg[] } {
  const ymKey = (d: number) => { const t = ymd(d); return t.y * 100 + t.m + ''; };
  const monthLabel = (d: number) => { const t = ymd(d); return `Tháng ${t.m}/${t.y}`; };
  const yearKey = (d: number) => ymd(d).y + '';
  const yearLabel = (d: number) => 'Năm ' + ymd(d).y;
  if (mode === 'Ngày') {
    const bottom: Seg[] = [];
    const wd = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    for (let d = lo; d <= hi; d++) bottom.push({ from: d, to: d, label: String(ymd(d).d), title: `${wd[dow(d)]} ${fmtDMY(d)}` });
    return { top: groupDays(lo, hi, ymKey, monthLabel), bottom };
  }
  if (mode === 'Tuần') {
    const bottom = groupDays(lo, hi, (d) => String(mondayOf(d)), (d) => fmtDM(d));
    bottom.forEach((s) => { s.title = `Tuần ${fmtDMY(mondayOf(s.from))} - ${fmtDMY(mondayOf(s.from) + 6)}`; });
    return { top: groupDays(lo, hi, ymKey, monthLabel), bottom };
  }
  if (mode === 'Tháng') return { top: groupDays(lo, hi, yearKey, yearLabel), bottom: groupDays(lo, hi, ymKey, (d) => 'T' + ymd(d).m) };
  const qKey = (d: number) => { const t = ymd(d); return t.y * 10 + Math.ceil(t.m / 3) + ''; };
  return { top: groupDays(lo, hi, yearKey, yearLabel), bottom: groupDays(lo, hi, qKey, (d) => 'Q' + Math.ceil(ymd(d).m / 3)) };
}

/** Các đoạn nền: ngày lễ (từng ngày, có tên) và cuối tuần (gộp liên tiếp). */
export interface Shade { from: number; to: number; kind: 'holiday' | 'weekend'; title: string }
export function shadeRuns(cal: Calendar, lo: number, hi: number, withWeekend: boolean): Shade[] {
  const out: Shade[] = [];
  let run: Shade | null = null;
  for (let d = lo; d <= hi; d++) {
    if (cal.isHoliday(d)) {
      if (run) { out.push(run); run = null; }
      out.push({ from: d, to: d, kind: 'holiday', title: `${fmtDMY(d)} - ${cal.holidayName(d)}` });
    } else if (withWeekend && cal.isWeekend(d)) {
      if (run && run.to === d - 1) run.to = d;
      else { if (run) out.push(run); run = { from: d, to: d, kind: 'weekend', title: 'Cuối tuần' }; }
    } else if (run) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  return out;
}

/* ============================== Nguồn dữ liệu (Apps Script) ============================== */
const ERR: Record<string, string> = {
  MA_DA_KHONG_CO_TRONG_GANTT: 'Dự án này chưa có công tác nào trong sheet Gantt.',
  MA_CONG_TAC_KHONG_THUOC_DU_AN: 'Mã công tác không thuộc dự án đã chọn.',
  GIAI_NGAN_KHONG_DUOC_GIAM: 'Giải ngân lũy kế không được thấp hơn lần báo cáo trước (chỉ Giám đốc được điều chỉnh giảm).',
  KHONG_CO_NHIEM_VU_TRONG_DU_AN_NAY: 'Bạn không được giao nhiệm vụ trong dự án này.',
  PHAN_TRAM_KHONG_HOP_LE: '% tiến độ phải từ 0 đến 100.',
  TIEN_DO_KHONG_DUOC_GIAM: '% lũy kế của dự án không được thấp hơn lần báo cáo trước (chỉ Giám đốc được điều chỉnh giảm).',
  GIAI_NGAN_KHONG_HOP_LE: 'Số tiền giải ngân không hợp lệ.',
  QUA_NHIEU_ANH: 'Tối đa 6 ảnh cho mỗi báo cáo.',
  ANH_QUA_LON: 'Ảnh quá lớn.',
  ANH_KHONG_HOP_LE: 'Tệp ảnh không hợp lệ (chỉ nhận JPEG, PNG, WebP).',
  MA_DA_KHONG_KHOP_NHIEM_VU: 'Nhiệm vụ được chọn thuộc dự án khác.',
  KHONG_THUOC_NHIEM_VU: 'Bạn không thuộc nhiệm vụ được chọn.',
  EMAIL_KHONG_CO_TRONG_NHANVIEN: 'Email đăng nhập không có trong danh sách nhân viên (hoặc tài khoản đã bị khóa).',
  CHON_CONG_TAC_DE_DANH_DAU_HOAN_THANH: 'Hãy chọn công tác Gantt trước khi đánh dấu hoàn thành.',
  CHI_GIAM_DOC_DUOC_HUY_HOAN_THANH: 'Chỉ Giám đốc được hủy trạng thái hoàn thành.',
  MA_CONG_TAC_KHONG_TON_TAI: 'Mã công tác không tồn tại.',
  CHI_GIAM_DOC_DUOC_SUA: 'Chỉ Giám đốc được thực hiện thao tác này.',
  CHI_GIAM_DOC_DUOC_XEM: 'Chỉ Giám đốc được xem mục này.',
  THIEU_CLIENT_ID: 'Thiếu mã chống gửi trùng (client_id).',
  MA_DA_PHAI_7_CHU_SO: 'Mã dự án phải gồm 7 chữ số.',
  SO_CONG_NHAN_KHONG_HOP_LE: 'Số công nhân không hợp lệ.',
  EMAIL_KHONG_HOP_LE: 'Email không hợp lệ.',
  EMAIL_DA_TON_TAI: 'Email này đã được dùng cho nhân viên khác.',
  THIEU_HO_TEN: 'Thiếu họ tên.',
  VAI_TRO_KHONG_HOP_LE: 'Vai trò không hợp lệ.',
  NHAN_VIEN_KHONG_TON_TAI: 'Nhân viên không tồn tại.',
  KHONG_TU_HA_QUYEN_CHINH_MINH: 'Không thể tự hạ quyền hoặc khóa chính tài khoản của mình.',
  PHAI_CON_IT_NHAT_MOT_GIAM_DOC: 'Hệ thống phải còn ít nhất một Giám đốc đang hoạt động.',
  DU_AN_HOAC_NHAN_VIEN_KHONG_HOP_LE: 'Dự án hoặc nhân viên không hợp lệ (nhân viên phải đang hoạt động).',
  THIEU_NGAY_HOAC_TEN: 'Cần nhập đủ ngày và tên ngày nghỉ.',
  NAM_KHONG_HOP_LE: 'Năm không hợp lệ.',
  NGAY_KHONG_THUOC_NAM: 'Có ngày không thuộc năm đang sửa.',
};
export const errText = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return ERR[m] ?? ERR[m.split(':')[0]] ?? m;
};

export function createGasDataSource(gasUrl: string, getIdToken: () => Promise<string>): GanttDataSource {
  async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const idToken = await getIdToken();
    // text/plain tránh preflight CORS mà Apps Script không hỗ trợ
    const res = await fetch(gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, idToken, payload }) });
    if (!res.ok) throw new Error('MAY_CHU_HTTP_' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'LOI_KHONG_XAC_DINH');
    return j.data as T;
  }
  return {
    load: () => call<GanttPayload>('ganttBootstrap'),
    addReport: async (input) => (await call<{ report: FieldReport }>('addFieldReport', input as unknown as Record<string, unknown>)).report,
  };
}

/* ============================== Nguồn dữ liệu (Supabase) ============================== */
/** Phần tối thiểu của @supabase/supabase-js cần dùng, để component không phụ thuộc thư viện. */
export interface SupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  storage: {
    from(bucket: string): {
      upload(path: string, body: Blob, opts?: { contentType?: string; upsert?: boolean }): PromiseLike<{ data: unknown; error: { message: string } | null }>;
      getPublicUrl(path: string): { data: { publicUrl: string } };
    };
  };
}
export const PHOTO_BUCKET = 'anh-hien-truong';
export async function sbRpc<T>(sb: SupabaseLike, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}
/** Đăng nhập Supabase Auth (Google) bằng đúng email có trong bảng nhan_vien; mọi quyền do RLS + hàm rpc_* kiểm soát ở máy chủ. */
export function createSupabaseDataSource(sb: SupabaseLike): GanttDataSource {
  return {
    load: () => sbRpc<GanttPayload>(sb, 'rpc_gantt_bootstrap'),
    async addReport(input) {
      const urls: string[] = [];
      for (let i = 0; i < input.anh.length; i++) {
        const a = input.anh[i];
        const path = `${input.ma_da}/${input.client_id}-${i + 1}.jpg`; // cùng client_id -> cùng đường dẫn -> gửi lại không sinh ảnh thừa
        const up = await sb.storage.from(PHOTO_BUCKET).upload(path, b64ToBlob(a.base64, a.mime), { contentType: a.mime, upsert: true });
        if (up.error) throw new Error('Không tải được ảnh: ' + up.error.message);
        urls.push(sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl);
      }
      const { anh: _anh, ...rest } = input; void _anh;
      const r = await sbRpc<{ report_id: string; thoi_gian?: string; giai_ngan: number; ho_ten: string; ma_nv: string; anh: string }>(sb, 'rpc_add_field_report', { p: { ...rest, anh_urls: urls } });
      return {
        report_id: r.report_id, client_id: input.client_id, ma_da: input.ma_da, ma_cong_tac: input.ma_cong_tac, ma_nv: r.ma_nv, ho_ten: r.ho_ten,
        thoi_gian: r.thoi_gian ?? nowLocalIso(), phan_tram: input.phan_tram, giai_ngan: r.giai_ngan, hang_muc: input.hang_muc, kho_khan: input.kho_khan,
        thoi_tiet: input.thoi_tiet, so_cong_nhan: input.so_cong_nhan ?? '', kiem_dinh: input.kiem_dinh, anh: r.anh, ghi_chu: input.ghi_chu, task_id: input.task_id,
      };
    },
    async setTaskDone(ma, done, lyDo) { await sbRpc(sb, 'rpc_set_cong_tac_hoan_thanh', { p_ma: ma, p_done: done, p_ly_do: lyDo ?? null }); },
  };
}

/* ============================== Ảnh: nén phía trình duyệt ============================== */
export const MAX_PHOTOS = 6;
async function compressImage(file: File, maxSide = 1600, quality = 0.82): Promise<PhotoInput> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('ANH_KHONG_HOP_LE');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('ANH_KHONG_HOP_LE');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob: Blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('ANH_KHONG_HOP_LE'))), 'image/jpeg', quality));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg', base64: btoa(bin) };
}

const newClientId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const nowLocalIso = () => {
  const d = new Date(), t = todayVN(d);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  return `${isoOf(t)}T${hm}`;
};

/* ============================== Hook dữ liệu + cập nhật tức thì ============================== */
export interface GanttData { me: Me; projects: ProjectRow[]; gantt: GanttRow[]; holidays: HolidayRow[]; tasks: TaskLite[]; reports: FieldReport[] }

export function useGanttData(ds: GanttDataSource, pollMs: number, refreshKey: number) {
  const [data, setData] = useState<GanttData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const saved = useRef(new Map<string, { r: FieldReport; t: number }>()); // báo cáo vừa lưu, phòng khi lần tải về chạy trước khi ghi xong
  const doneSet = useRef(new Map<string, { done: boolean; t: number }>()); // trạng thái hoàn thành vừa đổi, phòng lần tải về cũ ghi đè
  const dsRef = useRef(ds);
  dsRef.current = ds;

  const merge = useCallback((serverReports: FieldReport[], cur: FieldReport[]) => {
    const have = new Set(serverReports.map((r) => r.client_id).filter(Boolean) as string[]);
    const now = Date.now();
    saved.current.forEach((v, k) => { if (have.has(k) || now - v.t > 120000) saved.current.delete(k); });
    const extra: FieldReport[] = [];
    cur.forEach((r) => { if (r.pending && r.client_id && !have.has(r.client_id)) extra.push(r); });
    saved.current.forEach((v) => extra.push(v.r));
    return [...serverReports, ...extra];
  }, []);

  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setLoading(true);
    try {
      const p = await dsRef.current.load();
      const now = Date.now();
      doneSet.current.forEach((v, k) => { if (now - v.t > 120000) doneSet.current.delete(k); });
      const gantt = p.gantt.map((g) => {
        const o = doneSet.current.get(g.ma_cong_tac);
        return o && (g.trang_thai === 'Hoàn thành') !== o.done ? { ...g, trang_thai: o.done ? 'Hoàn thành' : '' } : g;
      });
      setData((cur) => ({ me: p.me, projects: p.projects, gantt, holidays: p.holidays, tasks: p.tasks, reports: merge(p.reports, cur?.reports ?? []) }));
      setError('');
    } catch (e) { setError(errText(e)); } finally { if (!quiet) setLoading(false); }
  }, [merge]);

  useEffect(() => { void load(false); }, [load, refreshKey]);
  useEffect(() => {
    if (!pollMs) return;
    const tick = () => { if (!document.hidden) void load(true); };
    const id = setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [pollMs, load]);

  /** Thêm báo cáo ngay lập tức (lạc quan) rồi gửi máy chủ; lỗi thì gỡ ra và ném lỗi. */
  const submit = useCallback(async (input: ReportInput, who: Me) => {
    const tmp: FieldReport = {
      report_id: 'tmp-' + input.client_id, client_id: input.client_id, ma_da: input.ma_da, ma_cong_tac: input.ma_cong_tac, ma_nv: who.ma_nv, ho_ten: who.ho_ten,
      thoi_gian: nowLocalIso(), phan_tram: input.phan_tram, giai_ngan: input.giai_ngan, hang_muc: input.hang_muc, kho_khan: input.kho_khan,
      thoi_tiet: input.thoi_tiet, so_cong_nhan: input.so_cong_nhan ?? '', kiem_dinh: input.kiem_dinh, anh: '', ghi_chu: input.ghi_chu, task_id: input.task_id, pending: true,
    };
    const setDoneLocal = (ma: string, done: boolean) =>
      setData((d) => (d ? { ...d, gantt: d.gantt.map((g) => (g.ma_cong_tac === ma ? { ...g, trang_thai: done ? 'Hoàn thành' : '' } : g)) } : d));
    const markDone = !!input.danh_dau_hoan_thanh && !!input.ma_cong_tac;
    setData((d) => (d ? { ...d, reports: [...d.reports, tmp] } : d));
    if (markDone) setDoneLocal(input.ma_cong_tac!, true);
    try {
      const real = await dsRef.current.addReport(input);
      if (markDone) doneSet.current.set(input.ma_cong_tac!, { done: true, t: Date.now() });
      saved.current.set(input.client_id, { r: real, t: Date.now() });
      setData((d) => (d ? { ...d, reports: d.reports.map((r) => (r.client_id === input.client_id ? real : r)) } : d));
      return real;
    } catch (e) {
      setData((d) => (d ? { ...d, reports: d.reports.filter((r) => r.client_id !== input.client_id) } : d));
      if (markDone) setDoneLocal(input.ma_cong_tac!, false);
      throw e;
    }
  }, []);

  /** Đánh dấu / hủy hoàn thành một công tác, cập nhật tức thì và hoàn lại nếu máy chủ từ chối. */
  const setTaskDone = useCallback(async (ma: string, done: boolean, lyDo?: string) => {
    const fn = dsRef.current.setTaskDone;
    if (!fn) throw new Error('Nguồn dữ liệu này không hỗ trợ đánh dấu hoàn thành.');
    const apply = (v: boolean) => setData((d) => (d ? { ...d, gantt: d.gantt.map((g) => (g.ma_cong_tac === ma ? { ...g, trang_thai: v ? 'Hoàn thành' : '' } : g)) } : d));
    apply(done);
    try {
      await fn.call(dsRef.current, ma, done, lyDo);
      doneSet.current.set(ma, { done, t: Date.now() });
    } catch (e) { apply(!done); throw e; }
  }, []);

  return { data, loading, error, reload: () => load(false), submit, setTaskDone };
}

/* ============================== Trạng thái & giao diện ============================== */
export const STATUS_ORDER: EvmStatus[] = ['VUOT_TIEN_DO', 'DUNG_TIEN_DO', 'CHAM_NHE', 'CHAM_NGHIEM_TRONG', 'QUA_HAN', 'CHUA_BAT_DAU', 'HOAN_THANH'];
export const STATUS_META: Record<EvmStatus, { label: string; glyph: string; v: string }> = {
  CHUA_BAT_DAU: { label: 'Chưa bắt đầu', glyph: '○', v: 'chua' },
  HOAN_THANH: { label: 'Hoàn thành', glyph: '✓', v: 'xong' },
  QUA_HAN: { label: 'Quá hạn', glyph: '⚑', v: 'qua' },
  VUOT_TIEN_DO: { label: 'Vượt tiến độ', glyph: '▲', v: 'vuot' },
  DUNG_TIEN_DO: { label: 'Đúng tiến độ', glyph: '●', v: 'dung' },
  CHAM_NHE: { label: 'Chậm nhẹ', glyph: '▼', v: 'nhe' },
  CHAM_NGHIEM_TRONG: { label: 'Chậm nghiêm trọng', glyph: '▼▼', v: 'nang' },
};
const stVar = (s: EvmStatus) => ({ '--c': `var(--st-${STATUS_META[s].v})` }) as React.CSSProperties;
const signed = (n: number) => (n >= 0 ? '+' : '−') + fmtMoneyShort(Math.abs(n));
const spiText = (s: number | null) => (s == null ? '—' : s.toFixed(2).replace('.', ','));

const DEFAULT_WEEKEND = [0, 6];
const ROW_H = 34, HEAD_ROW = 26, FLAG_ROW = 18, HEAD_H = FLAG_ROW + HEAD_ROW * 2;
type ColKey = 'code' | 'name' | 'codename' | 'dates' | 'value' | 'pct';
interface Col { key: ColKey; w: number; title: string }
const COLS_FULL: Col[] = [
  { key: 'code', w: 150, title: 'Dự án / Mã công tác' }, { key: 'name', w: 190, title: 'Tên công tác' },
  { key: 'dates', w: 156, title: 'Bắt đầu – Kết thúc' }, { key: 'value', w: 92, title: 'Giá trị' }, { key: 'pct', w: 124, title: 'Tiến độ' },
];
const COLS_COMPACT: Col[] = [{ key: 'codename', w: 190, title: 'Dự án / Công tác' }, { key: 'pct', w: 124, title: 'Tiến độ' }];
type Layout = 'full' | 'compact' | 'none';
const LAYOUT_NEXT: Record<Layout, Layout> = { full: 'compact', compact: 'none', none: 'full' };
const LAYOUT_LABEL: Record<Layout, string> = { full: 'Bảng: đầy đủ', compact: 'Bảng: gọn', none: 'Bảng: ẩn' };
const fmtDMS = (n: number) => { const t = ymd(n); return `${p2(t.d)}/${p2(t.m)}/${String(t.y).slice(2)}`; };

const CSS = `
.gse{--bg:#fff;--bg2:#f5f6f8;--fg:#1b1f24;--mut:#5b6674;--line:#e2e5ea;--acc:#1a5fb4;--wk:rgba(110,120,135,.10);--hol:rgba(214,69,69,.17);--today:#d6336c;
--st-chua:#6f7888;--st-xong:#127373;--st-qua:#8e3bb8;--st-vuot:#1f74c9;--st-dung:#238a4c;--st-nhe:#b07800;--st-nang:#d03a3a;
font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);display:flex;flex-direction:column;gap:10px}
:root:not([data-theme="light"]) .gse{--dk:1}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .gse{--bg:#14171b;--bg2:#1b1f25;--fg:#e8ebef;--mut:#9aa6b5;--line:#2b313a;--acc:#6ea8fe;--wk:rgba(255,255,255,.05);--hol:rgba(255,107,107,.24);--today:#ff6fa3;
--st-chua:#9aa3b2;--st-xong:#3fc1c1;--st-qua:#c58aea;--st-vuot:#5fa8f5;--st-dung:#4cc57f;--st-nhe:#e8b13d;--st-nang:#ff7b7b}}
:root[data-theme="dark"] .gse{--bg:#14171b;--bg2:#1b1f25;--fg:#e8ebef;--mut:#9aa6b5;--line:#2b313a;--acc:#6ea8fe;--wk:rgba(255,255,255,.05);--hol:rgba(255,107,107,.24);--today:#ff6fa3;
--st-chua:#9aa3b2;--st-xong:#3fc1c1;--st-qua:#c58aea;--st-vuot:#5fa8f5;--st-dung:#4cc57f;--st-nhe:#e8b13d;--st-nang:#ff7b7b}
.gse *{box-sizing:border-box}
.gse button,.gse select,.gse input,.gse textarea{font:inherit;color:inherit}
.gse-bar1{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.gse-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.gse-seg button{border:0;background:var(--bg);padding:6px 12px;cursor:pointer}
.gse-seg button+button{border-left:1px solid var(--line)}
.gse-seg button[aria-checked="true"]{background:var(--acc);color:#fff}
.gse-btn{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 12px;cursor:pointer}
.gse-btn:hover{background:var(--bg2)}
.gse-btn.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.gse-btn:disabled{opacity:.55;cursor:not-allowed}
.gse :focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.gse-search{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 10px;min-width:180px}
.gse-spacer{flex:1}
.gse-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.gse-kpi{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--bg2)}
.gse-kpi small{display:block;color:var(--mut)}
.gse-kpi b{font-size:15px;font-variant-numeric:tabular-nums}
.gse-kpi em{font-style:normal;color:var(--mut);font-size:12px}
.gse-chips{display:flex;flex-wrap:wrap;gap:6px}
.gse-chip{display:inline-flex;gap:5px;align-items:center;border:1px solid var(--c,var(--line));color:var(--c,var(--fg));background:transparent;border-radius:999px;padding:2px 9px;cursor:pointer;font-size:12px}
.gse-chip[aria-pressed="true"]{background:var(--c);color:var(--bg)}
.gse-chip i{font-style:normal}
.gse-legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--mut);font-size:12px;align-items:center}
.gse-sw{display:inline-block;width:14px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:4px;border:1px solid var(--line)}
.gse-scroll{position:relative;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.gse-grid{display:grid;position:relative}
.gse-hl{position:sticky;left:0;top:0;z-index:6;background:var(--bg2);border-bottom:1px solid var(--line);border-right:1px solid var(--line);display:flex}
.gse-hr{position:sticky;top:0;z-index:4;background:var(--bg2);border-bottom:1px solid var(--line);height:${HEAD_H}px;overflow:hidden}
.gse-hc{position:absolute;display:flex;align-items:center;justify-content:center;border-right:1px solid var(--line);overflow:hidden;white-space:nowrap;font-size:12px;height:${HEAD_ROW}px}
.gse-hc.top{top:${FLAG_ROW}px;justify-content:flex-start;padding-left:6px;font-weight:600}
.gse-hc.bot{top:${FLAG_ROW + HEAD_ROW}px;border-top:1px solid var(--line);color:var(--mut)}
.gse-hc.wk{background:var(--wk)}.gse-hc.hol{background:var(--hol);color:var(--fg)}
.gse-hc.now{background:var(--today);color:#fff;font-weight:700}
.gse-hth{display:flex;align-items:center;padding:0 8px;font-weight:600;font-size:12px;border-right:1px solid var(--line);flex:none;height:${HEAD_H}px}
.gse-hth:last-child{border-right:0}
.gse-bl{position:sticky;left:0;z-index:3;background:var(--bg);border-right:1px solid var(--line)}
.gse-lr{display:flex;height:${ROW_H}px;align-items:center;border-bottom:1px solid var(--line);cursor:pointer}
.gse-lr:hover{background:var(--bg2)}
.gse-lr.sel{background:color-mix(in srgb,var(--acc) 14%,var(--bg))}
.gse-lr.prj{background:var(--bg2);font-weight:600}
.gse-lr.prj.sel{background:color-mix(in srgb,var(--acc) 14%,var(--bg2))}
.gse-c{flex:none;padding:0 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.gse-c.num{text-align:right}
.gse-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.gse-chev{display:inline-block;width:16px;color:var(--mut);cursor:pointer;user-select:none}
.gse-two{display:flex;flex-direction:column;line-height:1.15}.gse-two small{color:var(--mut)}
.gse-pct{display:flex;align-items:center;gap:6px}
.gse-track{width:28px;height:6px;border-radius:3px;background:var(--line);overflow:hidden;flex:none}
.gse-track i{display:block;height:100%}
.gse-glyph{color:var(--c);font-size:11px;min-width:14px;text-align:center;white-space:nowrap}
.gse-br{position:relative;background-image:linear-gradient(to bottom,transparent ${ROW_H - 1}px,var(--line) ${ROW_H - 1}px);background-size:100% ${ROW_H}px}
.gse-shade{position:absolute;top:0;bottom:0;pointer-events:none}
.gse-shade.weekend{background:var(--wk)}.gse-shade.holiday{background:var(--hol);pointer-events:auto}
.gse-rowsel{position:absolute;left:0;right:0;height:${ROW_H}px;background:color-mix(in srgb,var(--acc) 10%,transparent);pointer-events:none}
.gse-task{position:absolute;height:18px;margin-top:8px;border-radius:4px;border:1px solid var(--c);background:color-mix(in srgb,var(--c) 20%,transparent);cursor:pointer;overflow:hidden}
.gse-task.pending{border-style:dashed}
.gse-task.sel{box-shadow:0 0 0 2px var(--acc)}
.gse-task>i{position:absolute;left:0;top:0;bottom:0;background:var(--c);opacity:.9;transition:width .35s ease}
.gse-task>span{position:relative;padding:0 5px;font-size:11px;line-height:16px;color:var(--fg);font-weight:600;white-space:nowrap}
.gse-task.cur{outline:2px solid var(--acc);outline-offset:1px}
.gse-prj.pending{border-style:dashed}
.gse-cur{color:var(--acc);margin-right:3px;font-size:10px}
.gse-note{color:var(--mut);font-size:12px;margin:6px 0 0}
.gse-chk{display:flex;gap:8px;align-items:flex-start;flex-direction:row}.gse-chk input{margin-top:3px}
.gse-sub{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--bg2)}
.gse-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
@media (max-width:520px){.gse-row3,.gse-row2{grid-template-columns:1fr}}
.gse-pv{position:absolute;top:-1px;bottom:-1px;width:2px;background:var(--fg);opacity:.75}
.gse-prj{position:absolute;height:10px;margin-top:12px;border-radius:2px;border:1px solid var(--c);background:color-mix(in srgb,var(--c) 18%,transparent);cursor:pointer;overflow:hidden}
.gse-prj>i{position:absolute;left:0;top:0;bottom:0;background:var(--c)}
.gse-today{position:absolute;top:0;bottom:0;width:2px;background:var(--today);z-index:2;pointer-events:none}
.gse-flag{position:absolute;top:1px;z-index:7;transform:translateX(-50%);background:var(--today);color:#fff;font-size:11px;font-weight:700;border-radius:4px;padding:0 6px;line-height:16px;white-space:nowrap;pointer-events:none}
.gse-rowname{position:absolute;left:0;height:14px;pointer-events:none;z-index:1}
.gse-rowname span{position:sticky;left:6px;font-size:11px;line-height:14px;color:var(--fg);white-space:nowrap;background:color-mix(in srgb,var(--bg) 78%,transparent);padding:0 3px;border-radius:3px}
.gse-rowname span.p{font-weight:700}
.gse-br.names .gse-task{margin-top:17px;height:14px}
.gse-br.names .gse-task>span{line-height:12px;font-size:10px}
.gse-br.names .gse-prj{margin-top:20px;height:8px}
.gse-panel{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--bg)}
.gse-panel h3{margin:0 0 8px;font-size:14px}
.gse-two-col{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:12px}
@media (max-width:900px){.gse-two-col{grid-template-columns:1fr}}
.gse-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.gse-metrics div{background:var(--bg2);border-radius:8px;padding:6px 8px}
.gse-metrics small{display:block;color:var(--mut)}
.gse-metrics b{font-variant-numeric:tabular-nums}
.gse-pos{color:var(--st-dung)}.gse-neg{color:var(--st-nang)}
.gse-badge{display:inline-flex;gap:4px;align-items:center;color:var(--c);border:1px solid var(--c);border-radius:999px;padding:1px 8px;font-size:12px}
.gse-rep{border-top:1px solid var(--line);padding:8px 0;display:grid;gap:2px}
.gse-rep:first-child{border-top:0}
.gse-rep small{color:var(--mut)}
.gse-form{display:grid;gap:8px}
.gse-form label{display:grid;gap:3px;font-size:12px;color:var(--mut)}
.gse-form input[type=text],.gse-form input[type=number],.gse-form select,.gse-form textarea{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:7px 9px;color:var(--fg);width:100%}
.gse-form textarea{min-height:60px;resize:vertical}
.gse-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.gse-thumbs{display:flex;flex-wrap:wrap;gap:6px}
.gse-thumb{position:relative;width:64px;height:64px;border-radius:6px;overflow:hidden;border:1px solid var(--line)}
.gse-thumb img{width:100%;height:100%;object-fit:cover}
.gse-thumb button{position:absolute;top:1px;right:1px;border:0;border-radius:50%;width:20px;height:20px;line-height:18px;background:rgba(0,0,0,.65);color:#fff;cursor:pointer;padding:0}
.gse-msg{padding:6px 9px;border-radius:8px;font-size:12px}
.gse-msg.ok{background:color-mix(in srgb,var(--st-dung) 16%,var(--bg));color:var(--fg)}
.gse-msg.err{background:color-mix(in srgb,var(--st-nang) 16%,var(--bg));color:var(--fg)}
.gse-preview{background:var(--bg2);border-radius:8px;padding:6px 9px;font-size:12px}
.gse-warn summary{cursor:pointer;color:var(--mut)}
.gse-warn li{margin:2px 0}
.gse-empty{padding:28px;text-align:center;color:var(--mut)}
@media (prefers-reduced-motion:reduce){.gse-task>i{transition:none}}
`;


/* ============================== Giao diện chính ============================== */
export interface GanttViewProps {
  data: GanttData;
  today: number;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  evm?: Partial<EvmConfig>;
  weekendDays?: number[];
  height?: number | string;
  /** Lưu báo cáo; resolve khi máy chủ đã nhận. Bản ghi tạm đã được thêm vào `data.reports` trước đó (cập nhật tức thì). */
  onSubmitReport: (input: ReportInput) => Promise<void>;
  /** Đánh dấu / hủy hoàn thành một công tác (nút ở khung Chi tiết). */
  onSetTaskDone?: (maCongTac: string, done: boolean, lyDo?: string) => Promise<void>;
  onReload?: () => void;
}

type Row =
  | { kind: 'project'; p: ProjectModel; e: ProjectEvm }
  | { kind: 'task'; p: ProjectModel; t: TaskModel; e: TaskEvm };

const tipOfTask = (t: TaskModel, e: TaskEvm) =>
  `${t.ma_cong_tac} · ${t.ten}\n${fmtDMY(t.bd)} → ${fmtDMY(t.kt)} · ${fmtMoneyShort(t.bac)}${t.estimated ? ' (ước tính)' : ''}\n` +
  `${t.done ? 'Đã hoàn thành' : e.current ? 'Đang thi công (theo báo cáo mới nhất)' : 'Chưa đánh dấu hoàn thành'}\n` +
  `${STATUS_META[e.status].label}${e.inherited ? ' (theo dự án)' : ''}${e.overdueDays ? ` · quá hạn ${e.overdueDays} ngày` : ''}`;
const tipOfProject = (p: ProjectModel, e: ProjectEvm) =>
  `${p.ma_da} · ${p.ten_da}\nThực tế ${fmtPct(e.evPct)} · Kế hoạch ${fmtPct(e.pvPct)}\nSV ${signed(e.sv)} · SPI ${spiText(e.spi)}\n${STATUS_META[e.status].label}`;

export function GanttView(props: GanttViewProps) {
  const { data, today, mode, onModeChange, onSubmitReport } = props;
  const cfg = useMemo<EvmConfig>(() => ({ ...DEFAULT_EVM, ...props.evm }), [props.evm]);
  const weekend = props.weekendDays ?? DEFAULT_WEEKEND;
  const model = useMemo(() => buildModel(data, weekend), [data, weekend]);

  const [layout, setLayout] = useState<Layout>('full');
  useEffect(() => { if (typeof window !== 'undefined' && window.innerWidth < 720) setLayout('none'); }, []);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null); // mã công tác, hoặc "P:<maDA>"
  const [filter, setFilter] = useState<EvmStatus | null>(null);
  const [q, setQ] = useState('');

  const cal = useMemo(() => {
    const lo = Math.min(model.minDay || today, today) - 1, hi = Math.max(model.maxDay || today, today) + 1;
    return new Calendar(lo, hi, model.holidays, weekend);
  }, [model, today, weekend]);

  const prjEvms = useMemo(() => {
    const m = new Map<string, ProjectEvm>();
    model.projects.forEach((p) => m.set(p.ma_da, evmOfProject(p.tasks, model.reportsByProject.get(p.ma_da) ?? [], today, cal, cfg)));
    return m;
  }, [model, today, cal, cfg]);

  const evms = useMemo(() => {
    const m = new Map<string, TaskEvm>();
    model.projects.forEach((p) => {
      const pe = prjEvms.get(p.ma_da)!;
      const cur = String(pe.last?.ma_cong_tac ?? '').trim();
      p.tasks.forEach((t) => m.set(t.ma_cong_tac, evmOfTask(t, pe, !!cur && cur === t.ma_cong_tac && !t.done, today, cal, cfg)));
    });
    return m;
  }, [model, prjEvms, today, cal, cfg]);

  const total = useMemo(() => (model.projects.length ? sumProjects([...prjEvms.values()]) : null), [model, prjEvms]);
  const counts = useMemo(() => {
    const c = {} as Record<EvmStatus, number>;
    STATUS_ORDER.forEach((s) => (c[s] = 0));
    evms.forEach((e) => (c[e.status] += 1));
    return c;
  }, [evms]);

  const rows = useMemo<Row[]>(() => {
    const needle = q.trim().toLowerCase();
    const out: Row[] = [];
    model.projects.forEach((p) => {
      const tasks = p.tasks.filter((t) => {
        const e = evms.get(t.ma_cong_tac)!;
        if (filter && e.status !== filter) return false;
        return !needle || (t.ma_cong_tac + ' ' + t.ten + ' ' + p.ma_da + ' ' + p.ten_da).toLowerCase().includes(needle);
      });
      if (!tasks.length) return;
      out.push({ kind: 'project', p, e: prjEvms.get(p.ma_da)! });
      if (!collapsed.has(p.ma_da)) tasks.forEach((t) => out.push({ kind: 'task', p, t, e: evms.get(t.ma_cong_tac)! }));
    });
    return out;
  }, [model, evms, prjEvms, collapsed, filter, q]);

  /* --- hình học timeline --- */
  const cols = layout === 'full' ? COLS_FULL : layout === 'compact' ? COLS_COMPACT : [];
  const leftW = cols.reduce((s, c) => s + c.w, 0);
  const px = PX_PER_DAY[mode];
  const sc = useRef<HTMLDivElement>(null);
  const hasTasks = model.tasks.length > 0;
  const [vw, setVw] = useState(0); // bề rộng khung cuộn, để timeline luôn lấp đầy khung
  useEffect(() => {
    const el = sc.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el); setVw(el.clientWidth);
    return () => ro.disconnect();
  }, [hasTasks]);
  const [lo, hi] = useMemo(() => {
    const pad = { 'Ngày': 7, 'Tuần': 14, 'Tháng': 30, 'Quý': 60 }[mode];
    const a = Math.min(model.minDay || today, today) - pad;
    const b = Math.max(model.maxDay || today, today) + pad;
    return alignRange(mode, a, Math.max(b, a + Math.ceil(Math.max(0, vw - leftW) / px)));
  }, [model, today, mode, vw, leftW, px]);
  const tlW = Math.round((hi - lo + 1) * px);
  const X = (d: number) => (d - lo) * px;
  const head = useMemo(() => headerSegments(mode, lo, hi), [mode, lo, hi]);
  const weekendVisible = px >= 10; // ở chế độ Tháng/Quý cuối tuần quá dày nên chỉ tô ngày lễ
  const shades = useMemo(() => shadeRuns(cal, lo, hi, weekendVisible), [cal, lo, hi, weekendVisible]);

  /* --- cuộn: giữ nguyên ngày đang ở giữa khi đổi chế độ --- */
  const anchor = useRef<number>(today);
  const onScroll = () => {
    const el = sc.current;
    if (el) anchor.current = lo + (el.scrollLeft + (el.clientWidth - leftW) / 2) / px;
  };
  useIsoLayoutEffect(() => {
    const el = sc.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (anchor.current - lo) * px - (el.clientWidth - leftW) / 2);
  }, [mode, lo, px, leftW]);
  const goToday = () => {
    anchor.current = today;
    const el = sc.current;
    if (el) el.scrollTo({ left: Math.max(0, X(today) - (el.clientWidth - leftW) / 2), behavior: 'smooth' });
  };

  /* --- chọn dòng (hai chiều với form) --- */
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.kind === 'task' ? r.t.ma_cong_tac : 'P:' + r.p.ma_da, i));
    return m;
  }, [rows]);
  useEffect(() => {
    const el = sc.current;
    if (!el || !sel) return;
    const i = rowIndex.get(sel);
    if (i == null) return;
    const top = HEAD_H + i * ROW_H;
    if (top < el.scrollTop + HEAD_H || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    const t = model.tasks.find((x) => x.ma_cong_tac === sel);
    if (t) {
      const x1 = X(t.bd), x2 = X(t.kt + 1), vwid = el.clientWidth - leftW;
      if (x2 < el.scrollLeft || x1 > el.scrollLeft + vwid) el.scrollLeft = Math.max(0, x1 - vwid / 4);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const select = (key: string) => setSel(key);
  const toggle = (ma: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(ma)) n.delete(ma); else n.add(ma); return n; });
  const expand = (ma: string) => setCollapsed((s) => { if (!s.has(ma)) return s; const n = new Set(s); n.delete(ma); return n; });
  const selTask = sel && !sel.startsWith('P:') ? model.tasks.find((t) => t.ma_cong_tac === sel) ?? null : null;
  const selProject = selTask ? model.projects.find((p) => p.ma_da === selTask.ma_da) ?? null
    : sel?.startsWith('P:') ? model.projects.find((p) => p.ma_da === sel.slice(2)) ?? null : null;
  const pickProject = (ma: string) => { if (ma) { expand(ma); setSel('P:' + ma); } else setSel(null); };
  const pickTask = (code: string, ma: string) => { if (code) { expand(ma); setSel(code); } else setSel('P:' + ma); };

  if (!model.tasks.length) {
    return (
      <div className="gse"><style>{CSS}</style>
        <div className="gse-panel gse-empty">
          <p><b>Chưa có dữ liệu tiến độ cho dự án này.</b></p>
          <p style={{ color: 'var(--mut, #667085)' }}>Hãy chọn một dự án cụ thể ở thanh phía trên, hoặc nhập các mốc công tác (tên công tác, ngày bắt đầu/kết thúc, giá trị) để xem biểu đồ tiến độ và phân tích EVM.</p>
          {model.warnings.length > 0 && <Warnings warnings={model.warnings} />}
          {props.onReload && <button className="gse-btn" onClick={props.onReload}>Tải lại</button>}
          <details style={{ marginTop: 10, fontSize: 13 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--mut, #667085)' }}>Thông tin kỹ thuật cho quản trị</summary>
            <p style={{ marginTop: 6 }}>Sheet <code>Gantt</code> cần các cột: <code>ma_da</code>, <code>ma_cong_tac</code> (vd 8179900-001), <code>ten_cong_tac</code>, <code>ngay_bd</code>, <code>ngay_kt</code>, <code>gia_tri</code>, <code>trang_thai</code>.</p>
          </details>
        </div>
      </div>
    );
  }

  const cell = (r: Row, c: Col): React.ReactNode => {
    const isP = r.kind === 'project';
    const cur = r.kind === 'task' && r.e.current ? <span className="gse-cur" title="Công tác đang thi công (theo báo cáo mới nhất)">▶</span> : null;
    switch (c.key) {
      case 'code':
        return isP ? (
          <><span className="gse-chev" aria-hidden onClick={(e) => { e.stopPropagation(); toggle(r.p.ma_da); }}>{collapsed.has(r.p.ma_da) ? '▸' : '▾'}</span><span className="gse-mono">{r.p.ma_da}</span></>
        ) : (<span style={{ paddingLeft: 20 }}>{cur}<span className="gse-mono">{r.t.ma_cong_tac}</span></span>);
      case 'name': return isP ? r.p.ten_da : r.t.ten;
      case 'codename':
        return isP ? (
          <div className="gse-two"><span><span className="gse-chev" aria-hidden onClick={(e) => { e.stopPropagation(); toggle(r.p.ma_da); }}>{collapsed.has(r.p.ma_da) ? '▸' : '▾'}</span><span className="gse-mono">{r.p.ma_da}</span></span><small>{r.p.ten_da}</small></div>
        ) : (<div className="gse-two" style={{ paddingLeft: 16 }}><span>{cur}<span className="gse-mono">{r.t.ma_cong_tac}</span></span><small>{r.t.ten}</small></div>);
      case 'dates': return isP ? `${fmtDMS(r.e.bd)} – ${fmtDMS(r.e.kt)}` : `${fmtDMS(r.t.bd)} – ${fmtDMS(r.t.kt)}`;
      case 'value': return r.kind === 'task' && r.t.estimated ? '~' + fmtMoneyShort(r.e.bac) : fmtMoneyShort(r.e.bac);
      case 'pct':
        return (
          <div className="gse-pct">
            <div className="gse-track"><i style={{ width: `${r.e.evPct}%`, background: 'var(--c)' }} /></div>
            <b>{r.kind === 'task' && !r.t.done ? '—' : fmtPct(r.e.evPct)}</b>
            <span className="gse-glyph" title={STATUS_META[r.e.status].label} aria-label={STATUS_META[r.e.status].label}>{STATUS_META[r.e.status].glyph}</span>
          </div>
        );
    }
  };

  const selIdx = sel != null ? rowIndex.get(sel) : undefined;

  return (
    <div className="gse">
      <style>{CSS}</style>

      <div className="gse-bar1">
        <div className="gse-seg" role="radiogroup" aria-label="Chế độ timeline">
          {MODES.map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => onModeChange(m)}>{m}</button>
          ))}
        </div>
        <button className="gse-btn" onClick={goToday}>Hôm nay</button>
        <button className="gse-btn" onClick={() => setLayout(LAYOUT_NEXT[layout])} title="Đổi độ rộng bảng bên trái">{LAYOUT_LABEL[layout]}</button>
        <input className="gse-search" type="search" placeholder="Tìm mã / tên công tác, dự án" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm công tác" />
        <span className="gse-spacer" />
        <span style={{ color: 'var(--mut)', fontSize: 12 }}>Xét tại ngày {fmtDMY(today)}</span>
        {props.onReload && <button className="gse-btn" onClick={props.onReload}>Tải lại</button>}
      </div>

      {total && (
        <div className="gse-kpis" aria-label="Tổng hợp EVM toàn bộ">
          <div className="gse-kpi"><small>BAC (tổng giá trị)</small><b>{fmtMoneyShort(total.bac)}</b></div>
          <div className="gse-kpi"><small>PV (kế hoạch)</small><b>{fmtMoneyShort(total.pv)}</b> <em>{fmtPct(total.pvPct)}</em></div>
          <div className="gse-kpi"><small>EV (thực hiện)</small><b>{fmtMoneyShort(total.ev)}</b> <em>{fmtPct(total.evPct)}</em></div>
          <div className="gse-kpi"><small>SV = EV − PV</small><b className={total.sv >= 0 ? 'gse-pos' : 'gse-neg'}>{signed(total.sv)}</b></div>
          <div className="gse-kpi"><small>SPI = EV / PV</small><b>{spiText(total.spi)}</b></div>
          <div className="gse-kpi"><small>Giải ngân (lũy kế)</small><b>{fmtMoneyShort(total.giaiNgan)}</b> <em>{total.giaiNganPct == null ? '' : fmtPct(total.giaiNganPct)}</em></div>
        </div>
      )}

      <div className="gse-chips" role="group" aria-label="Lọc công tác theo trạng thái tiến độ">
        {STATUS_ORDER.map((s) => (
          <button key={s} className="gse-chip" style={stVar(s)} aria-pressed={filter === s} onClick={() => setFilter(filter === s ? null : s)}>
            <i aria-hidden>{STATUS_META[s].glyph}</i>{STATUS_META[s].label} <b>{counts[s]}</b>
          </button>
        ))}
      </div>

      <div className="gse-scroll" ref={sc} onScroll={onScroll} style={{ height: props.height ?? 'min(70vh, 640px)' }}>
        <div className="gse-grid" style={{ gridTemplateColumns: `${leftW}px ${tlW}px`, width: leftW + tlW }}>
          <div className="gse-hl" style={{ width: leftW, overflow: 'hidden', visibility: leftW ? 'visible' : 'hidden', borderRightWidth: leftW ? 1 : 0 }}>
            {cols.map((c) => <div key={c.key} className="gse-hth" style={{ width: c.w }}>{c.title}</div>)}
          </div>
          <div className="gse-hr" style={{ width: tlW }}>
            {head.top.map((s) => <div key={'t' + s.from} className="gse-hc top" style={{ left: X(s.from), width: (s.to - s.from + 1) * px }}>{s.label}</div>)}
            {head.bottom.map((s) => {
              const cls = mode === 'Ngày' ? (s.from === today ? 'now' : cal.isHoliday(s.from) ? 'hol' : cal.isWeekend(s.from) ? 'wk' : '') : '';
              return <div key={'b' + s.from} className={`gse-hc bot ${cls}`} title={s.title ?? (cal.isHoliday(s.from) ? cal.holidayName(s.from) : undefined)} style={{ left: X(s.from), width: (s.to - s.from + 1) * px }}>{s.label}</div>;
            })}
            <span className="gse-flag" style={{ left: X(today) + px / 2 }}>Hôm nay {fmtDM(today)}</span>
          </div>

          <div className="gse-bl" style={{ width: leftW, overflow: 'hidden', visibility: leftW ? 'visible' : 'hidden', borderRightWidth: leftW ? 1 : 0 }} role="tree" aria-label="Dự án và công tác">
            {rows.map((r) => {
              const key = r.kind === 'task' ? r.t.ma_cong_tac : 'P:' + r.p.ma_da;
              return (
                <div
                  key={key} role="treeitem" aria-level={r.kind === 'project' ? 1 : 2} aria-selected={sel === key}
                  aria-expanded={r.kind === 'project' ? !collapsed.has(r.p.ma_da) : undefined} tabIndex={0}
                  className={`gse-lr ${r.kind === 'project' ? 'prj' : ''} ${sel === key ? 'sel' : ''}`} style={stVar(r.e.status)}
                  onClick={() => select(key)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(key); }
                    else if (r.kind === 'project' && ev.key === 'ArrowRight' && collapsed.has(r.p.ma_da)) toggle(r.p.ma_da);
                    else if (r.kind === 'project' && ev.key === 'ArrowLeft' && !collapsed.has(r.p.ma_da)) toggle(r.p.ma_da);
                  }}
                >
                  {cols.map((c) => (
                    <div key={c.key} className={`gse-c ${c.key === 'value' ? 'num' : ''}`} style={{ width: c.w }} title={c.key === 'name' || c.key === 'codename' ? (r.kind === 'task' ? r.t.ten : r.p.ten_da) : undefined}>{cell(r, c)}</div>
                  ))}
                </div>
              );
            })}
          </div>

          <div className={`gse-br ${layout === 'none' ? 'names' : ''}`} style={{ width: tlW, height: rows.length * ROW_H }}>
            {shades.map((s) => (
              <div key={s.kind + s.from} className={`gse-shade ${s.kind}`} title={s.title} style={{ left: X(s.from), width: (s.to - s.from + 1) * px }} />
            ))}
            {selIdx != null && <div className="gse-rowsel" style={{ top: selIdx * ROW_H }} />}
            {layout === 'none' && rows.map((r, i) => (
              <div key={'n' + i} className="gse-rowname" style={{ top: i * ROW_H, width: tlW }}>
                <span className={r.kind === 'project' ? 'p' : ''}>{r.kind === 'project' ? `${r.p.ma_da} · ${r.p.ten_da}` : `${r.t.ma_cong_tac} · ${r.t.ten}`}</span>
              </div>
            ))}
            {rows.map((r, i) => {
              if (r.kind === 'project') {
                const w = Math.max(3, (r.e.kt - r.e.bd + 1) * px);
                return (
                  <div key={'P:' + r.p.ma_da} className={`gse-prj ${r.e.last?.pending ? 'pending' : ''}`} style={{ ...stVar(r.e.status), top: i * ROW_H, left: X(r.e.bd), width: w }}
                    title={tipOfProject(r.p, r.e)} onClick={() => select('P:' + r.p.ma_da)}><i style={{ width: `${r.e.evPct}%` }} /></div>
                );
              }
              const { t, e } = r;
              const w = Math.max(3, (t.kt - t.bd + 1) * px);
              const showPv = !t.done && e.status !== 'CHUA_BAT_DAU' && e.status !== 'QUA_HAN' && e.pvPct > 0 && e.pvPct < 100;
              return (
                <div key={t.ma_cong_tac} className={`gse-task ${e.current ? 'cur' : ''} ${sel === t.ma_cong_tac ? 'sel' : ''}`}
                  style={{ ...stVar(e.status), top: i * ROW_H, left: X(t.bd), width: w }} title={tipOfTask(t, e)} onClick={() => select(t.ma_cong_tac)}>
                  <i style={{ width: `${e.evPct}%` }} />
                  {showPv && <b className="gse-pv" style={{ left: `${e.pvPct}%` }} />}
                  {w >= 44 && <span>{t.done ? '✓ 100%' : e.current ? '▶ đang thi công' : ''}</span>}
                </div>
              );
            })}
            <div className="gse-today" style={{ left: X(today) + px / 2 - 1 }} />
          </div>
        </div>
      </div>

      <div className="gse-legend">
        <span><span className="gse-sw" style={{ background: 'var(--wk)' }} />Cuối tuần{weekendVisible ? '' : ' (chỉ hiện ở chế độ Ngày, Tuần)'}</span>
        <span><span className="gse-sw" style={{ background: 'var(--hol)' }} />Ngày nghỉ lễ (sheet Holidays)</span>
        <span><span className="gse-sw" style={{ background: 'var(--today)' }} />Hôm nay</span>
        <span><span className="gse-sw" style={{ background: 'var(--fg)', width: 3 }} />Vạch kế hoạch (PV) trên thanh</span>
        <span>▶ công tác đang thi công · thanh đậm = đã hoàn thành · dòng dự án: thanh đậm = EV dự án · viền nét đứt = đang gửi báo cáo</span>
      </div>

      <div className="gse-two-col">
        <div className="gse-panel">
          {selProject
            ? <Detail p={selProject} e={prjEvms.get(selProject.ma_da)!} task={selTask} taskEvm={selTask ? evms.get(selTask.ma_cong_tac)! : null}
                reports={model.reportsByProject.get(selProject.ma_da) ?? []} evms={evms} onPick={(code) => pickTask(code, selProject.ma_da)}
                role={data.me.role} onSetDone={props.onSetTaskDone} />
            : <><h3>Chi tiết</h3><p style={{ color: 'var(--mut)', margin: 0 }}>Chọn một dự án hoặc công tác ở bảng trên để xem PV, EV, SV và lịch sử báo cáo.</p></>}
        </div>
        <div className="gse-panel">
          <h3>Báo cáo hiện trường</h3>
          <ReportForm
            model={model} prjEvms={prjEvms} cal={cal} cfg={cfg} today={today} role={data.me.role} tasks={data.tasks} onSubmit={onSubmitReport}
            projectCode={selProject?.ma_da ?? ''} taskCode={selTask?.ma_cong_tac ?? ''} onPickProject={pickProject} onPickTask={pickTask}
          />
        </div>
      </div>

      {model.warnings.length > 0 && <Warnings warnings={model.warnings} />}
    </div>
  );
}

function Warnings({ warnings }: { warnings: Warn[] }) {
  const errs = warnings.filter((w) => w.level === 'err').length;
  return (
    <details className="gse-warn">
      <summary>Cảnh báo dữ liệu: {errs} lỗi, {warnings.length - errs} lưu ý</summary>
      <ul>{warnings.slice(0, 200).map((w, i) => <li key={i}>{w.level === 'err' ? '⛔ ' : '⚠ '}{w.text}</li>)}</ul>
      {warnings.length > 200 && <p>… và {warnings.length - 200} cảnh báo khác.</p>}
    </details>
  );
}

function Metrics({ e }: { e: ProjectEvm }) {
  return (
    <div className="gse-metrics">
      <div><small>BAC (giá trị)</small><b>{fmtVnd(e.bac)}</b></div>
      <div><small>PV (kế hoạch)</small><b>{fmtVnd(e.pv)}</b><small>{fmtPct(e.pvPct)}</small></div>
      <div><small>EV (thực hiện)</small><b>{fmtVnd(e.ev)}</b><small>{fmtPct(e.evPct)}</small></div>
      <div><small>SV = EV − PV</small><b className={e.sv >= 0 ? 'gse-pos' : 'gse-neg'}>{(e.sv >= 0 ? '+' : '−') + fmtVnd(Math.abs(e.sv))}</b></div>
      <div><small>SPI = EV / PV</small><b>{spiText(e.spi)}</b></div>
      <div><small>Giải ngân lũy kế</small><b>{fmtVnd(e.giaiNgan)}</b><small>{e.giaiNganPct == null ? '' : fmtPct(e.giaiNganPct) + ' BAC'}</small></div>
    </div>
  );
}

function StatusBadge({ s }: { s: EvmStatus }) {
  return <span className="gse-badge" style={stVar(s)}><span aria-hidden>{STATUS_META[s].glyph}</span>{STATUS_META[s].label}</span>;
}

const SAFE_HOSTS = ['drive.google.com', 'ibb.co', 'i.ibb.co'];
export function safeUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return false;
    if (SAFE_HOSTS.includes(x.hostname)) return true;
    return /\.supabase\.co$/.test(x.hostname) && x.pathname.startsWith('/storage/v1/object/public/anh-hien-truong/'); // ảnh trong kho của hệ thống
  } catch { return false; }
}

function Detail({ p, e, task, taskEvm, reports, evms, onPick, role, onSetDone }: {
  p: ProjectModel; e: ProjectEvm; task: TaskModel | null; taskEvm: TaskEvm | null; reports: FieldReport[]; evms: Map<string, TaskEvm>; onPick: (code: string) => void;
  role: Me['role']; onSetDone?: (ma: string, done: boolean, lyDo?: string) => Promise<void>;
}) {
  const [doneBusy, setDoneBusy] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const toggleDone = async (done: boolean) => {
    if (!task || !onSetDone || doneBusy) return;
    if (!done && typeof window !== 'undefined' && !window.confirm(`Hủy trạng thái hoàn thành của ${task.ma_cong_tac}?`)) return;
    setDoneBusy(true); setDoneMsg('');
    try { await onSetDone(task.ma_cong_tac, done); } catch (err) { setDoneMsg(errText(err)); } finally { setDoneBusy(false); }
  };
  useEffect(() => setDoneMsg(''), [task?.ma_cong_tac]);
  const list = useMemo(() => [...reports].sort((a, b) => (parseDay(b.thoi_gian) as number) - (parseDay(a.thoi_gian) as number) || tsOf(b).localeCompare(tsOf(a))), [reports]);
  const late = useMemo(
    () => p.tasks.filter((t) => evms.get(t.ma_cong_tac)!.overdueDays > 0).sort((a, b) => evms.get(b.ma_cong_tac)!.overdueDays - evms.get(a.ma_cong_tac)!.overdueDays).slice(0, 5),
    [p, evms],
  );
  return (
    <>
      <h3><span className="gse-mono">{p.ma_da}</span> · {p.ten_da} <StatusBadge s={e.status} /></h3>
      <p style={{ margin: '0 0 8px', color: 'var(--mut)' }}>
        {e.nTasks} công tác ({e.nDone} hoàn thành{e.nOverdue ? `, ${e.nOverdue} quá hạn chưa đánh dấu` : ''}) · {fmtDMY(e.bd)} → {fmtDMY(e.kt)} · đã qua {fmtPct(e.timePct)} thời gian
      </p>
      <Metrics e={e} />
      <p className="gse-note">
        EV = lớn hơn của % báo cáo mới nhất ({e.reportedPct == null ? 'chưa có' : fmtPct(e.reportedPct)}) và tỷ lệ giá trị công tác đã hoàn thành ({fmtPct(e.donePct)}).
      </p>
      {task && taskEvm && (
        <div className="gse-sub">
          <b><span className="gse-mono">{task.ma_cong_tac}</span> · {task.ten}</b> <StatusBadge s={taskEvm.status} />
          <div className="gse-note">
            {fmtDMY(task.bd)} → {fmtDMY(task.kt)} · {fmtVnd(task.bac)}{task.estimated ? ' (ước tính vì thiếu giá trị)' : ''} ·{' '}
            {task.done ? 'đã hoàn thành' : taskEvm.current ? 'đang thi công theo báo cáo mới nhất' : 'chưa đánh dấu hoàn thành'}
            {taskEvm.inherited ? ' · trạng thái lấy theo dự án' : ''}{taskEvm.overdueDays ? ` · quá hạn ${taskEvm.overdueDays} ngày` : ''}
          </div>
          {onSetDone && (
            <div style={{ marginTop: 6 }}>
              {!task.done && <button className="gse-btn pri" type="button" disabled={doneBusy} onClick={() => void toggleDone(true)}>{doneBusy ? 'Đang lưu…' : '✔ Đánh dấu hoàn thành'}</button>}
              {task.done && role === 'DIRECTOR' && <button className="gse-btn" type="button" disabled={doneBusy} onClick={() => void toggleDone(false)}>{doneBusy ? 'Đang lưu…' : 'Hủy hoàn thành (Giám đốc)'}</button>}
              {doneMsg && <div className="gse-msg err" role="alert">{doneMsg}</div>}
            </div>
          )}
        </div>
      )}
      {!task && late.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Công tác quá hạn chưa đánh dấu hoàn thành</h3>
          {late.map((t) => (
            <div key={t.ma_cong_tac} className="gse-rep"><button className="gse-btn" onClick={() => onPick(t.ma_cong_tac)} style={{ textAlign: 'left' }}>
              <span className="gse-mono">{t.ma_cong_tac}</span> {t.ten} · quá {evms.get(t.ma_cong_tac)!.overdueDays} ngày</button></div>
          ))}
        </>
      )}
      <h3 style={{ marginTop: 12 }}>Lịch sử báo cáo của dự án ({list.length})</h3>
      {list.length === 0 && <p style={{ color: 'var(--mut)', margin: 0 }}>Chưa có báo cáo hiện trường.</p>}
      {list.slice(0, 30).map((r) => {
        const urls = String(r.anh ?? '').split(/\s*\|\s*|\s+/).filter(Boolean);
        const g = parseNum(r.giai_ngan);
        return (
          <div key={r.report_id} className="gse-rep">
            <div><b>{fmtPct(parseNum(r.phan_tram))}</b>{isFinite(g) && g > 0 ? ` · giải ngân lũy kế ${fmtVnd(g)}` : ''}{r.pending ? ' · đang gửi…' : ''}</div>
            <small>
              {String(r.thoi_gian).replace('T', ' ').slice(0, 16)} · {r.ho_ten || r.ma_nv || ''}
              {r.ma_cong_tac ? ` · công tác ${r.ma_cong_tac}` : ''}{r.thoi_tiet ? ` · ${r.thoi_tiet}` : ''}
              {r.so_cong_nhan !== undefined && r.so_cong_nhan !== '' ? ` · ${r.so_cong_nhan} công nhân` : ''}{r.kiem_dinh ? ` · chất lượng: ${r.kiem_dinh}` : ''}
              {r.task_id ? ` · nhiệm vụ ${r.task_id}` : ''}
            </small>
            {r.hang_muc ? <div>{r.hang_muc}</div> : null}
            {r.kho_khan && !/^(không( có)?|k)$/i.test(r.kho_khan.trim()) ? <div className="gse-note">Khó khăn: {r.kho_khan}</div> : null}
            {r.ghi_chu ? <div className="gse-note">{r.ghi_chu}</div> : null}
            {urls.length > 0 && (
              <div>{urls.map((u, i) => (safeUrl(u)
                ? <a key={i} href={u} target="_blank" rel="noopener noreferrer" style={{ marginRight: 8 }}>Ảnh {i + 1}</a>
                : <span key={i} style={{ marginRight: 8 }}>Ảnh {i + 1}</span>))}</div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* ============================== Form báo cáo hiện trường ============================== */
const WEATHER = ['Nắng', 'Âm u', 'Mưa'];
const QUALITY = ['Đạt', 'Đạt có điều kiện', 'Không đạt'];
interface FormProps {
  model: Model; prjEvms: Map<string, ProjectEvm>; cal: Calendar; cfg: EvmConfig; today: number; role: Me['role']; tasks: TaskLite[];
  projectCode: string; taskCode: string; onPickProject: (ma: string) => void; onPickTask: (code: string, ma: string) => void;
  onSubmit: (input: ReportInput) => Promise<void>;
}
function ReportForm({ model, prjEvms, cal, cfg, today, role, tasks, projectCode, taskCode, onPickProject, onPickTask, onSubmit }: FormProps) {
  const [pct, setPct] = useState('');
  const [gn, setGn] = useState('');
  const [hm, setHm] = useState('');
  const [kk, setKk] = useState('');
  const [tt, setTt] = useState('Nắng');
  const [cn, setCn] = useState('');
  const [kd, setKd] = useState('Đạt');
  const [note, setNote] = useState('');
  const [taskId, setTaskId] = useState('');
  const [markDone, setMarkDone] = useState(false);
  const [photos, setPhotos] = useState<{ file: File; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const idRef = useRef<{ sig: string; id: string }>({ sig: '', id: newClientId() });
  const prj = useMemo(() => model.projects.find((p) => p.ma_da === projectCode) ?? null, [model, projectCode]);
  const cur = prj ? prjEvms.get(prj.ma_da)! : null;
  const taskObj = useMemo(() => (prj ? prj.tasks.find((t) => t.ma_cong_tac === taskCode) ?? null : null), [prj, taskCode]);

  // đổi dự án -> điền sẵn % hiện tại của dự án
  useEffect(() => {
    setPct(cur ? String(Math.round((cur.reportedPct ?? cur.evPct) * 10) / 10) : '');
    setGn(''); setTaskId(''); setMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectCode]);
  // chọn công tác -> gợi ý hạng mục thi công
  useEffect(() => { if (taskObj) setHm(taskObj.ten); }, [taskObj]);
  useEffect(() => { setMarkDone(false); }, [taskCode, projectCode]);
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const pctN = parseNum(pct), gnBlank = gn.trim() === '', gnN = gnBlank ? 0 : parseNum(gn);
  const prevPct = cur?.reportedPct ?? 0, prevGn = cur?.giaiNgan ?? 0;
  const gnFinal = gnBlank ? prevGn : gnN; // bỏ trống = giữ giải ngân lũy kế trước đó
  let problem = '';
  if (!prj) problem = 'Chọn dự án.';
  else if (!isFinite(pctN) || pctN < 0 || pctN > 100) problem = '% tiến độ phải từ 0 đến 100.';
  else if (pctN < prevPct - 1e-9 && role !== 'DIRECTOR') problem = `% lũy kế của dự án không được thấp hơn lần báo cáo trước (${fmtPct(prevPct)}).`;
  else if (!isFinite(gnFinal) || gnFinal < 0) problem = 'Số tiền giải ngân không hợp lệ.';
  else if (!gnBlank && gnFinal < prevGn - 0.5 && role !== 'DIRECTOR') problem = `Giải ngân lũy kế không được thấp hơn lần trước (${fmtVnd(prevGn)}).`;
  else if (cn.trim() !== '' && (!/^\d{1,4}$/.test(cn.trim()))) problem = 'Số công nhân phải là số nguyên không âm.';

  const preview = useMemo(() => {
    if (!prj || problem) return null;
    const hyp: FieldReport = { report_id: 'preview', ma_da: prj.ma_da, thoi_gian: nowLocalIso() + '9', phan_tram: pctN, giai_ngan: gnFinal };
    return evmOfProject(prj.tasks, [...(model.reportsByProject.get(prj.ma_da) ?? []), hyp], today, cal, cfg);
  }, [prj, problem, pctN, gnFinal, model, today, cal, cfg]);

  const linkable = useMemo(() => (prj ? tasks.filter((x) => String(x.ma_da) === prj.ma_da) : []), [tasks, prj]);

  const addFiles = (fl: FileList | null) => {
    if (!fl) return;
    const next = [...photos];
    for (const f of Array.from(fl)) {
      if (next.length >= MAX_PHOTOS) { setMsg({ ok: false, text: `Tối đa ${MAX_PHOTOS} ảnh.` }); break; }
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setMsg({ ok: false, text: `Bỏ qua "${f.name}": chỉ nhận JPEG, PNG, WebP.` }); continue; }
      next.push({ file: f, url: URL.createObjectURL(f) });
    }
    setPhotos(next);
  };
  const removePhoto = (i: number) => { URL.revokeObjectURL(photos[i].url); setPhotos(photos.filter((_, k) => k !== i)); };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!prj || problem || busy) return;
    setBusy(true); setMsg(null);
    try {
      const anh: PhotoInput[] = [];
      for (const p of photos) anh.push(await compressImage(p.file)); // lần lượt để tiết kiệm bộ nhớ trên điện thoại
      const input: ReportInput = {
        client_id: '', ma_da: prj.ma_da, phan_tram: pctN, giai_ngan: gnFinal, ghi_chu: note.trim(), ma_cong_tac: taskCode || undefined,
        task_id: taskId || undefined, danh_dau_hoan_thanh: markDone && !!taskObj && !taskObj.done ? true : undefined, hang_muc: hm.trim(), kho_khan: kk.trim(), thoi_tiet: tt, so_cong_nhan: cn.trim() === '' ? null : Number(cn.trim()), kiem_dinh: kd, anh,
      };
      const sig = JSON.stringify({ ...input, anh: photos.map((p) => p.file.name + p.file.size) });
      if (idRef.current.sig !== sig) idRef.current = { sig, id: newClientId() }; // gửi lại cùng nội dung -> cùng client_id (máy chủ chống ghi trùng)
      input.client_id = idRef.current.id;
      await onSubmit(input);
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      setPhotos([]); setGn(''); setNote(''); setKk(''); setMarkDone(false); idRef.current = { sig: '', id: newClientId() };
      setMsg({ ok: true, text: 'Đã lưu. Thanh tiến độ và EV đã cập nhật.' });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) + ' (báo cáo chưa được lưu; bấm Gửi lại để thử lần nữa)' });
    } finally { setBusy(false); }
  };

  return (
    <form className="gse-form" onSubmit={submit}>
      <label>Dự án (maDA)
        <select value={projectCode} onChange={(e) => onPickProject(e.target.value)} aria-label="Dự án">
          <option value="">— chọn —</option>
          {model.projects.map((p) => <option key={p.ma_da} value={p.ma_da}>{p.ma_da} — {p.ten_da}</option>)}
        </select>
      </label>
      <label>Mã công tác Gantt đang thi công (tùy chọn)
        <select value={taskCode} onChange={(e) => prj && onPickTask(e.target.value, prj.ma_da)} disabled={!prj} aria-label="Mã công tác Gantt">
          <option value="">— không chọn —</option>
          {(prj?.tasks ?? []).map((t) => <option key={t.ma_cong_tac} value={t.ma_cong_tac}>{t.ma_cong_tac} — {t.ten}{t.done ? ' (đã hoàn thành)' : ''}</option>)}
        </select>
      </label>
      {taskObj && !taskObj.done && (
        <label className="gse-chk">
          <input type="checkbox" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />
          Công tác {taskObj.ma_cong_tac} đã hoàn thành (đánh dấu theo báo cáo này, dùng để tính KPI)
        </label>
      )}
      <div className="gse-row2">
        <label>% tiến độ lũy kế của dự án{cur?.reportedPct != null ? ` (trước: ${fmtPct(cur.reportedPct)})` : ''}
          <input type="number" inputMode="decimal" min={0} max={100} step={0.5} value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Phần trăm tiến độ" />
        </label>
        <label>Giải ngân lũy kế của dự án (đ)
          <input type="text" inputMode="numeric" placeholder={prevGn ? fmtVnd(prevGn) : '0'} value={gn} onChange={(e) => setGn(e.target.value)} aria-label="Giải ngân" />
        </label>
      </div>
      <label>Hạng mục thi công
        <input type="text" value={hm} onChange={(e) => setHm(e.target.value)} maxLength={500} aria-label="Hạng mục thi công" />
      </label>
      <label>Khó khăn, vướng mắc
        <input type="text" value={kk} onChange={(e) => setKk(e.target.value)} maxLength={1000} />
      </label>
      <div className="gse-row3">
        <label>Thời tiết
          <select value={tt} onChange={(e) => setTt(e.target.value)}>{WEATHER.map((w) => <option key={w}>{w}</option>)}</select>
        </label>
        <label>Số công nhân
          <input type="number" inputMode="numeric" min={0} max={9999} value={cn} onChange={(e) => setCn(e.target.value)} />
        </label>
        <label>Kiểm định chất lượng
          <select value={kd} onChange={(e) => setKd(e.target.value)}>{QUALITY.map((w) => <option key={w}>{w}</option>)}</select>
        </label>
      </div>
      {linkable.length > 0 && (
        <label>Nhiệm vụ liên quan (tùy chọn - chỉ gắn nhãn)
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">— không gắn —</option>
            {linkable.map((x) => <option key={x.task_id} value={x.task_id}>{x.task_id} — {x.tieu_de}</option>)}
          </select>
        </label>
      )}
      <label>Ghi chú
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </label>
      <label>Ảnh hiện trường ({photos.length}/{MAX_PHOTOS})
        <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      </label>
      {photos.length > 0 && (
        <div className="gse-thumbs">
          {photos.map((p, i) => (
            <div className="gse-thumb" key={p.url}><img src={p.url} alt={`Ảnh ${i + 1}`} /><button type="button" aria-label={`Bỏ ảnh ${i + 1}`} onClick={() => removePhoto(i)}>×</button></div>
          ))}
        </div>
      )}
      {preview && cur && (
        <div className="gse-preview">
          Sau khi lưu: EV dự án {fmtMoneyShort(preview.ev)} ({fmtPct(preview.evPct)}) · SV <b className={preview.sv >= 0 ? 'gse-pos' : 'gse-neg'}>{signed(preview.sv)}</b> · SPI {spiText(preview.spi)} · <StatusBadge s={preview.status} />
        </div>
      )}
      {problem && projectCode && <div className="gse-msg err" role="alert">{problem}</div>}
      {msg && <div className={`gse-msg ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      <div><button className="gse-btn pri" type="submit" disabled={busy || !!problem}>{busy ? 'Đang gửi…' : msg && !msg.ok ? 'Gửi lại' : 'Gửi báo cáo'}</button></div>
    </form>
  );
}

/* ============================== Component gốc ============================== */
export interface GanttScheduleEngineProps {
  gasUrl?: string;
  getIdToken?: () => Promise<string>;
  /** Thay nguồn dữ liệu (vd createSupabaseDataSource(supabase)). Bỏ qua gasUrl/getIdToken nếu có. */
  dataSource?: GanttDataSource;
  initialMode?: Mode;
  /** Tự tải lại mỗi N ms (0 = tắt). Mặc định 30 giây; tạm dừng khi tab bị ẩn. */
  pollMs?: number;
  evm?: Partial<EvmConfig>;
  /** Mặc định [0, 6] = Chủ nhật, Thứ bảy. */
  weekendDays?: number[];
  /** yyyy-mm-dd; chỉ dùng để thử/chụp màn hình. Mặc định: hôm nay theo giờ Việt Nam. */
  today?: string;
  /** Tăng giá trị này để buộc tải lại (vd sau khi phân hệ Nhiệm vụ ghi dữ liệu). */
  refreshKey?: number;
  onReportSaved?: (r: FieldReport) => void;
  height?: number | string;
}

const NO_SOURCE: GanttDataSource = {
  load: () => Promise.reject(new Error('Chưa cấu hình nguồn dữ liệu (gasUrl + getIdToken hoặc dataSource).')),
  addReport: () => Promise.reject(new Error('Chưa cấu hình nguồn dữ liệu.')),
};

export default function GanttScheduleEngine(props: GanttScheduleEngineProps) {
  const ds = useMemo(
    () => props.dataSource ?? (props.gasUrl && props.getIdToken ? createGasDataSource(props.gasUrl, props.getIdToken) : NO_SOURCE),
    [props.dataSource, props.gasUrl, props.getIdToken],
  );
  const { data, loading, error, reload, submit, setTaskDone } = useGanttData(ds, props.pollMs ?? 30000, props.refreshKey ?? 0);
  const [mode, setMode] = useState<Mode>(props.initialMode ?? 'Tuần');
  const [now, setNow] = useState(() => (props.today ? parseDay(props.today) ?? todayVN() : todayVN()));
  useEffect(() => {
    if (props.today) { setNow(parseDay(props.today) ?? todayVN()); return; }
    const id = setInterval(() => setNow(todayVN()), 60000);
    return () => clearInterval(id);
  }, [props.today]);

  const onSubmitReport = useCallback(async (input: ReportInput) => {
    if (!data) return;
    const real = await submit(input, data.me);
    props.onReportSaved?.(real);
  }, [data, submit, props]);

  if (!data) {
    return (
      <div className="gse"><style>{CSS}</style>
        <div className="gse-panel gse-empty" role={error ? 'alert' : 'status'}>
          {loading ? 'Đang tải Gantt…' : <><p>Không tải được dữ liệu: {error || 'không rõ lỗi'}</p><button className="gse-btn" onClick={() => void reload()}>Thử lại</button></>}
        </div>
      </div>
    );
  }
  return (
    <>
      {error && <div className="gse" role="alert"><style>{CSS}</style><div className="gse-msg err">Lần tải gần nhất lỗi: {error}. Đang hiển thị dữ liệu đã có.</div></div>}
      <GanttView
        data={data} today={now} mode={mode} onModeChange={setMode} evm={props.evm} weekendDays={props.weekendDays}
        height={props.height} onSubmitReport={onSubmitReport} onSetTaskDone={ds.setTaskDone ? setTaskDone : undefined} onReload={() => void reload()}
      />
    </>
  );
}
