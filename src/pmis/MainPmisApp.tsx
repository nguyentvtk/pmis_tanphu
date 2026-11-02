/**
 * MainPmisApp.tsx — tầng điều phối trung tâm của PMIS Tân Phú.
 *
 *  - Kết nối DUY NHẤT 01 file Google Sheets Master (PMIS_TANPHU_MASTER_DB) qua proxy `/api/gas`
 *    (xác thực token một lần + cache SWR ở máy chủ; thêm SWR ở trình duyệt nên mở lại < 100 ms).
 *  - 6 tab đồng bộ tức thời theo `maDA` (chọn ở thanh trên, lưu trên URL: #/ho-so?maDA=8179901).
 *  - Mỗi tab là một chunk lazy-load, nạp trước khi rê chuột/focus vào tab; tab đã mở được giữ nguyên trạng thái
 *    (trừ Gantt vì có polling nền).
 *
 * Dùng:
 *   <MainPmisApp getIdToken={getGoogleIdToken} templateUrl="/templates/TT73_BCQT.xlsx" vgcaBaseUrl={process.env.NEXT_PUBLIC_VGCA_URL} />
 * Thư viện cần có: react, zustand, jszip, exceljs. Đặt app/api/gas/route.ts theo api-gas-route.ts.
 */
import React, { Component, ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { TABS, TabDef, TabId, bindUrl, tabsFor, usePmisStore, str } from './usePmisStore';
import type { Libs } from './SettlementZipExporter';

/* ───────────── Nạp lười từng tab (Vercel: tránh đưa Gantt/ExcelJS/VGCA vào gói đầu) ───────────── */
const loaders = {
  'tong-quan': () => import('./tabs/OverviewTab'),
  'giao-viec': () => import('./tabs/TasksIctTab'),
  'ho-so': () => import('./tabs/DossierTab'),
  'tien-do': () => import('./tabs/GanttTab'),
  'trinh-ky': () => import('./tabs/SignLedgerTab'),
  'nha-thau': () => import('./tabs/PortalTab'),
} as const;
const LazyOverview = lazy(loaders['tong-quan']);
const LazyTasks = lazy(loaders['giao-viec']);
const LazyDossier = lazy(loaders['ho-so']);
const LazyGantt = lazy(loaders['tien-do']);
const LazySign = lazy(loaders['trinh-ky']);
const LazyPortal = lazy(loaders['nha-thau']);

const defaultLoadLibs = async (): Promise<Libs> => {
  const [jz, ex] = await Promise.all([import('jszip'), import('exceljs')]);
  return { JSZip: (jz as { default?: unknown }).default ?? jz, ExcelJS: (ex as { default?: unknown }).default ?? ex };
};

export interface MainPmisAppProps {
  /** Trả Google ID token còn hạn (Google Sign-In). Được gọi trước mỗi yêu cầu. */
  getIdToken: () => Promise<string>;
  endpoint?: string;
  templateUrl?: string;
  loadLibs?: () => Promise<Libs>;
  /** Địa chỉ VGCA Web Signer trên máy người dùng. */
  vgcaBaseUrl?: string;
  onSignOut?: () => void;
}

const AUTH_ERR: Record<string, string> = {
  EMAIL_KHONG_CO_TRONG_NHANVIEN: 'Tài khoản Google này chưa có trong danh sách nhân viên hoặc nhà thầu.',
  EMAIL_KHONG_THUOC_NHA_THAU_NAO: 'Email này chưa gắn với nhân viên hay gói thầu nào. Liên hệ Ban QLDA để được cấp quyền.',
  ID_TOKEN_HET_HAN: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
  ID_TOKEN_KHONG_HOP_LE: 'Phiên đăng nhập không hợp lệ. Hãy đăng nhập lại.',
  THIEU_ID_TOKEN: 'Chưa đăng nhập Google.',
};
const friendly = (c: string): string => AUTH_ERR[c] ?? c;

/* ───────────── Error boundary cho từng panel ───────────── */
class PanelBoundary extends Component<{ children: ReactNode; label: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="pm-card" role="alert">
        <p className="pm-err">Không hiển thị được “{this.props.label}”: {this.state.err.message}</p>
        <button type="button" className="pm-btn" onClick={() => this.setState({ err: null })}>Thử lại</button>
      </div>
    );
  }
}

const Skeleton = ({ label }: { label: string }) => (
  <div className="pm-skel" role="status" aria-busy="true" aria-label={`Đang tải ${label}`}><i /><i /><i /></div>
);

/* ───────────── Giao diện dùng chung (tiền tố pm-, hỗ trợ sáng/tối) ───────────── */
const CSS = `
.pm-app{--pm-bg:#fff;--pm-fg:#1a2230;--pm-mut:#5f6b7a;--pm-card:#f7f9fb;--pm-bd:#d8dee6;--pm-ac:#1f5fbf;--pm-ac-fg:#fff;
 --pm-blue:#2a6fdb;--pm-teal:#128c7e;--pm-amber:#b97800;--pm-violet:#7c4dbd;--pm-orange:#d2581a;--pm-red:#c62828;--pm-green:#2e8b3d;--pm-grey:#7d8794;
 color-scheme:light dark;min-height:100dvh;background:var(--pm-bg);color:var(--pm-fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){.pm-app{--pm-bg:#12161c;--pm-fg:#e8ecf1;--pm-mut:#9aa6b4;--pm-card:#1a2028;--pm-bd:#2e3844;--pm-ac:#6ea8ff;--pm-ac-fg:#0b1118;
 --pm-blue:#6ea8ff;--pm-teal:#4fc3b3;--pm-amber:#e6b84a;--pm-violet:#b196e8;--pm-orange:#f0925a;--pm-red:#ef7f7f;--pm-green:#6fcf80;--pm-grey:#9aa3ae}}
.pm-app *{box-sizing:border-box}
.pm-skip{position:absolute;left:8px;top:-48px;background:var(--pm-ac);color:var(--pm-ac-fg);padding:8px 12px;border-radius:6px;z-index:10}
.pm-skip:focus{top:8px}
.pm-top{position:relative;z-index:5;background:var(--pm-bg);border-bottom:1px solid var(--pm-bd);padding:10px 16px}
.pm-bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;max-width:1280px;margin:0 auto}
.pm-bar h1{font-size:18px;margin:0;text-wrap:balance}
.pm-ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px}
.pm-ctl label.pm-inline{white-space:nowrap}.pm-ctl select{width:min(420px,60vw);min-width:0}
@media (min-width:561px){.pm-top{position:sticky;top:0}}
.pm-app select,.pm-app input:not([type=checkbox]):not([type=file]),.pm-app textarea{font:inherit;color:inherit;background:var(--pm-bg);border:1px solid var(--pm-bd);border-radius:6px;padding:8px 10px;min-height:40px;max-width:100%}
.pm-app textarea{width:100%}
.pm-app label{display:grid;gap:3px;font-size:13px;color:var(--pm-mut)}
.pm-app label.pm-check,.pm-app label.pm-inline{display:flex;align-items:center;gap:8px;color:var(--pm-fg)}
.pm-tabs{display:flex;gap:4px;overflow-x:auto;max-width:1280px;margin:8px auto 0;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
.pm-tab{flex:none;scroll-snap-align:start;min-height:44px;padding:8px 14px;border:1px solid transparent;border-bottom:3px solid transparent;background:transparent;color:var(--pm-mut);font:inherit;cursor:pointer;border-radius:6px 6px 0 0;touch-action:manipulation}
.pm-tab:hover{color:var(--pm-fg)}
.pm-tab[aria-selected=true]{color:var(--pm-fg);border-bottom-color:var(--pm-ac);font-weight:600}
.pm-tab small{display:block;font-weight:400;font-size:11px;color:var(--pm-mut)}
.pm-main{max-width:1280px;margin:0 auto;padding:16px}
.pm-app :focus-visible{outline:2px solid var(--pm-ac);outline-offset:2px}
.pm-stack{display:grid;gap:14px}.pm-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.pm-card{background:var(--pm-card);border:1px solid var(--pm-bd);border-radius:10px;padding:14px;min-width:0}
.pm-card h3{margin:0 0 8px;font-size:15px}.pm-card h3 small{font-weight:400;color:var(--pm-mut)}
.pm-row{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}
.pm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0}
.pm-kpi{background:var(--pm-card);border:1px solid var(--pm-bd);border-top:3px solid var(--k,var(--pm-bd));border-radius:8px;padding:10px 12px}
.pm-kpi dt{font-size:12px;color:var(--pm-mut)}.pm-kpi dd{margin:2px 0 0}.pm-kpi b{font-size:20px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.pm-kpi span{display:block;font-size:12px;color:var(--pm-mut)}
.pm-btn{font:inherit;min-height:40px;padding:8px 14px;border-radius:6px;border:1px solid var(--pm-ac);background:var(--pm-ac);color:var(--pm-ac-fg);cursor:pointer;touch-action:manipulation}
.pm-btn.pm-ghost{background:transparent;color:var(--pm-ac)}.pm-btn.pm-danger{background:var(--pm-red);border-color:var(--pm-red);color:#fff}
.pm-btn:disabled{opacity:.5;cursor:not-allowed}
.pm-link{font:inherit;background:none;border:0;padding:2px 0;color:var(--pm-ac);cursor:pointer;text-align:left;text-decoration:underline;text-underline-offset:2px}
.pm-badge{display:inline-block;padding:0 8px;border-radius:10px;border:1px solid var(--k,var(--pm-bd));color:var(--k,var(--pm-fg));font-size:12px;white-space:nowrap}
.pm-badge.pm-ghost{--k:var(--pm-bd);color:var(--pm-mut)}
.pm-note{color:var(--pm-mut);font-size:13px;margin:6px 0}.pm-err{color:var(--pm-red)}.pm-ok{color:var(--pm-green)}.pm-warn{color:var(--pm-amber)}
.pm-scroll{overflow-x:auto}.pm-table{border-collapse:collapse;width:100%;font-size:13px}
.pm-table th,.pm-table td{border-bottom:1px solid var(--pm-bd);padding:6px 8px;text-align:left;vertical-align:top}.pm-table .r{text-align:right;font-variant-numeric:tabular-nums}
.pm-table tr[aria-current=true]{background:color-mix(in srgb,var(--pm-ac) 10%,transparent)}.pm-badrow{background:color-mix(in srgb,var(--pm-red) 14%,transparent)}
.pm-bars{display:grid;grid-template-columns:minmax(0,200px) 1fr auto;gap:6px 10px;align-items:center;font-size:12px}
.pm-bars>span,.pm-bars>.pm-link{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-track{position:relative;height:10px;background:var(--pm-bd);border-radius:5px;overflow:hidden}.pm-track>div{height:100%;border-radius:5px}
.pm-track u{position:absolute;top:0;bottom:0;width:2px;background:var(--pm-fg);text-decoration:none}
.pm-donut{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.pm-legend{list-style:none;margin:0;padding:0;font-size:12px}
.pm-legend li{display:flex;gap:6px;align-items:center;margin:2px 0}.pm-legend i{width:10px;height:10px;border-radius:2px;flex:none}
.pm-alerts{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.pm-alerts li{border:1px solid var(--pm-bd);border-left:4px solid var(--pm-grey);border-radius:6px;padding:6px 10px;font-size:13px}
.pm-alerts li.lv-CAO{border-left-color:var(--pm-red)}.pm-alerts li.lv-TRUNG_BINH{border-left-color:var(--pm-amber)}
.pm-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;align-items:end}
.pm-form>.pm-actions,.pm-form>p,.pm-form>.pm-check{grid-column:1/-1}.pm-actions{display:flex;gap:8px;flex-wrap:wrap}
.pm-fieldset{border:1px solid var(--pm-line,#d0d7de);border-radius:8px;padding:10px 12px;margin:10px 0 0;min-inline-size:0}.pm-fieldset legend{padding:0 6px;font-weight:600}
.pm-links,.pm-list{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px}.pm-list label{overflow-wrap:anywhere}
progress{accent-color:var(--pm-accent,#1a5fb4)}
.pm-steps{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:10px 0}
.pm-steps li{padding:2px 10px;border:1px solid var(--pm-bd);border-radius:12px;font-size:12px;color:var(--pm-mut)}
.pm-steps li.now{border-color:var(--pm-ac);color:var(--pm-ac);font-weight:600}.pm-steps li.done{border-color:var(--pm-green);color:var(--pm-green)}
.pm-tree,.pm-tree ul{list-style:none;margin:0;padding-left:18px}.pm-tree{padding-left:0}.pm-tree summary{cursor:pointer;padding:4px 0}
.pm-miss{color:var(--pm-orange)}.pm-subs{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.pm-sub{border:1px solid var(--pm-bd);border-radius:8px;padding:10px;display:grid;gap:6px}
.pm-msgs{list-style:none;margin:0;padding:0;display:grid;gap:6px}.pm-msgs li{border-radius:8px;padding:6px 10px;background:var(--pm-bg);border:1px solid var(--pm-bd)}
.pm-msgs li.ban{border-left:4px solid var(--pm-ac)}.pm-msgs li.nt{border-left:4px solid var(--pm-teal)}
.pm-skel{display:grid;gap:12px}.pm-skel i{display:block;height:72px;border-radius:10px;background:var(--pm-card);border:1px solid var(--pm-bd);animation:pm-pulse 1.4s ease-in-out infinite}
@keyframes pm-pulse{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.pm-app *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (max-width:560px){.pm-main{padding:12px}.pm-top{padding:8px 12px}.pm-tab small{display:none}.pm-ctl select{width:100%}.pm-ctl label.pm-inline{width:100%}.pm-bars{grid-template-columns:minmax(0,110px) 1fr auto}}
`;

const hhmmss = (ms: number): string => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));

export default function MainPmisApp({
  getIdToken, endpoint = '/api/gas', templateUrl = '/templates/TT73_BCQT.xlsx', loadLibs = defaultLoadLibs, vgcaBaseUrl, onSignOut,
}: MainPmisAppProps) {
  // Chọn từng mảnh nhỏ của store để không re-render thừa.
  const { auth, authError, me, tab, maDA } = usePmisStore(useShallow((s) => ({ auth: s.auth, authError: s.authError, me: s.me, tab: s.tab, maDA: s.maDA })));
  const { connect, setTab, setMaDA, refresh } = usePmisStore(useShallow((s) => ({ connect: s.connect, setTab: s.setTab, setMaDA: s.setMaDA, refresh: s.refresh })));
  const duAn = usePmisStore((s) => s.overview?.duAn);
  const overviewAt = usePmisStore((s) => s.overviewAt);
  const overviewStatus = usePmisStore((s) => s.overviewStatus);
  const overviewError = usePmisStore((s) => s.overviewError);

  const tokenRef = useRef(getIdToken);
  tokenRef.current = getIdToken;
  const stableToken = useCallback(() => tokenRef.current(), []);

  useEffect(() => { void connect(stableToken, { endpoint }); }, [connect, stableToken, endpoint]);
  useEffect(() => bindUrl(), []);

  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([usePmisStore.getState().tab]));
  useEffect(() => { setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))); }, [tab]);

  const tabs = useMemo(() => tabsFor(me?.role), [me?.role]);
  const projects = useMemo(() => (duAn ?? []).map((d) => ({ id: str(d.ma_da), ten: str(d.ten_da) })).sort((a, b) => a.id.localeCompare(b.id)), [duAn]);
  const curTab: TabDef | undefined = TABS.find((t) => t.id === tab);

  useEffect(() => {
    const p = projects.find((x) => x.id === maDA);
    document.title = `${curTab?.label ?? 'PMIS'}${p ? ' · ' + p.ten : ''} — PMIS Tân Phú`;
  }, [curTab, maDA, projects]);

  /* Bàn phím cho tablist: ←/→/Home/End */
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.id === tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    setTab(tabs[n].id);
    document.getElementById(`pm-tab-${tabs[n].id}`)?.focus();
  };
  const prefetch = (id: TabId): void => { void loaders[id](); };

  const isContractor = me?.role === 'CONTRACTOR';

  if (auth === 'idle' || auth === 'loading') {
    return <div className="pm-app"><style>{CSS}</style><main className="pm-main"><Skeleton label="PMIS Tân Phú" /></main></div>;
  }
  if (auth === 'error' || !me) {
    return (
      <div className="pm-app"><style>{CSS}</style>
        <main className="pm-main" id="pm-main">
          <div className="pm-card" role="alert">
            <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>Không vào được hệ thống</h1>
            <p className="pm-err">{friendly(authError)}</p>
            <div className="pm-actions">
              <button type="button" className="pm-btn" onClick={() => void connect(stableToken, { endpoint })}>Thử lại</button>
              {onSignOut && <button type="button" className="pm-btn pm-ghost" onClick={onSignOut}>Đăng xuất</button>}
            </div>
          </div>
        </main>
      </div>
    );
  }

  const panel = (id: TabId): ReactNode => {
    switch (id) {
      case 'tong-quan': return <LazyOverview />;
      case 'giao-viec': return <LazyTasks getIdToken={stableToken} endpoint={endpoint} />;
      case 'ho-so': return <LazyDossier loadLibs={loadLibs} templateUrl={templateUrl} />;
      case 'tien-do': return <LazyGantt />;
      case 'trinh-ky': return <LazySign vgcaBaseUrl={vgcaBaseUrl} />;
      case 'nha-thau': return <LazyPortal />;
    }
  };

  return (
    <div className="pm-app">
      <style>{CSS}</style>
      <a className="pm-skip" href="#pm-main">Bỏ qua điều hướng</a>
      <header className="pm-top">
        <div className="pm-bar">
          <h1>PMIS Tân Phú <span className="pm-note">· Ban QLDA ĐTXD xã Tân Phú</span></h1>
          <div className="pm-ctl">
            {!isContractor && (
              <label className="pm-inline">Dự án
                <select value={maDA} onChange={(e) => setMaDA(e.target.value)} aria-label="Chọn dự án (đồng bộ cho cả 6 tab)">
                  <option value="">Tất cả dự án ({projects.length})</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.ten}</option>)}
                </select>
              </label>
            )}
            {!isContractor && (
              <button type="button" className="pm-btn pm-ghost" onClick={() => void refresh({ force: true })} disabled={overviewStatus === 'loading'}>
                {overviewStatus === 'loading' ? 'Đang làm mới…' : 'Làm mới'}
              </button>
            )}
            <span className="pm-note" aria-live="polite">
              {overviewError ? <span className="pm-err">Lỗi cập nhật: {friendly(overviewError)}</span> : overviewAt ? `Cập nhật ${hhmmss(overviewAt)}` : ''}
            </span>
            <span>{me.ho_ten} · {me.role === 'DIRECTOR' ? 'Giám đốc' : me.role === 'SPECIALIST' ? 'Chuyên viên' : 'Nhà thầu'}</span>
            {onSignOut && <button type="button" className="pm-btn pm-ghost" onClick={onSignOut}>Đăng xuất</button>}
          </div>
        </div>
        <div className="pm-tabs" role="tablist" aria-label="Phân hệ PMIS" onKeyDown={onTabKey}>
          {tabs.map((t, i) => (
            <button
              key={t.id} id={`pm-tab-${t.id}`} type="button" role="tab" className="pm-tab"
              aria-selected={t.id === tab} aria-controls={`pm-panel-${t.id}`} tabIndex={t.id === tab ? 0 : -1}
              onClick={() => setTab(t.id)} onPointerEnter={() => prefetch(t.id)} onFocus={() => prefetch(t.id)}
            >
              <span aria-hidden="true">{i + 1}. </span>{t.label}<small>{t.hint}</small>
            </button>
          ))}
        </div>
      </header>

      <main className="pm-main" id="pm-main">
        {tabs.filter((t) => visited.has(t.id) && (t.id !== 'tien-do' || t.id === tab)).map((t) => (
          <div key={t.id} role="tabpanel" id={`pm-panel-${t.id}`} aria-labelledby={`pm-tab-${t.id}`} hidden={t.id !== tab} tabIndex={0}>
            <PanelBoundary label={t.label}>
              <Suspense fallback={<Skeleton label={t.label} />}>{panel(t.id)}</Suspense>
            </PanelBoundary>
          </div>
        ))}
      </main>
    </div>
  );
}
