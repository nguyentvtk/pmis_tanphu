import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VgcaWebSignerClient, createHttpTransport, uploadSignedOnly, sniffPdfSignatureString, UnsignedPdfError, VgcaUnavailableError,
  PdfSignatureInfo, VgcaStep,
} from '../VgcaSignService';
import { usePmisStore, MA_DA_RE } from '../usePmisStore';
import { GIAI_DOAN, LedgerRow, ChainReport, MAX_UPLOAD_BYTES, fmtBytes, saveBytes, verifyChain } from './pdfUtil';
import { sendPdf, transferErrorText } from './transfer';

export interface SignLedgerTabProps {
  /** Địa chỉ VGCA Web Signer đang chạy trên máy người dùng (theo tài liệu của VGCA). Chưa có → chỉ dùng được "Lưu tệp đã ký". */
  vgcaBaseUrl?: string;
}

const STEPS: { id: VgcaStep; t: string }[] = [
  { id: 'KY_SO_TOKEN', t: 'Ký số bằng USB Token' }, { id: 'THEM_SO_NGAY_THANG', t: 'Thêm số, thêm ngày tháng' },
  { id: 'KY_SO_TO_CHUC', t: 'Ký số tổ chức' }, { id: 'HOAN_THANH', t: 'Hoàn thành' },
];
const todayIso = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

interface Done { name: string; sha256: string; size: number; sig: PdfSignatureInfo; viewUrl?: string; signedBytes?: Uint8Array }

/** Tab 5 — Trình ký VGCA (chỉ USB Token) + Sổ công văn/nhật ký bất biến có kiểm tra chuỗi băm. */
export default function SignLedgerTab({ vgcaBaseUrl }: SignLedgerTabProps) {
  const client = usePmisStore((s) => s.client);
  const maDA = usePmisStore((s) => s.maDA);
  const version = usePmisStore((s) => s.dataVersion);
  const refresh = usePmisStore((s) => s.refresh);

  const [file, setFile] = useState<File | null>(null);
  const [gd, setGd] = useState<string>('P4');
  const [so, setSo] = useState('');
  const [ngay, setNgay] = useState(todayIso());
  const [toChuc, setToChuc] = useState(false);
  const [step, setStep] = useState<VgcaStep | ''>('');
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [chain, setChain] = useState<ChainReport | null>(null);
  const [ledgerErr, setLedgerErr] = useState('');
  const [ledgerBusy, setLedgerBusy] = useState(true);

  const canSign = MA_DA_RE.test(maDA);

  const loadLedger = useCallback(async () => {
    if (!client) return;
    setLedgerBusy(true); setLedgerErr('');
    try {
      const r = await client.call<{ total: number; rows: LedgerRow[] }>('ledgerList', { limit: 300 }, {
        onUpdate: (d) => { void applyLedger(d.rows); },
      });
      await applyLedger(r.rows);
    } catch (e) { setLedgerErr(String((e as Error).message || e)); } finally { setLedgerBusy(false); }
    async function applyLedger(newestFirst: LedgerRow[]): Promise<void> {
      const asc = [...newestFirst].reverse();
      setRows(asc);
      setChain(await verifyChain(asc));
    }
  }, [client]);
  useEffect(() => { void loadLedger(); }, [loadLedger, version]);

  const save = useCallback(async (name: string, data: Uint8Array): Promise<Done> => {
    if (!client) throw new Error('Chưa kết nối.');
    let viewUrl = '';
    const res = await uploadSignedOnly({ name, data }, { maDA, tenTL: name, nguon: 'UPLOAD' }, {
      issuerPolicy: 'warn', maxBytes: MAX_UPLOAD_BYTES,
      store: async (f) => {
        const r = await sendPdf<{ view_url: string }>(client, 'signedUpload', {
          ma_da: maDA, giai_doan: gd, so_ky_hieu: so.trim(), ten_file: f.name,
        }, f.bytes, f.sha256, { onProgress: setProg });
        viewUrl = r.view_url; return r;
      },
    });
    if (!res.signature.issuerLooksVgca) setWarn('Chứng thư không giống chứng thư chuyên dùng công vụ VGCA (chỉ cảnh báo). Hãy kiểm tra lại người ký.');
    return { name, sha256: res.sha256, size: res.size, sig: res.signature, viewUrl };
  }, [client, maDA, gd, so]);

  const run = async (mode: 'ky' | 'luu'): Promise<void> => {
    setErr(''); setWarn(''); setDone(null); setStep('');
    if (!file) return setErr('Chọn tệp PDF.');
    if (!canSign) return setErr('Chọn dự án (mã 7 chữ số) ở thanh trên để lưu hồ sơ đúng thư mục.');
    if (file.size > MAX_UPLOAD_BYTES) return setErr(`Tệp ${fmtBytes(file.size)} vượt giới hạn ${fmtBytes(MAX_UPLOAD_BYTES)}. Hãy đặt tệp vào thư mục Drive của dự án (Tab Hồ sơ) rồi đăng ký.`);
    setBusy(true);
    try {
      const original = new Uint8Array(await file.arrayBuffer());
      if (mode === 'luu') {
        setDone(await save(file.name, original));
      } else {
        if (!vgcaBaseUrl) throw new Error('Chưa cấu hình địa chỉ VGCA Web Signer (prop vgcaBaseUrl).');
        const signer = new VgcaWebSignerClient(createHttpTransport(vgcaBaseUrl));
        const r = await signer.sign({ pdf: original, fileName: file.name, soVanBan: so.trim(), ngayVanBan: ngay, kyToChuc: toChuc, onStep: setStep });
        const name = file.name.replace(/\.pdf$/i, '') + '.signed.pdf';
        const d = await save(name, r.bytes);
        setDone({ ...d, signedBytes: r.bytes });
      }
      void refresh({ force: true });
    } catch (e) {
      if (e instanceof UnsignedPdfError) setErr(`Bị từ chối: ${e.message}`);
      else if (e instanceof VgcaUnavailableError) setErr(e.message);
      else setErr(transferErrorText(e));
    } finally { setBusy(false); setStep(''); setProg(null); }
  };

  const onPick = async (f: File | null): Promise<void> => {
    setFile(f); setDone(null); setErr(''); setWarn('');
    if (f) { try { const s = sniffPdfSignatureString(await f.arrayBuffer()); if (s.signed) setWarn(`Tệp đã có ${s.count} chữ ký (${s.signerName || 'không rõ người ký'}). Có thể “Lưu tệp đã ký” hoặc ký thêm.`); } catch { /* bỏ qua */ } }
  };

  const shown = useMemo(() => {
    const list = maDA ? rows.filter((r) => r.noi_dung.includes(`"ma_da":"${maDA}"`)) : rows;
    return [...list].reverse().slice(0, 100);
  }, [rows, maDA]);
  const bad = useMemo(() => new Set((chain?.badAt ?? []).map(String)), [chain]);

  return (
    <div className="pm-stack">
      <section className="pm-card" aria-labelledby="sg-h">
        <h3 id="sg-h">Trình ký số USB Token VGCA</h3>
        <p className="pm-note">Chỉ chấp nhận chữ ký số chuyên dùng công vụ VGCA bằng USB Token. Hệ thống không đọc hay lưu mã PIN; VGCA Web Signer tự hỏi PIN.</p>
        <form className="pm-form" onSubmit={(e) => { e.preventDefault(); void run('ky'); }}>
          <label>Tệp PDF
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={(e) => void onPick(e.target.files?.[0] ?? null)} />
          </label>
          <label>Dự án (maDA)
            <input value={maDA || ''} readOnly aria-describedby="sg-ma" placeholder="Chọn ở thanh trên" />
            <small id="sg-ma" className="pm-note">{canSign ? 'Lưu vào thư mục dự án này.' : 'Cần chọn một dự án.'}</small>
          </label>
          <label>Giai đoạn lưu
            <select value={gd} onChange={(e) => setGd(e.target.value)}>{GIAI_DOAN.map((g) => <option key={g.v} value={g.v}>{g.t}</option>)}</select>
          </label>
          <label>Số văn bản
            <input value={so} onChange={(e) => setSo(e.target.value)} placeholder="255/QĐ-BQLDA" autoComplete="off" spellCheck={false} />
          </label>
          <label>Ngày văn bản
            <input type="date" value={ngay} onChange={(e) => setNgay(e.target.value)} />
          </label>
          <label className="pm-check"><input type="checkbox" checked={toChuc} onChange={(e) => setToChuc(e.target.checked)} /> Ký số tổ chức (con dấu số cơ quan)</label>
          <div className="pm-actions">
            <button type="submit" className="pm-btn" disabled={busy || !file || !vgcaBaseUrl}>{busy && step ? 'Đang ký…' : 'Ký bằng USB Token VGCA'}</button>
            <button type="button" className="pm-btn pm-ghost" disabled={busy || !file} onClick={() => void run('luu')}>Lưu tệp đã ký sẵn</button>
          </div>
          {busy && prog && prog.total > 2_400_000 && <progress max={prog.total} value={prog.done} aria-label="Tiến trình lưu tệp" style={{ width: '100%' }} />}
          {!vgcaBaseUrl && <p className="pm-note">Chưa cấu hình địa chỉ VGCA Web Signer nên nút ký tạm tắt; vẫn có thể lưu tệp đã ký sẵn.</p>}
        </form>
        <ol className="pm-steps" aria-label="Tiến trình ký">
          {STEPS.map((s, i) => {
            const cur = STEPS.findIndex((x) => x.id === step);
            const st = done ? 'done' : cur === i ? 'now' : cur > i ? 'done' : '';
            return <li key={s.id} className={st} aria-current={st === 'now' ? 'step' : undefined}>{s.t}</li>;
          })}
        </ol>
        <div aria-live="polite">
          {err && <p className="pm-err" role="alert">{err}</p>}
          {warn && <p className="pm-warn">{warn}</p>}
          {done && (
            <div className="pm-ok">
              Đã lưu “{done.name}” ({fmtBytes(done.size)}). Người ký: <b>{done.sig.signerName || 'không rõ'}</b>{done.sig.signTime ? ` · ${done.sig.signTime}` : ''}.<br />
              SHA-256: <code>{done.sha256}</code>
              {done.viewUrl && <> · <a href={done.viewUrl} target="_blank" rel="noopener noreferrer">Mở trong Drive</a></>}
              {done.signedBytes && <> · <button type="button" className="pm-link" onClick={() => saveBytes(done.signedBytes as Uint8Array, done.name)}>Tải bản đã ký</button></>}
            </div>
          )}
        </div>
      </section>

      <section className="pm-card" aria-labelledby="lg-h">
        <div className="pm-row">
          <h3 id="lg-h">Sổ công văn / nhật ký bất biến</h3>
          <button type="button" className="pm-btn pm-ghost" onClick={() => void loadLedger()} disabled={ledgerBusy}>Kiểm tra lại</button>
        </div>
        <p role="status" className={chain ? (chain.ok ? 'pm-ok' : 'pm-err') : 'pm-note'}>
          {ledgerBusy && !chain ? 'Đang tải sổ…' : chain ? (chain.ok ? `Chuỗi băm nguyên vẹn (${chain.checked} dòng gần nhất đã kiểm).` : `PHÁT HIỆN SAI LỆCH tại dòng ${chain.badAt.join(', ')}. ${chain.reasons[0] ?? ''}`) : ''}
        </p>
        {ledgerErr && <p className="pm-err" role="alert">{ledgerErr}</p>}
        <div className="pm-scroll">
          <table className="pm-table">
            <thead><tr><th scope="col">STT</th><th scope="col">Thời gian</th><th scope="col">Người thực hiện</th><th scope="col">Hành động</th><th scope="col">Đối tượng</th><th scope="col">Băm</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={String(r.stt)} className={bad.has(String(r.stt)) ? 'pm-badrow' : ''}>
                  <td>{r.stt}</td><td>{String(r.thoi_gian).replace('T', ' ')}</td><td>{r.nguoi_thuc_hien}</td><td>{r.hanh_dong}</td><td>{r.doi_tuong}</td>
                  <td><code title={r.hash}>{String(r.hash).slice(0, 10)}…</code> {bad.has(String(r.stt)) ? '✗' : '✓'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && !ledgerBusy && <p className="pm-note">Chưa có bản ghi{maDA ? ' cho dự án này' : ''}.</p>}
        <p className="pm-note">Sổ chỉ ghi thêm, mỗi dòng nối băm với dòng trước. Việc kiểm tra chạy ngay trên trình duyệt; dòng đầu của đoạn tải về được lấy làm mốc.</p>
      </section>
    </div>
  );
}
