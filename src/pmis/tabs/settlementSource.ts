/**
 * settlementSource.ts — SettlementSource đọc từ ảnh chụp Master DB (Google Sheets) thay vì Supabase.
 * PDF: URL ICT → cầu nối ICT; URL Google Drive do hệ thống lưu → action `driveFile` qua /api/gas
 * (tải theo từng khúc 2 MiB nên không bị giới hạn ~3,2 MB của proxy; trần là MAX_FILE_MB ở Apps Script, mặc định 20 MB;
 * tệp vượt trần nằm trong "Tệp bị loại – không tải được" — dùng tuỳ chọn mở thư mục Drive).
 */
import type { GasClient } from '../gasClient';
import type { OverviewData, Row } from '../usePmisStore';
import { str, toNum } from '../usePmisStore';
import type { SettlementData, SettlementSource, TaiLieuRow, DuAnRow, HopDongRow } from '../SettlementZipExporter';
import { createPdfFetcher, createWindowIctBridge } from '../SettlementZipExporter';
import { fetchDriveFile } from './transfer';

const nOrNull = (v: unknown): number | null => (v == null || str(v) === '' ? null : toNum(v));
const DRIVE_RE = /drive\.google\.com\/file\/d\/([\w-]+)/;

const MONEY_DA = ['tong_muc_dau_tu', 'tmdt_bt_htdtc', 'tmdt_xay_dung', 'tmdt_thiet_bi', 'tmdt_qlda', 'tmdt_tv_khao_sat_lap_bc',
  'tmdt_tv_tham_tra', 'tmdt_tv_dau_thau', 'tmdt_tv_giam_sat', 'tmdt_tv_khac', 'tmdt_chi_phi_khac', 'tmdt_du_phong'] as const;

export function toSettlementData(ov: OverviewData, maDA: string): SettlementData {
  const du = ov.duAn.find((d) => str(d.ma_da) === maDA);
  if (!du) throw new Error(`Không tìm thấy dự án ${maDA}.`);
  const duAn: Record<string, unknown> = { ...du, ma_da: maDA, ten_da: str(du.ten_da), nguon_von: str(du.nguon_von) === 'tinh' ? 'tinh' : 'xa' };
  for (const k of MONEY_DA) duAn[k] = nOrNull(duAn[k]);
  // Sheet chỉ có tổng nhập tay (chưa điền 11 cấu phần) → dùng làm tổng mức đầu tư để mẫu không báo 0.
  if (!duAn.tong_muc_dau_tu && toNum(du.tmdt_tong_nhap) > 0) duAn.tong_muc_dau_tu = toNum(du.tmdt_tong_nhap);

  const mine = (r: Row): boolean => str(r.ma_da) === maDA;
  const taiLieu: TaiLieuRow[] = ov.taiLieu.filter(mine).map((t, i) => {
    const url = str(t.url);
    const drive = DRIVE_RE.exec(url);
    const st = str(t.trang_thai).toUpperCase();
    return {
      id: str(t.ma_tl) || `tl-${i}`, nguon: str(t.nguon), ma_tl: str(t.ma_tl), ten_tl: str(t.ten_tl), loai: str(t.loai), ma_da: maDA,
      ma_gt: str(t.ma_gt) || null, trang_thai: st === 'SUPERSEDED' ? 'SUPERSEDED' : st || 'SIGNED', sha256: str(t.sha256) || null,
      url_nguon: drive ? `storage://drive/${drive[1]}` : url || null, ngay_phat_hanh: str(t.ngay_phat_hanh) || null,
    };
  });

  return {
    duAn: duAn as unknown as DuAnRow,
    goiThau: ov.goiThau.filter(mine).map((g) => ({ ma_gt: str(g.ma_gt), loai_gt: str(g.loai_gt), ten_gt: str(g.ten_gt), gia_goi_thau: nOrNull(g.gia_goi_thau) })),
    hopDong: ov.hopDong.filter(mine).map((h, i): HopDongRow => ({
      id: i + 1, ma_hd: str(h.ma_hd), ma_gt: str(h.ma_gt) || null, ten_hd: str(h.ten_hd), loai_hd: str(h.loai_hd) || null, ngay_ky: str(h.ngay_ky) || null,
      gia_hd: nOrNull(h.gia_hd), gia_quyet_toan: nOrNull(h.gia_quyet_toan), luy_ke_thanh_toan: nOrNull(h.luy_ke_thanh_toan),
      nha_thau_ten: str(h.nha_thau_ten) || str(h.nha_thau_ten_goc),
    })),
    taiLieu,
    nghiemThu: ov.nghiemThu.filter(mine).map((n) => ({
      ma_hsnt: str(n.ma_hsnt), ma_hd: str(n.ma_hd), ma_da: maDA, ngay_de_nghi: str(n.ngay_de_nghi) || null, ngay_nt: str(n.ngay_nt) || null,
      gia_tri_nt: nOrNull(n.gia_tri_nt), trang_thai_hsnt: str(n.trang_thai_hsnt) || null,
    })),
    phuLuc: ov.phuLuc.filter(mine).map((p) => ({
      ma_plhd: str(p.ma_plhd), ma_hd: str(p.ma_hd), ma_da: maDA, noi_dung: str(p.noi_dung) || null, ngay_ky: str(p.ngay_ky) || null,
      gia_tri: nOrNull(p.gia_tri), ngay_ky_sau_30_9: str(p.ngay_ky_sau_30_9) || null,
    })),
    quyetToan: null, // Master DB chưa có tab "Quyết toán DAHT"; mẫu TT73 sẽ báo thiếu các trường đơn vị
  };
}

export interface SourceDeps { client: GasClient; getOverview: () => OverviewData | null; ict?: boolean }

export function createMasterSettlementSource(d: SourceDeps): SettlementSource {
  const fetcher = createPdfFetcher({
    ict: d.ict === false ? undefined : createWindowIctBridge(),
    storageDownload: async (bucket, path) => {
      if (bucket !== 'drive') return null;
      return fetchDriveFile(d.client, path);
    },
  });
  return {
    async listProjects() {
      const ov = d.getOverview();
      return (ov?.duAn ?? []).map((r) => ({ maDA: str(r.ma_da), tenDA: str(r.ten_da) })).sort((a, b) => a.maDA.localeCompare(b.maDA));
    },
    async load(maDA) {
      const ov = d.getOverview();
      if (!ov) throw new Error('Chưa tải dữ liệu Master DB.');
      return toSettlementData(ov, maDA);
    },
    fetchPdf: (t) => fetcher(t),
  };
}
