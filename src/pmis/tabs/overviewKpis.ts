/**
 * overviewKpis.ts — tính chỉ số Tab 1 từ ảnh chụp Master DB (hàm thuần, kiểm thử được).
 * Khoá cột là snake_case (Apps Script chuẩn hoá camelCase/dấu cách → snake_case).
 * Cột nào chưa có trong Master DB thì dùng giá trị suy ra (ghi rõ ở từng chỗ) để trang vẫn hiển thị được.
 */
import { OverviewData, Row, str, toNum, inProject } from '../usePmisStore';
import { REQUIRED_DOCS, PHASES, classifyPhase, norm, TaiLieuRow, GoiThauRow } from '../SettlementZipExporter';

export type TinhTrang = 'Chưa khởi công' | 'Đúng tiến độ' | 'Cần lưu ý' | 'Chậm tiến độ' | 'Quá hạn' | 'Đã hoàn thành';

export interface ProjectKpi {
  ma_da: string; ten_da: string; loai: string; ptKyThuat: string; ptKeToan: string;
  tmdt: number; vonCap: number; giaiNgan: number; tyLeGiaiNgan: number | null;
  hdTong: number; luyKe: number; ntDaThanhToan: number; ntSoHoSo: number;
  tienDoTg: number | null; tinhTrang: TinhTrang; batDau: string; ketThuc: string;
}

export type AlertLevel = 'CAO' | 'TRUNG_BINH' | 'THAP';
export interface MissingAlert { key: string; ma_da: string; muc: AlertLevel; nhom: 'KY_THUAT' | 'KE_TOAN'; text: string }

export interface OverviewKpi {
  tong: number; hoanThanh: number; dangThucHien: number; cham: number; quaHan: number; chuaKhoiCong: number;
  tmdt: number; vonCap: number; giaiNgan: number; tyLeGiaiNgan: number | null;
  luyKe: number; ntDaThanhToan: number; chenhNghiemThu: number;
  projects: ProjectKpi[];
  alerts: MissingAlert[];
}

/** Ngày dạng yyyy-MM-dd[T…] hoặc dd/MM/yyyy → mili giây UTC (nửa đêm). null nếu không đọc được. */
export function parseDateMs(v: unknown): number | null {
  const s = str(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return null;
}

export function todayVnMs(now: Date = new Date()): number {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now); // yyyy-mm-dd
  return parseDateMs(p) as number;
}

/**
 * Tình trạng tiến độ — cùng quy tắc với sheet "Dự án":
 *  hoàn thành → chưa khởi công → quá hạn (hết hạn mà chưa hoàn thành) → so tiến độ thời gian với tỷ lệ giải ngân:
 *  chênh ≥ 20 điểm = Chậm; ≥ 10 điểm = Cần lưu ý; còn lại = Đúng tiến độ. (Ngưỡng suy ra từ dữ liệu thật; chỉnh tại đây.)
 */
export function classifyProgress(a: { trangThai: string; bd: number | null; kt: number | null; tienDoTg: number | null; tyLeGn: number | null }, today: number): TinhTrang {
  const tt = norm(a.trangThai);
  if (tt.includes('hoan thanh')) return 'Đã hoàn thành';
  if (tt.includes('chua khoi cong') || (a.bd != null && a.bd > today)) return 'Chưa khởi công';
  if (a.kt != null && a.kt < today) return 'Quá hạn';
  if (a.tienDoTg == null || a.tyLeGn == null) return 'Đúng tiến độ';
  const gap = a.tienDoTg - a.tyLeGn;
  return gap >= 0.2 ? 'Chậm tiến độ' : gap >= 0.1 ? 'Cần lưu ý' : 'Đúng tiến độ';
}

const FUND_COLS = ['nguon_chuan_bi_dau_tu', 'nguon_ns_tap_trung', 'nguon_thu_tien_sdd', 'nguon_tang_thu_tien_sdd_tinh_bo_sung', 'von_tinh_xskt',
  'von_chuan_bi_dau_tu', 'von_ns_tap_trung', 'von_sdd', 'von_tang_thu_sdd'];

export function computeOverview(ov: OverviewData, maDA: string, today: number = todayVnMs()): OverviewKpi {
  const duAn = ov.duAn.filter((d) => inProject(d, maDA));
  const pid = new Set(duAn.map((d) => str(d.ma_da)));
  const hd = ov.hopDong.filter((h) => pid.has(str(h.ma_da)));
  const nt = ov.nghiemThu.filter((n) => pid.has(str(n.ma_da)));

  const projects: ProjectKpi[] = duAn.map((d) => {
    const id = str(d.ma_da);
    const hds = hd.filter((h) => str(h.ma_da) === id);
    const nts = nt.filter((n) => str(n.ma_da) === id);
    const hdTong = hds.reduce((s, h) => s + toNum(h.gia_hd), 0);
    const luyKe = hds.reduce((s, h) => s + toNum(h.luy_ke_thanh_toan), 0);
    const ntPaid = nts.filter((n) => norm(n.trang_thai_hsnt) === 'da thanh toan').reduce((s, n) => s + toNum(n.gia_tri_nt), 0);

    // Vốn cấp: cột tong_von_cap nếu có; nếu không thì cộng các cột nguồn vốn; cuối cùng mới suy từ tổng giá hợp đồng.
    const vonCols = d.tong_von_cap != null && str(d.tong_von_cap) !== '' ? toNum(d.tong_von_cap) : FUND_COLS.reduce((s, c) => s + toNum(d[c]), 0);
    const vonCap = vonCols > 0 ? vonCols : hdTong;
    const giaiNgan = d.giai_ngan != null && str(d.giai_ngan) !== '' ? toNum(d.giai_ngan) : luyKe;
    const tmdt = toNum(d.tong_muc_dau_tu) > 0 ? toNum(d.tong_muc_dau_tu) : toNum(d.tmdt_tong_nhap);

    const bd = parseDateMs(d.ngay_bat_dau), kt = parseDateMs(d.ngay_ket_thuc);
    const tienDoTg = bd != null && kt != null && kt > bd ? Math.min(1, Math.max(0, (today - bd) / (kt - bd))) : null;
    const tyLeGn = vonCap > 0 ? giaiNgan / vonCap : null;
    return {
      ma_da: id, ten_da: str(d.ten_da), loai: str(d.loai_da) || '—',
      ptKyThuat: str(d.phu_trach_ky_thuat) || str(d.ten_pt_ky_thuat) || str(d.pt_ky_thuat), ptKeToan: str(d.phu_trach_ke_toan) || str(d.ten_pt_ke_toan) || str(d.pt_ke_toan),
      tmdt, vonCap, giaiNgan, tyLeGiaiNgan: tyLeGn, hdTong, luyKe, ntDaThanhToan: ntPaid, ntSoHoSo: nts.length,
      tienDoTg, tinhTrang: classifyProgress({ trangThai: str(d.trang_thai_da) || str(d.trang_thai_du_an), bd, kt, tienDoTg, tyLeGn }, today),
      batDau: str(d.ngay_bat_dau), ketThuc: str(d.ngay_ket_thuc),
    };
  });

  const alerts = missingAlerts(ov, pid);
  const sum = (f: (p: ProjectKpi) => number): number => projects.reduce((s, p) => s + f(p), 0);
  const count = (...t: TinhTrang[]): number => projects.filter((p) => t.includes(p.tinhTrang)).length;
  const vonCap = sum((p) => p.vonCap), giaiNgan = sum((p) => p.giaiNgan);
  const luyKe = sum((p) => p.luyKe), ntPaid = sum((p) => p.ntDaThanhToan);
  return {
    tong: projects.length,
    hoanThanh: count('Đã hoàn thành'),
    dangThucHien: count('Đúng tiến độ', 'Cần lưu ý', 'Chậm tiến độ', 'Quá hạn'),
    cham: count('Chậm tiến độ', 'Quá hạn'),
    quaHan: count('Quá hạn'),
    chuaKhoiCong: count('Chưa khởi công'),
    tmdt: sum((p) => p.tmdt), vonCap, giaiNgan, tyLeGiaiNgan: vonCap > 0 ? giaiNgan / vonCap : null,
    luyKe, ntDaThanhToan: ntPaid, chenhNghiemThu: Math.max(0, luyKe - ntPaid),
    projects, alerts,
  };
}

/** Phát hiện thiếu hồ sơ/số liệu — cùng tinh thần với bộ cảnh báo phân quyền: nghiệm thu → Kỹ thuật; hợp đồng/TMĐT/phụ lục → Kế toán. */
export function missingAlerts(ov: OverviewData, projectIds: Set<string>): MissingAlert[] {
  const out: MissingAlert[] = [];
  const tlAll = ov.taiLieu.filter((t) => projectIds.has(str(t.ma_da)));
  const gtByMa = new Map<string, GoiThauRow>(ov.goiThau.map((g) => [str(g.ma_gt), { ma_gt: str(g.ma_gt), loai_gt: str(g.loai_gt), ten_gt: str(g.ten_gt) }]));

  for (const id of projectIds) {
    const du = ov.duAn.find((d) => str(d.ma_da) === id);
    const ten = str(du?.ten_da) || id;
    const tls = tlAll.filter((t) => str(t.ma_da) === id).map((t) => ({
      tl: { id: str(t.ma_tl), ten_tl: str(t.ten_tl), loai: str(t.loai), ma_da: id, ma_gt: str(t.ma_gt) || null } as TaiLieuRow,
    }));
    const phased = tls.map(({ tl }) => ({ tl, phase: classifyPhase(tl, tl.ma_gt ? gtByMa.get(tl.ma_gt) : undefined).phase }));

    // Hồ sơ bắt buộc từng giai đoạn
    for (const rq of REQUIRED_DOCS) {
      if (!rq.batBuoc) continue;
      if (!phased.some((p) => p.phase === rq.phase && rq.re.test(norm(p.tl.ten_tl)))) {
        out.push({ key: `RQ|${id}|${rq.ten}`, ma_da: id, muc: 'TRUNG_BINH', nhom: 'KY_THUAT',
          text: `${ten}: thiếu “${rq.ten}” (${PHASES.find((p) => p.key === rq.phase)?.ten ?? rq.phase}).` });
      }
    }

    // Hợp đồng ↔ nghiệm thu / quyết toán
    for (const h of ov.hopDong.filter((x) => str(x.ma_da) === id)) {
      const maHd = str(h.ma_hd) || '(không có mã)';
      const luyKe = toNum(h.luy_ke_thanh_toan);
      const nts = ov.nghiemThu.filter((n) => str(n.ma_da) === id && str(n.ma_hd) === str(h.ma_hd));
      if (luyKe > 0 && nts.length === 0) {
        out.push({ key: `NT|${id}|${maHd}`, ma_da: id, muc: 'CAO', nhom: 'KY_THUAT',
          text: `${ten} – HĐ ${maHd}: đã thanh toán lũy kế ${Math.round(luyKe).toLocaleString('vi-VN')} đ nhưng chưa có hồ sơ nghiệm thu. Cán bộ kỹ thuật phụ trách cần bổ sung.` });
      }
      if (nts.some((n) => !str(n.ngay_nt))) {
        out.push({ key: `NTD|${id}|${maHd}`, ma_da: id, muc: 'THAP', nhom: 'KY_THUAT', text: `${ten} – HĐ ${maHd}: có hồ sơ nghiệm thu chưa ghi ngày nghiệm thu.` });
      }
      if (toNum(h.gia_quyet_toan) === 0 && luyKe > 0) {
        out.push({ key: `QT|${id}|${maHd}`, ma_da: id, muc: 'THAP', nhom: 'KE_TOAN', text: `${ten} – HĐ ${maHd}: chưa có giá quyết toán.` });
      }
    }

    // Phụ lục hợp đồng
    for (const pl of ov.phuLuc.filter((x) => str(x.ma_da) === id)) {
      const ma = str(pl.ma_plhd) || '(không có mã)';
      if (!ov.hopDong.some((h) => str(h.ma_da) === id && str(h.ma_hd) === str(pl.ma_hd))) {
        out.push({ key: `PLK|${id}|${ma}`, ma_da: id, muc: 'CAO', nhom: 'KE_TOAN', text: `${ten} – phụ lục ${ma}: không khớp hợp đồng nào của dự án.` });
      }
      if (toNum(pl.gia_tri) === 0) out.push({ key: `PLG|${id}|${ma}`, ma_da: id, muc: 'CAO', nhom: 'KE_TOAN', text: `${ten} – phụ lục ${ma}: thiếu giá trị.` });
      if (!str(pl.ngay_ky)) out.push({ key: `PLN|${id}|${ma}`, ma_da: id, muc: 'TRUNG_BINH', nhom: 'KE_TOAN', text: `${ten} – phụ lục ${ma}: thiếu ngày ký.` });
    }

    // Tổng mức đầu tư
    if (du && toNum(du.tong_muc_dau_tu) <= 0 && toNum(du.tmdt_tong_nhap) <= 0) {
      out.push({ key: `TM|${id}`, ma_da: id, muc: 'TRUNG_BINH', nhom: 'KE_TOAN', text: `${ten}: chưa có tổng mức đầu tư.` });
    }
  }
  const rank: Record<AlertLevel, number> = { CAO: 0, TRUNG_BINH: 1, THAP: 2 };
  return out.sort((a, b) => rank[a.muc] - rank[b.muc] || a.ma_da.localeCompare(b.ma_da));
}
