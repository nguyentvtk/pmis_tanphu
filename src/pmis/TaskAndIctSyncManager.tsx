'use client';
/**
 * TaskAndIctSyncManager.tsx - Phân hệ giao nhiệm vụ 1 cấp + lấy văn bản đã ký từ ICT Tây Ninh.
 *
 * Phụ thuộc: react >= 18 (Next.js App Router, 'use client'). Không dùng thư viện UI ngoài.
 * Dùng:
 *   <TaskAndIctSyncManager gasUrl={process.env.NEXT_PUBLIC_GAS_URL!} getIdToken={getGoogleIdToken} />
 * getIdToken trả về Google ID token (Google Identity Services) của người đang đăng nhập; máy chủ
 * (IctTayNinhBridge.gs) xác thực token, tra vai trò trong tab NhanVien rồi mới thực thi.
 * Vai trò trong giao diện chỉ để ẩn/hiện; mọi quyền được kiểm tra lại ở máy chủ.
 *
 * Lấy văn bản ICT cần userscript IctTayNinhBridge.user.js cài trong trình duyệt của người dùng
 * (tệp PDF đi từ ICT -> bộ nhớ trình duyệt -> Apps Script -> Drive, không ghi ra máy).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast, confirmDialog } from './ui/Feedback';

/* ============================== Kiểu dữ liệu ============================== */
export type Role = 'DIRECTOR' | 'SPECIALIST';
export type Stage = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
type AssignRole = 'CHU_TRI' | 'PHOI_HOP';
type AssignState = 'CHUA_TIEP_NHAN' | 'DANG_XU_LY' | 'DA_HOAN_THANH';
type TaskState = 'CHUA_TIEP_NHAN' | 'DANG_XU_LY' | 'CHO_XAC_NHAN' | 'HOAN_THANH';

interface Me { email: string; ma_nv: string; ho_ten: string; role: Role }
interface Staff { ma_nv: string; ho_ten: string; chuc_vu: string; email: string }
interface Project { ma_da: string; ten_da: string }
interface Assignment { task_id: string; ma_nv: string; vai_tro: AssignRole; trang_thai: AssignState; tien_do: number | string; ngay_tiep_nhan?: string; ngay_hoan_thanh?: string }
interface Task {
  task_id: string; ma_da: string; tieu_de: string; noi_dung_chi_dao: string; han_hoan_thanh: string;
  trong_tam: boolean; giai_doan: Stage | ''; van_ban_chi_dao: string; lien_ket_ict: boolean | string;
  trang_thai: TaskState; nguoi_giao: string; ngay_giao: string; phan_cong: Assignment[];
}
interface Report { report_id: string; task_id: string; ma_nv: string; phan_tram: number | string; noi_dung: string; bao_cao_cuoi: boolean | string; thoi_gian: string }
interface EsignDoc { doc_id: string; ma_da: string; giai_doan: string; so_ky_hieu: string; ten_file: string; view_url: string; sha256: string; task_id: string }
interface Kpi { kpi_id: string; task_id: string; ma_nv: string; vai_tro: string; diem: number | string; ly_do: string; ky_bao_cao: string }
interface Bootstrap { me: Me; staff: Staff[]; projects: Project[]; stages: Stage[]; tasks: Task[]; reports: Report[]; documents: EsignDoc[]; kpis: Kpi[] }

interface IctAttachment { id: string; name: string; url: string; hintSigned: boolean }
interface IctDoc { ictDocId: string; soKyHieu: string; trichYeu: string; ngay: string; direction: 'DI' | 'DEN'; attachments: IctAttachment[] }
interface IngestResult { duplicate: boolean; doc_id: string; view_url: string; sha256: string; ten_file?: string; task_status?: string | null }

const STAGES: Stage[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const SO_KY_HIEU_RE = /^\d{1,6}\/[\p{L}\p{N}\-]+(?:\/[\p{L}\p{N}\-]+)*$/u; // 255/QĐ-BQLDA, 1234/UBND
const MA_DA_RE = /^\d{7}$/;

const ERR: Record<string, string> = {
  CHUA_DANG_NHAP_ICT: 'Bạn chưa đăng nhập vbdh.tayninh.gov.vn trong trình duyệt này. Hãy đăng nhập rồi thử lại.',
  ICT_ENDPOINT_CHUA_CAU_HINH: 'Cầu nối ICT chưa được cấu hình đường dẫn API (xem hướng dẫn trong IctTayNinhBridge.user.js).',
  KHONG_THAY_CHU_KY_SO_TRONG_PDF: 'Tệp PDF không có chữ ký số. Chỉ nhận tệp đã ký số.',
  TEP_KHONG_PHAI_PDF: 'Tệp tải về không phải PDF (có thể phiên ICT đã hết hạn).',
  SHA256_KHONG_KHOP_TRONG_TRUYEN: 'Tệp bị thay đổi trong khi truyền (SHA-256 không khớp). Hãy thử lại.',
  KHONG_CO_NHIEM_VU_TRONG_DU_AN_NAY: 'Bạn không có nhiệm vụ nào thuộc dự án này.',
  CHI_GIAM_DOC_DUOC_PHEP: 'Chỉ Giám đốc được thực hiện thao tác này.',
  FILE_QUA_LON: 'Tệp vượt giới hạn dung lượng cho phép.',
};
const errText = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return ERR[m] ?? ERR[m.split(':')[0]] ?? m;
};
const truthy = (v: unknown) => v === true || String(v).toUpperCase() === 'TRUE';
const num = (v: unknown) => Number(v) || 0;
const today = () => new Date().toISOString().slice(0, 10);

/* ============================== Gọi Apps Script ============================== */
function createApi(gasUrl: string, getIdToken: () => Promise<string>) {
  return async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const idToken = await getIdToken();
    // text/plain tránh preflight CORS mà Apps Script không hỗ trợ
    const res = await fetch(gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, idToken, payload }) });
    if (!res.ok) throw new Error('MAY_CHU_HTTP_' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'LOI_KHONG_XAC_DINH');
    return j.data as T;
  };
}
type Api = ReturnType<typeof createApi>;

/* ============================== Cầu nối ICT (userscript) ============================== */
type BridgeState = 'checking' | 'missing' | 'unconfigured' | 'ready';
function useIctBridge() {
  const [state, setState] = useState<BridgeState>('checking');
  const pending = useRef(new Map<string, { res: (v: any) => void; rej: (e: Error) => void; t: ReturnType<typeof setTimeout> }>());

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window || ev.origin !== window.location.origin) return;
      const m = ev.data;
      if (!m || m.source !== 'PMIS_ICT_BRIDGE') return;
      const p = pending.current.get(m.id);
      if (!p) return;
      clearTimeout(p.t); pending.current.delete(m.id);
      m.ok ? p.res(m.data) : p.rej(new Error(m.error));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const send = useCallback(<T,>(type: string, payload?: unknown, timeoutMs = 90000) =>
    new Promise<T>((res, rej) => {
      const id = crypto.randomUUID();
      const t = setTimeout(() => { pending.current.delete(id); rej(new Error(type === 'PING' ? 'KHONG_CO_CAU_NOI' : 'CAU_NOI_QUA_THOI_GIAN')); }, timeoutMs);
      pending.current.set(id, { res, rej, t });
      window.postMessage({ source: 'PMIS_APP', id, type, payload }, window.location.origin);
    }), []);

  useEffect(() => {
    send<{ configured: boolean }>('PING', undefined, 1500)
      .then((r) => setState(r.configured ? 'ready' : 'unconfigured'))
      .catch(() => setState('missing'));
  }, [send]);

  return { state, send };
}

const bufToBase64 = (buf: ArrayBuffer) => {
  const u8 = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};

/* ============================== Ô "Liên kết & tự động lấy văn bản đã ký từ ICT" ============================== */
export interface IctLinkValue { enabled: boolean; soKyHieu: string }
export interface IctLinkFieldProps {
  value: IctLinkValue;
  onChange: (v: IctLinkValue) => void;
  maDA: string;            // cần đủ 7 chữ số để lưu vào thư mục dự án
  giaiDoan: Stage | '';    // P1..P6: thư mục đích
  taskId?: string;         // nếu có: gắn văn bản vào nhiệm vụ
  huong?: 'DI' | 'DEN';
  api: Api;
  onIngested?: (r: IngestResult) => void;
}

export function IctLinkField({ value, onChange, maDA, giaiDoan, taskId, huong = 'DI', api, onIngested }: IctLinkFieldProps) {
  const bridge = useIctBridge();
  const [dir, setDir] = useState<'DI' | 'DEN'>(huong);
  const [docs, setDocs] = useState<IctDoc[]>([]);
  const [pick, setPick] = useState<{ doc: IctDoc; att: IctAttachment } | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);

  const soOk = SO_KY_HIEU_RE.test(value.soKyHieu.trim());
  const canStore = MA_DA_RE.test(maDA) && !!giaiDoan;
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ kind: 'err', text: errText(e) }); } finally { setBusy(''); }
  };

  const search = () => run('Đang tìm trên ICT…', async () => {
    const r = await bridge.send<IctDoc[]>('SEARCH', { soKyHieu: value.soKyHieu.trim(), direction: dir });
    setDocs(r); setPick(null); setResult(null);
    setMsg(r.length ? { kind: 'info', text: `Tìm thấy ${r.length} văn bản. Chọn tệp đính kèm cần lấy.` } : { kind: 'err', text: 'Không thấy văn bản trùng khớp số/ký hiệu này ở mục đã chọn.' });
  });
  const listRecent = () => run('Đang tải danh sách…', async () => {
    const r = await bridge.send<IctDoc[]>('LIST_RECENT', { direction: dir, limit: 30 });
    setDocs(r); setPick(null); setResult(null);
  });
  const ingest = () => run('Đang lấy tệp từ ICT…', async () => {
    if (!pick) return;
    const f = await bridge.send<{ buffer: ArrayBuffer; sha256: string; size: number; sigPresent: boolean }>('FETCH_FILE', { url: pick.att.url });
    if (!f.sigPresent) throw new Error('KHONG_THAY_CHU_KY_SO_TRONG_PDF');
    setBusy('Đang lưu vào Drive…');
    const r = await api<IngestResult>('ingestIct', {
      ma_da: maDA, giai_doan: giaiDoan, so_ky_hieu: pick.doc.soKyHieu, huong: pick.doc.direction, ict_doc_id: pick.doc.ictDocId,
      ten_file: pick.att.name, sha256: f.sha256, co_chu_ky_so: f.sigPresent, base64: bufToBase64(f.buffer), task_id: taskId ?? '',
    });
    setResult(r); onIngested?.(r);
    setMsg({ kind: 'ok', text: r.duplicate ? 'Tệp này đã có trong hồ sơ dự án (trùng SHA-256), không lưu lại.' : 'Đã lưu vào Drive và ghi sổ văn bản ký số.' });
  });

  return (
    <fieldset className="tim-ict">
      <legend>ICT Tây Ninh</legend>
      <label className="tim-check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        <span>Liên kết &amp; tự động lấy văn bản đã ký từ ICT Tây Ninh</span>
      </label>

      {value.enabled && (
        <div className="tim-ict-body">
          {bridge.state === 'missing' && <p className="tim-note tim-warn">Chưa phát hiện cầu nối ICT trong trình duyệt. Cài userscript <code>IctTayNinhBridge.user.js</code>, đăng nhập vbdh.tayninh.gov.vn rồi tải lại trang.</p>}
          {bridge.state === 'unconfigured' && <p className="tim-note tim-warn">Cầu nối đã cài nhưng chưa cấu hình đường dẫn API ICT.</p>}
          <div className="tim-row">
            <label className="tim-grow">Số/Ký hiệu văn bản
              <input value={value.soKyHieu} placeholder="255/QĐ-BQLDA hoặc 1234/UBND" onChange={(e) => onChange({ ...value, soKyHieu: e.target.value })} aria-invalid={!!value.soKyHieu && !soOk} />
            </label>
            <label>Mục
              <select value={dir} onChange={(e) => setDir(e.target.value as 'DI' | 'DEN')}>
                <option value="DI">Văn bản đi - Đã phát hành</option>
                <option value="DEN">Văn bản đến</option>
              </select>
            </label>
          </div>
          {value.soKyHieu && !soOk && <p className="tim-note tim-warn">Định dạng chưa đúng (ví dụ 255/QĐ-BQLDA).</p>}
          <div className="tim-row">
            <button type="button" disabled={!soOk || bridge.state !== 'ready' || !!busy} onClick={search}>Tìm trên ICT</button>
            <button type="button" className="tim-ghost" disabled={bridge.state !== 'ready' || !!busy} onClick={listRecent}>Chọn từ danh sách văn bản đơn vị</button>
          </div>

          {docs.length > 0 && (
            <ul className="tim-list" aria-label="Kết quả từ ICT">
              {docs.map((d) => (
                <li key={d.direction + d.ictDocId}>
                  <strong>{d.soKyHieu}</strong> <span className="tim-muted">{d.ngay}</span>
                  <div className="tim-muted">{d.trichYeu}</div>
                  {d.attachments.length === 0 && <div className="tim-muted">Không có tệp đính kèm.</div>}
                  {d.attachments.map((a) => (
                    <label key={a.id} className="tim-check">
                      <input type="radio" name="ict-att" checked={pick?.att.id === a.id && pick.doc.ictDocId === d.ictDocId} onChange={() => { setPick({ doc: d, att: a }); if (!value.soKyHieu) onChange({ ...value, soKyHieu: d.soKyHieu }); }} />
                      <span>{a.name}{a.hintSigned && <em className="tim-badge"> đã ký</em>}</span>
                    </label>
                  ))}
                </li>
              ))}
            </ul>
          )}

          {pick && (
            <div className="tim-row">
              <button type="button" disabled={!canStore || !!busy} onClick={ingest}>Lấy về &amp; lưu vào {giaiDoan || 'P?'} của dự án {maDA || '…'}</button>
              {!canStore && <span className="tim-note tim-warn">Chọn mã dự án (7 chữ số) và giai đoạn P1–P6 trước.</span>}
            </div>
          )}
          {busy && <p className="tim-note" role="status">{busy}</p>}
          {msg && <p className={`tim-note ${msg.kind === 'err' ? 'tim-warn' : ''}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</p>}
          {result && <p className="tim-note"><a href={result.view_url} target="_blank" rel="noreferrer">Mở tệp trên Drive</a> · SHA-256 <code>{result.sha256.slice(0, 16)}…</code>{result.task_status === 'CHO_XAC_NHAN' && ' · Nhiệm vụ chuyển sang Chờ Giám đốc xác nhận.'}</p>}
          <p className="tim-muted tim-small">Hệ thống chỉ kiểm tra tệp <em>có</em> chữ ký số, chưa xác minh hiệu lực chữ ký.</p>
        </div>
      )}
    </fieldset>
  );
}

/* ============================== Giám đốc: form giao nhiệm vụ ============================== */
function TaskForm({ data, api, onCreated, defaultMaDA }: { data: Bootstrap; api: Api; onCreated: () => void; defaultMaDA?: string }) {
  const specialists = useMemo(() => data.staff.filter((s) => !/giám đốc/i.test(s.chuc_vu)), [data.staff]);
  const [f, setF] = useState({ ma_da: defaultMaDA ?? '', van_ban_chi_dao: '', tieu_de: '', noi_dung_chi_dao: '', han_hoan_thanh: '', trong_tam: false, giai_doan: '' as Stage | '', chu_tri: '', phoi_hop: [] as string[] });
  const [ict, setIct] = useState<IctLinkValue>({ enabled: false, soKyHieu: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  useEffect(() => { if (defaultMaDA !== undefined) setF((p) => ({ ...p, ma_da: defaultMaDA })); }, [defaultMaDA]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!f.ma_da && !f.van_ban_chi_dao.trim() && !(ict.enabled && ict.soKyHieu)) return setErr('Chọn mã dự án hoặc nhập văn bản chỉ đạo của cấp trên.');
    if (!f.chu_tri) return setErr('Phải chọn đúng 1 Chuyên viên Chủ trì.');
    if (!f.noi_dung_chi_dao.trim()) return setErr('Nhập nội dung chỉ đạo.');
    if (!f.han_hoan_thanh) return setErr('Chọn thời hạn hoàn thành.');
    if (ict.enabled && ict.soKyHieu && !SO_KY_HIEU_RE.test(ict.soKyHieu.trim())) return setErr('Số/Ký hiệu văn bản ICT chưa đúng định dạng.');
    setBusy(true);
    try {
      await api('createTask', { ...f, van_ban_chi_dao: f.van_ban_chi_dao.trim() || (ict.enabled ? ict.soKyHieu.trim() : ''), lien_ket_ict: ict.enabled });
      setF({ ...f, ma_da: defaultMaDA ?? '', van_ban_chi_dao: '', tieu_de: '', noi_dung_chi_dao: '', han_hoan_thanh: '', trong_tam: false, giai_doan: '', chu_tri: '', phoi_hop: [] });
      setIct({ enabled: false, soKyHieu: '' }); onCreated();
      toast('Đã giao nhiệm vụ.', 'ok');
    } catch (x) { setErr(errText(x)); toast('Giao nhiệm vụ thất bại.', 'err'); } finally { setBusy(false); }
  };

  return (
    <form className="tim-card" onSubmit={submit} noValidate>
      <h3>Giao nhiệm vụ mới</h3>
      <div className="tim-grid">
        <label>Dự án (maDA)
          <select value={f.ma_da} onChange={(e) => set('ma_da', e.target.value)}>
            <option value="">— Không gắn dự án —</option>
            {data.projects.map((p) => <option key={p.ma_da} value={p.ma_da}>{p.ma_da} · {p.ten_da}</option>)}
          </select>
        </label>
        <label>Văn bản chỉ đạo cấp trên (số/ký hiệu)
          <input value={f.van_ban_chi_dao} onChange={(e) => set('van_ban_chi_dao', e.target.value)} placeholder="1234/UBND" />
        </label>
        <label>Giai đoạn hồ sơ
          <select value={f.giai_doan} onChange={(e) => set('giai_doan', e.target.value as Stage | '')}>
            <option value="">—</option>{STAGES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>Thời hạn hoàn thành
          <input type="date" min={today()} value={f.han_hoan_thanh} onChange={(e) => set('han_hoan_thanh', e.target.value)} />
        </label>
      </div>
      <label>Tiêu đề ngắn <input value={f.tieu_de} maxLength={200} onChange={(e) => set('tieu_de', e.target.value)} /></label>
      <label>Nội dung chỉ đạo <textarea rows={4} value={f.noi_dung_chi_dao} onChange={(e) => set('noi_dung_chi_dao', e.target.value)} /></label>
      <label className="tim-check"><input type="checkbox" checked={f.trong_tam} onChange={(e) => set('trong_tam', e.target.checked)} /><span>Nhiệm vụ trọng tâm</span></label>

      <div className="tim-grid">
        <label>Chuyên viên Chủ trì (bắt buộc)
          <select value={f.chu_tri} onChange={(e) => setF((p) => ({ ...p, chu_tri: e.target.value, phoi_hop: p.phoi_hop.filter((x) => x !== e.target.value) }))}>
            <option value="">— Chọn —</option>
            {specialists.map((s) => <option key={s.ma_nv} value={s.ma_nv}>{s.ho_ten}</option>)}
          </select>
        </label>
        <fieldset className="tim-plain"><legend>Chuyên viên Phối hợp (tùy chọn)</legend>
          {specialists.filter((s) => s.ma_nv !== f.chu_tri).map((s) => (
            <label key={s.ma_nv} className="tim-check">
              <input type="checkbox" checked={f.phoi_hop.includes(s.ma_nv)} onChange={(e) => set('phoi_hop', e.target.checked ? [...f.phoi_hop, s.ma_nv] : f.phoi_hop.filter((x) => x !== s.ma_nv))} /><span>{s.ho_ten}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <IctLinkField value={ict} onChange={setIct} maDA={f.ma_da} giaiDoan={f.giai_doan} api={api} />
      {err && <p className="tim-note tim-warn" role="alert">{err}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Đang giao…' : 'Giao nhiệm vụ'}</button>
    </form>
  );
}

/* ============================== Thẻ nhiệm vụ & báo cáo tiến độ ============================== */
const STATE_LABEL: Record<TaskState, string> = { CHUA_TIEP_NHAN: 'Chưa tiếp nhận', DANG_XU_LY: 'Đang xử lý', CHO_XAC_NHAN: 'Chờ Giám đốc xác nhận', HOAN_THANH: 'Hoàn thành' };
const staffName = (d: Bootstrap, id: string) => d.staff.find((s) => s.ma_nv === id)?.ho_ten ?? id;
const projName = (d: Bootstrap, id: string) => d.projects.find((p) => p.ma_da === id)?.ten_da ?? '';

function ProgressForm({ task, current, api, onDone }: { task: Task; current: number; api: Api; onDone: () => void }) {
  const [pct, setPct] = useState(current); const [text, setText] = useState(''); const [fin, setFin] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (pct < current) return setErr('Tiến độ không được thấp hơn lần báo cáo trước.');
    if (!text.trim()) return setErr('Nhập nội dung báo cáo.');
    if (fin && !(await confirmDialog({ title: 'Gửi báo cáo cuối?', message: 'Báo cáo cuối sẽ KHÔNG sửa được sau khi gửi và đánh dấu nhiệm vụ hoàn thành.', confirmLabel: 'Gửi báo cáo cuối', danger: true }))) return;
    setBusy(true);
    try { await api('addProgress', { task_id: task.task_id, phan_tram: fin ? 100 : pct, noi_dung: text.trim(), bao_cao_cuoi: fin }); toast(fin ? 'Đã gửi báo cáo cuối.' : 'Đã gửi báo cáo tiến độ.', 'ok'); onDone(); }
    catch (x) { setErr(errText(x)); toast('Gửi báo cáo thất bại.', 'err'); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="tim-sub" noValidate>
      <label>Tiến độ: <strong>{fin ? 100 : pct}%</strong>
        <input type="range" min={current} max={100} value={fin ? 100 : pct} disabled={fin} onChange={(e) => setPct(Number(e.target.value))} />
      </label>
      <label>Nội dung báo cáo <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <label className="tim-check"><input type="checkbox" checked={fin} onChange={(e) => setFin(e.target.checked)} /><span>Hoàn thành nhiệm vụ (báo cáo cuối, không sửa được sau khi gửi)</span></label>
      {err && <p className="tim-note tim-warn" role="alert">{err}</p>}
      <button type="submit" disabled={busy}>{fin ? 'Gửi báo cáo cuối' : 'Gửi báo cáo tiến độ'}</button>
    </form>
  );
}

function TaskCard({ task, data, api, reload, myAssign }: { task: Task; data: Bootstrap; api: Api; reload: () => void; myAssign?: Assignment }) {
  const [open, setOpen] = useState(false); const [err, setErr] = useState(''); const [ictV, setIctV] = useState<IctLinkValue>({ enabled: truthy(task.lien_ket_ict), soKyHieu: '' });
  const isDir = data.me.role === 'DIRECTOR';
  const reports = data.reports.filter((r) => r.task_id === task.task_id);
  const docs = data.documents.filter((d) => d.task_id === task.task_id);
  const overdue = task.trang_thai !== 'HOAN_THANH' && task.han_hoan_thanh < today();
  const act = async (name: string, p: Record<string, unknown>) => { setErr(''); try { await api(name, p); reload(); } catch (x) { setErr(errText(x)); } };
  const mineDone = myAssign?.trang_thai === 'DA_HOAN_THANH';
  const pending = task.phan_cong.filter((a) => a.vai_tro === 'PHOI_HOP' && a.trang_thai !== 'DA_HOAN_THANH');

  return (
    <article className="tim-card">
      <header className="tim-head">
        <div>
          <strong>{task.tieu_de || task.noi_dung_chi_dao.slice(0, 80)}</strong>
          <div className="tim-muted">{task.ma_da ? `${task.ma_da} · ${projName(data, task.ma_da)}` : `VB chỉ đạo ${task.van_ban_chi_dao}`}{task.giai_doan && ` · ${task.giai_doan}`}</div>
        </div>
        <div className="tim-badges">
          {truthy(task.trong_tam) && <span className="tim-badge tim-star">Trọng tâm</span>}
          <span className="tim-badge">{STATE_LABEL[task.trang_thai]}</span>
          {myAssign && <span className="tim-badge">{myAssign.vai_tro === 'CHU_TRI' ? 'Chủ trì' : 'Phối hợp'}</span>}
          <span className={`tim-badge ${overdue ? 'tim-late' : ''}`}>Hạn {task.han_hoan_thanh}{overdue && ' · quá hạn'}</span>
        </div>
      </header>
      <p>{task.noi_dung_chi_dao}</p>
      <p className="tim-muted tim-small">
        {task.phan_cong.map((a) => `${staffName(data, a.ma_nv)} (${a.vai_tro === 'CHU_TRI' ? 'chủ trì' : 'phối hợp'}, ${num(a.tien_do)}%)`).join(' · ')}
      </p>
      {docs.length > 0 && <ul className="tim-list">{docs.map((d) => <li key={d.doc_id}><a href={d.view_url} target="_blank" rel="noreferrer">{d.so_ky_hieu}</a> · {d.giai_doan} · <code>{d.sha256.slice(0, 12)}…</code></li>)}</ul>}

      <div className="tim-row">
        {myAssign?.trang_thai === 'CHUA_TIEP_NHAN' && <button onClick={() => act('receiveTask', { task_id: task.task_id })}>Tiếp nhận</button>}
        {myAssign && myAssign.trang_thai === 'DANG_XU_LY' && task.trang_thai !== 'HOAN_THANH' && <button onClick={() => setOpen(!open)}>{open ? 'Đóng' : 'Báo cáo tiến độ'}</button>}
        {isDir && task.trang_thai === 'CHO_XAC_NHAN' && (
          <button onClick={async () => { if (pending.length === 0 || await confirmDialog({ title: 'Xác nhận hoàn thành nhiệm vụ?', message: `Còn ${pending.length} người phối hợp chưa báo cáo cuối (không được tính điểm). Vẫn xác nhận hoàn thành?`, confirmLabel: 'Xác nhận hoàn thành', danger: true })) act('confirmTask', { task_id: task.task_id }); }}>Xác nhận hoàn thành</button>
        )}
        {task.ma_da && task.giai_doan && task.trang_thai !== 'HOAN_THANH' && (isDir || (myAssign && !mineDone)) && (
          <button className="tim-ghost" onClick={() => setIctV({ ...ictV, enabled: !ictV.enabled })}>Văn bản ICT</button>
        )}
      </div>
      {open && myAssign && <ProgressForm task={task} current={num(myAssign.tien_do)} api={api} onDone={() => { setOpen(false); reload(); }} />}
      {ictV.enabled && task.ma_da && task.giai_doan && <IctLinkField value={ictV} onChange={setIctV} maDA={task.ma_da} giaiDoan={task.giai_doan} taskId={task.task_id} api={api} onIngested={reload} />}
      {reports.length > 0 && (
        <details><summary>Lịch sử báo cáo ({reports.length})</summary>
          <ul className="tim-list">{reports.map((r) => <li key={r.report_id}><strong>{num(r.phan_tram)}%</strong> · {staffName(data, r.ma_nv)} · {String(r.thoi_gian).slice(0, 16).replace('T', ' ')}{truthy(r.bao_cao_cuoi) && ' · báo cáo cuối'}<div>{r.noi_dung}</div></li>)}</ul>
        </details>
      )}
      {err && <p className="tim-note tim-warn" role="alert">{err}</p>}
    </article>
  );
}

/* ============================== Màn hình theo vai trò ============================== */
type SpecTab = 'CHUA_TIEP_NHAN' | 'CHU_TRI' | 'PHOI_HOP' | 'HOAN_THANH';
function SpecialistView({ data, api, reload }: { data: Bootstrap; api: Api; reload: () => void }) {
  const [tab, setTab] = useState<SpecTab>('CHUA_TIEP_NHAN');
  const mine = data.tasks.map((t) => ({ t, a: t.phan_cong.find((x) => x.ma_nv === data.me.ma_nv) })).filter((x): x is { t: Task; a: Assignment } => !!x.a);
  const bucket = (x: { t: Task; a: Assignment }): SpecTab =>
    x.a.trang_thai === 'CHUA_TIEP_NHAN' ? 'CHUA_TIEP_NHAN'
      : x.a.trang_thai === 'DA_HOAN_THANH' || x.t.trang_thai === 'HOAN_THANH' ? 'HOAN_THANH'
      : x.a.vai_tro === 'CHU_TRI' ? 'CHU_TRI' : 'PHOI_HOP';
  const tabs: [SpecTab, string][] = [['CHUA_TIEP_NHAN', 'Chưa tiếp nhận'], ['CHU_TRI', 'Đang xử lý (Chủ trì)'], ['PHOI_HOP', 'Đang xử lý (Phối hợp)'], ['HOAN_THANH', 'Hoàn thành']];
  const list = mine.filter((x) => bucket(x) === tab).sort((a, b) => a.t.han_hoan_thanh.localeCompare(b.t.han_hoan_thanh));
  const myKpi = data.kpis.filter((k) => k.ma_nv === data.me.ma_nv).reduce((s, k) => s + num(k.diem), 0);
  return (
    <section>
      <h2>Nhiệm vụ cá nhân <span className="tim-muted tim-small">· Điểm KPI tích lũy: {Math.round(myKpi * 100) / 100}</span></h2>
      <div role="tablist" className="tim-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tim-on' : ''} onClick={() => setTab(k)}>
            {label} ({mine.filter((x) => bucket(x) === k).length})
          </button>
        ))}
      </div>
      {list.length === 0 ? <p className="tim-muted">Không có nhiệm vụ.</p> : list.map(({ t, a }) => <TaskCard key={t.task_id} task={t} data={data} api={api} reload={reload} myAssign={a} />)}
    </section>
  );
}

function DirectorView({ data, api, reload, defaultMaDA }: { data: Bootstrap; api: Api; reload: () => void; defaultMaDA?: string }) {
  const [filter, setFilter] = useState<TaskState | 'ALL'>('CHO_XAC_NHAN');
  const list = data.tasks.filter((t) => filter === 'ALL' || t.trang_thai === filter).sort((a, b) => a.han_hoan_thanh.localeCompare(b.han_hoan_thanh));
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    data.kpis.forEach((k) => m.set(k.ma_nv, (m.get(k.ma_nv) ?? 0) + num(k.diem)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data.kpis]);
  return (
    <>
      <TaskForm data={data} api={api} onCreated={reload} defaultMaDA={defaultMaDA} />
      <section>
        <h2>Theo dõi nhiệm vụ</h2>
        <div className="tim-row">
          <label>Lọc trạng thái
            <select value={filter} onChange={(e) => setFilter(e.target.value as TaskState | 'ALL')}>
              <option value="ALL">Tất cả</option>
              {(Object.keys(STATE_LABEL) as TaskState[]).map((k) => <option key={k} value={k}>{STATE_LABEL[k]}</option>)}
            </select>
          </label>
        </div>
        {list.length === 0 ? <p className="tim-muted">Không có nhiệm vụ ở trạng thái này.</p> : list.map((t) => <TaskCard key={t.task_id} task={t} data={data} api={api} reload={reload} />)}
      </section>
      <section>
        <h2>Điểm KPI tích lũy</h2>
        {totals.length === 0 ? <p className="tim-muted">Chưa có điểm.</p> : <ul className="tim-list">{totals.map(([id, pts]) => <li key={id}>{staffName(data, id)}: <strong>{Math.round(pts * 100) / 100}</strong></li>)}</ul>}
      </section>
    </>
  );
}

/* ============================== Thành phần chính ============================== */
export interface TaskAndIctSyncManagerProps {
  gasUrl: string;
  getIdToken: () => Promise<string>;
  /** Chỉ hiển thị nhiệm vụ của dự án này (7 chữ số) và mặc định chọn dự án này khi giao việc. Bỏ trống = tất cả. */
  maDA?: string;
  /** Gọi sau mỗi thao tác ghi thành công (giao việc, tiếp nhận, báo cáo, xác nhận, lấy văn bản ICT). */
  onChanged?: () => void;
}

export default function TaskAndIctSyncManager({ gasUrl, getIdToken, maDA, onChanged }: TaskAndIctSyncManagerProps) {
  const api = useMemo(() => createApi(gasUrl, getIdToken), [gasUrl, getIdToken]);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await api<Bootstrap>('bootstrap')); } catch (e) { setError(errText(e)); } finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);
  const reloadAndNotify = useCallback(() => { void reload(); onChanged?.(); }, [reload, onChanged]);
  const view = useMemo<Bootstrap | null>(() => (data && maDA
    ? { ...data, tasks: data.tasks.filter((t) => t.ma_da === maDA), projects: data.projects.filter((p) => p.ma_da === maDA) }
    : data), [data, maDA]);

  return (
    <main className="tim-root">
      <style>{CSS}</style>
      <header className="tim-top">
        <h1>Giao nhiệm vụ &amp; văn bản ICT</h1>
        {data && <span className="tim-muted">{data.me.ho_ten} · {data.me.role === 'DIRECTOR' ? 'Giám đốc' : 'Chuyên viên'}</span>}
        <button className="tim-ghost" onClick={() => void reload()} disabled={loading}>{loading ? 'Đang tải…' : 'Làm mới'}</button>
      </header>
      {error && <p className="tim-note tim-warn" role="alert">{error}</p>}
      {!data && loading && <p className="tim-muted">Đang tải…</p>}
      {view && (view.me.role === 'DIRECTOR' ? <DirectorView data={view} api={api} reload={reloadAndNotify} defaultMaDA={maDA} /> : <SpecialistView data={view} api={api} reload={reloadAndNotify} />)}
    </main>
  );
}

/* ============================== Giao diện ============================== */
const CSS = `
.tim-root{--bg:#fff;--fg:#1c2530;--mut:#64707d;--line:#d8dee5;--card:#f7f9fb;--acc:#1f5f99;--acc-fg:#fff;--warn:#b3261e;--ok:#1e7a46;
  max-width:980px;margin:0 auto;padding:16px;color:var(--fg);background:var(--bg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){.tim-root{--bg:#12181f;--fg:#e6ebf0;--mut:#9aa7b4;--line:#2c3742;--card:#1a222b;--acc:#6aa8e0;--acc-fg:#0b1218;--warn:#ff8a80;--ok:#6fd39a}}
.tim-root *{box-sizing:border-box}
.tim-root h1{font-size:20px;margin:0}.tim-root h2{font-size:17px;margin:24px 0 8px}.tim-root h3{margin:0 0 8px;font-size:16px}
.tim-top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between;margin-bottom:12px}
.tim-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0;display:grid;gap:10px}
.tim-head{display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap}.tim-badges{display:flex;gap:6px;flex-wrap:wrap}
.tim-badge{border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px;font-style:normal;white-space:nowrap}
.tim-star{border-color:var(--acc);color:var(--acc)}.tim-late{border-color:var(--warn);color:var(--warn)}
.tim-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}
.tim-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}.tim-grow{flex:1 1 220px}
.tim-root label{display:grid;gap:3px;font-size:13px;color:var(--mut)}
.tim-root input:not([type=checkbox]):not([type=radio]),.tim-root select,.tim-root textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;width:100%}
.tim-root input[aria-invalid=true]{border-color:var(--warn)}
.tim-check{display:flex!important;grid-template-columns:none;align-items:center;gap:8px;color:var(--fg)!important;font-size:14px!important}
.tim-root button{font:inherit;background:var(--acc);color:var(--acc-fg);border:1px solid var(--acc);border-radius:6px;padding:7px 14px;cursor:pointer}
.tim-root button.tim-ghost{background:transparent;color:var(--acc)}.tim-root button:disabled{opacity:.5;cursor:not-allowed}
.tim-root button:focus-visible,.tim-root input:focus-visible,.tim-root select:focus-visible,.tim-root textarea:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.tim-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.tim-tabs button{background:transparent;color:var(--fg);border-color:var(--line)}
.tim-tabs button.tim-on{background:var(--acc);color:var(--acc-fg);border-color:var(--acc)}
.tim-ict{border:1px dashed var(--line);border-radius:8px;padding:10px}.tim-plain{border:0;padding:0;margin:0}
.tim-ict legend,.tim-plain legend{font-size:13px;color:var(--mut)}
.tim-list{list-style:none;padding:0;margin:4px 0;display:grid;gap:8px}.tim-list li{border-top:1px solid var(--line);padding-top:6px}
.tim-muted{color:var(--mut)}.tim-small{font-size:12px}.tim-note{margin:4px 0;font-size:13px}.tim-warn{color:var(--warn)}
.tim-sub{display:grid;gap:8px;border-top:1px solid var(--line);padding-top:8px}
.tim-root code{font-size:12px}
@media (max-width:560px){.tim-root{padding:12px}}
`;
