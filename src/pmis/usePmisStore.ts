/**
 * usePmisStore.ts — Zustand store trung tâm của PMIS Tân Phú.
 *
 * Nguyên tắc:
 *  - MỘT nguồn dữ liệu: file Google Sheets Master (PMIS_TANPHU_MASTER_DB) qua `/api/gas` (xem gasProxyCore.ts).
 *    Store chỉ giữ ảnh chụp "masterOverview" thô; mọi tab lọc theo `maDA` ở phía client nên đổi dự án/đổi tab
 *    không phát sinh yêu cầu mạng và cập nhật tức thì.
 *  - `maDA` ('' = tất cả dự án, hoặc đúng 7 chữ số) là khoá đồng bộ cho cả 6 tab.
 *  - Store không import module nặng (Gantt, Quyết toán, VGCA…); các tab được lazy-load ở MainPmisApp.
 *  - Quyền: vai trò do máy chủ quyết định (Giám đốc / Chuyên viên / Nhà thầu). Client chỉ ẩn/hiện giao diện;
 *    mọi kiểm tra quyền thật nằm trong Apps Script.
 */
import { create } from 'zustand';
import { createGasClient, GasClient, GasError, IdTokenProvider } from './gasClient';

export type Row = Record<string, unknown>;
export type Role = 'DIRECTOR' | 'SPECIALIST' | 'CONTRACTOR';
export type TabId = 'tong-quan' | 'giao-viec' | 'ho-so' | 'tien-do' | 'trinh-ky' | 'nha-thau';
export type Status = 'idle' | 'loading' | 'ready' | 'error';

export interface TabDef { id: TabId; label: string; hint: string; roles: Role[] }
export const TABS: readonly TabDef[] = [
  { id: 'tong-quan', label: 'Tổng quan & Điều hành', hint: 'KPI, giải ngân, cảnh báo thiếu hồ sơ', roles: ['DIRECTOR', 'SPECIALIST'] },
  { id: 'giao-viec', label: 'Giao nhiệm vụ & ICT', hint: 'Giao việc, hút văn bản đã ký từ ICT', roles: ['DIRECTOR', 'SPECIALIST'] },
  { id: 'ho-so', label: 'Hồ sơ công trình & Quyết toán', hint: '6 giai đoạn P1–P6, gói .ZIP TT 73/2026', roles: ['DIRECTOR', 'SPECIALIST'] },
  { id: 'tien-do', label: 'Tiến độ Gantt & EVM', hint: 'Gantt, SPI, báo cáo hiện trường', roles: ['DIRECTOR', 'SPECIALIST'] },
  { id: 'trinh-ky', label: 'Trình ký VGCA & Sổ công văn', hint: 'Ký token, nhật ký bất biến', roles: ['DIRECTOR', 'SPECIALIST'] },
  { id: 'nha-thau', label: 'Cổng Nhà thầu', hint: 'Nộp PDF ký số, phản hồi 2 chiều', roles: ['DIRECTOR', 'SPECIALIST', 'CONTRACTOR'] },
] as const;

export const MA_DA_RE = /^\d{7}$/;
export const isTabId = (v: unknown): v is TabId => TABS.some((t) => t.id === v);
export const tabsFor = (role: Role | undefined): TabDef[] => TABS.filter((t) => !role || t.roles.includes(role));

export interface Me { email: string; ho_ten: string; role: Role; ma_nv: string }

/** Ảnh chụp Master DB do action `masterOverview` trả về (khoá đã chuẩn hoá snake_case). */
export interface OverviewData {
  me: { ma_nv: string; ho_ten: string; email: string; role: 'DIRECTOR' | 'SPECIALIST' };
  generatedAt: string;
  duAn: Row[]; goiThau: Row[]; hopDong: Row[]; nghiemThu: Row[]; phuLuc: Row[]; taiLieu: Row[];
}

export interface PmisState {
  client: GasClient | null;
  auth: Status;
  authError: string;
  me: Me | null;

  maDA: string;
  tab: TabId;

  overview: OverviewData | null;
  overviewStatus: Status;
  overviewError: string;
  overviewAt: number;
  /** Tăng mỗi khi dữ liệu Master đổi (làm mới, ghi); các tab dùng làm refreshKey. */
  dataVersion: number;

  connect(getIdToken: IdTokenProvider, o?: { endpoint?: string; fetchFn?: typeof fetch }): Promise<void>;
  setMaDA(maDA: string): void;
  setTab(tab: TabId): void;
  refresh(o?: { force?: boolean }): Promise<void>;
  disconnect(): void;
}

let unsubClient: (() => void) | null = null;
const errCode = (e: unknown): string => (e instanceof GasError ? e.code : String((e as Error)?.message ?? e));

export const usePmisStore = create<PmisState>()((set, get) => ({
  client: null,
  auth: 'idle',
  authError: '',
  me: null,

  maDA: '',
  tab: 'tong-quan',

  overview: null,
  overviewStatus: 'idle',
  overviewError: '',
  overviewAt: 0,
  dataVersion: 0,

  async connect(getIdToken, o) {
    if (get().auth === 'loading') return;
    const client = createGasClient({ getIdToken, endpoint: o?.endpoint, fetchFn: o?.fetchFn });
    set({ client, auth: 'loading', authError: '', overviewStatus: 'loading' });

    const apply = (ov: OverviewData, fromNetwork: boolean): void => {
      client.setNamespace(ov.me.email); // từ giờ mới lưu sessionStorage, tách theo email
      set((s) => ({
        overview: ov, overviewStatus: 'ready', overviewError: '', overviewAt: Date.now(),
        me: { email: ov.me.email, ho_ten: ov.me.ho_ten, role: ov.me.role, ma_nv: ov.me.ma_nv },
        auth: 'ready', authError: '',
        dataVersion: s.overview && fromNetwork ? s.dataVersion + 1 : s.dataVersion,
        // maDA không còn quyền xem → quay về "tất cả"
        maDA: s.maDA && !ov.duAn.some((d) => String(d.ma_da) === s.maDA) ? '' : s.maDA,
      }));
    };

    try {
      const ov = await client.call<OverviewData>('masterOverview', {}, {
        onUpdate: (d) => apply(d, true),
        onError: (e) => set({ overviewError: errCode(e) }),
      });
      apply(ov, false);
      unsubClient?.();
      unsubClient = client.subscribe(() => { void get().refresh({ force: true }); });
    } catch (e) {
      const code = errCode(e);
      if (code === 'EMAIL_KHONG_CO_TRONG_NHANVIEN') {
        // Không phải nhân viên: thử vào Cổng nhà thầu (email phải trùng email_lien_he của một gói thầu).
        try {
          const pl = await client.call<{ me: { email: string; ho_ten: string } }>('portalList', {}, { swr: false });
          client.setNamespace(pl.me.email);
          set({ auth: 'ready', me: { email: pl.me.email, ho_ten: pl.me.ho_ten, role: 'CONTRACTOR', ma_nv: '' }, tab: 'nha-thau', overviewStatus: 'idle' });
          return;
        } catch (e2) {
          set({ auth: 'error', authError: errCode(e2), overviewStatus: 'error', overviewError: errCode(e2) });
          return;
        }
      }
      set({ auth: 'error', authError: code, overviewStatus: 'error', overviewError: code });
    }
  },

  setMaDA(maDA) {
    const v = maDA.trim();
    if (v !== '' && !MA_DA_RE.test(v)) return;
    if (v !== get().maDA) set({ maDA: v });
  },

  setTab(tab) {
    const role = get().me?.role;
    if (role && !tabsFor(role).some((t) => t.id === tab)) return;
    if (tab !== get().tab) set({ tab });
  },

  async refresh(o) {
    const { client } = get();
    if (!client || get().me?.role === 'CONTRACTOR') return;
    set({ overviewStatus: get().overview ? 'ready' : 'loading' });
    try {
      const ov = await client.call<OverviewData>('masterOverview', {}, { swr: !o?.force });
      if (get().client !== client) return; // đã ngắt/đổi phiên trong lúc chờ
      set((s) => ({ overview: ov, overviewStatus: 'ready', overviewError: '', overviewAt: Date.now(), dataVersion: s.dataVersion + 1 }));
    } catch (e) {
      if (get().client !== client) return;
      set({ overviewStatus: get().overview ? 'ready' : 'error', overviewError: errCode(e) });
    }
  },

  disconnect() {
    unsubClient?.(); unsubClient = null;
    const old = get().client;
    set({ client: null, auth: 'idle', me: null, overview: null, overviewStatus: 'idle', maDA: '', dataVersion: 0, tab: 'tong-quan', authError: '', overviewError: '' });
    old?.invalidate();
  },
}));

/* ───────────────────────── Đồng bộ URL (#/tab?maDA=…) ───────────────────────── */

export function parseHash(hash: string): { tab?: TabId; maDA?: string } {
  const m = /^#\/?([a-z-]*)(?:\?(.*))?$/.exec(hash);
  if (!m) return {};
  const out: { tab?: TabId; maDA?: string } = {};
  if (isTabId(m[1])) out.tab = m[1];
  const q = new URLSearchParams(m[2] ?? '').get('maDA');
  if (q !== null && (q === '' || MA_DA_RE.test(q))) out.maDA = q;
  return out;
}
export function formatHash(tab: TabId, maDA: string): string {
  return '#/' + tab + (maDA ? '?maDA=' + maDA : '');
}

/** Gắn 2 chiều store ↔ location.hash. Trả về hàm huỷ. Gọi 1 lần ở gốc ứng dụng. */
export function bindUrl(win: Window = window): () => void {
  const fromHash = (): void => {
    const p = parseHash(win.location.hash);
    const st = usePmisStore.getState();
    if (p.maDA !== undefined) st.setMaDA(p.maDA);
    if (p.tab) st.setTab(p.tab);
  };
  fromHash();
  const toHash = (): void => {
    const { tab, maDA } = usePmisStore.getState();
    const h = formatHash(tab, maDA);
    if (win.location.hash !== h) win.history.replaceState(null, '', h);
  };
  const unsub = usePmisStore.subscribe((s, prev) => { if (s.tab !== prev.tab || s.maDA !== prev.maDA) toHash(); });
  win.addEventListener('hashchange', fromHash);
  return () => { unsub(); win.removeEventListener('hashchange', fromHash); };
}

/* ───────────────────────── Tiện ích đọc dữ liệu ───────────────────────── */

export const str = (v: unknown): string => (v == null ? '' : String(v).trim());
export const toNum = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = str(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
export const inProject = (r: Row, maDA: string): boolean => maDA === '' || str(r.ma_da) === maDA;
