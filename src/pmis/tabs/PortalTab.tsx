import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadSignedOnly, sniffPdfSignatureString, UnsignedPdfError, PdfSignatureInfo } from '../VgcaSignService';
import { usePmisStore } from '../usePmisStore';
import { GIAI_DOAN, MAX_UPLOAD_BYTES, fmtBytes } from './pdfUtil';
import { sendPdf, transferErrorText } from './transfer';

interface Pkg { ma_gt: string; ma_da: string; ten_gt: string; loai_gt: string; nha_thau: string }
interface Sub {
  sub_id: string; ma_da: string; ma_gt: string; giai_doan: string; nguoi_nop: string; ten_file: string; view_url: string; sha256: string;
  nguoi_ky: string; ghi_chu: string; trang_thai: 'CHO_DUYET' | 'DA_DUYET' | 'YEU_CAU_BO_SUNG'; nguoi_duyet: string; thoi_gian: string;
}
interface Msg { msg_id: string; sub_id: string; tu_email: string; ben: 'NHA_THAU' | 'BAN_QLDA'; noi_dung: string; thoi_gian: string }
interface PortalData { me: { email: string; ho_ten: string; role: string }; packages: Pkg[]; submissions: Sub[]; messages: Msg[] }

const ST: Record<Sub['trang_thai'], { t: string; c: string }> = {
  CHO_DUYET: { t: 'Chờ duyệt', c: 'var(--pm-amber)' }, DA_DUYET: { t: 'Đã duyệt', c: 'var(--pm-green)' }, YEU_CAU_BO_SUNG: { t: 'Yêu cầu bổ sung', c: 'var(--pm-red)' },
};
const when = (s: string): string => String(s).replace('T', ' ').slice(0, 16);

function Thread({ sub, msgs, isStaff, onReply, onReview, busy }: {
  sub: Sub; msgs: Msg[]; isStaff: boolean; busy: boolean;
  onReply: (subId: string, text: string) => Promise<void>;
  onReview: (subId: string, tt: 'DA_DUYET' | 'YEU_CAU_BO_SUNG', text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const id = `th-${sub.sub_id}`;
  const act = async (f: () => Promise<void>): Promise<void> => { setErr(''); try { await f(); setText(''); } catch (e) { setErr(String((e as Error).message || e)); } };
  return (
    <li className="pm-sub">
      <div className="pm-row">
        <b>{sub.ten_file}</b>
        <span className="pm-badge" style={{ ['--k' as string]: ST[sub.trang_thai].c }}>{ST[sub.trang_thai].t}</span>
      </div>
      <p className="pm-note">Gói {sub.ma_gt} · {sub.giai_doan} · nộp {when(sub.thoi_gian)} bởi {sub.nguoi_nop}{sub.nguoi_ky ? ` · người ký: ${sub.nguoi_ky}` : ''} ·{' '}
        <a href={sub.view_url} target="_blank" rel="noopener noreferrer">Xem tệp</a> · SHA-256 <code title={sub.sha256}>{sub.sha256.slice(0, 10)}…</code></p>
      {sub.ghi_chu && <p>{sub.ghi_chu}</p>}
      <ul className="pm-msgs" aria-label="Phản hồi">
        {msgs.map((m) => <li key={m.msg_id} className={m.ben === 'BAN_QLDA' ? 'ban' : 'nt'}><small>{m.ben === 'BAN_QLDA' ? 'Ban QLDA' : 'Nhà thầu'} · {when(m.thoi_gian)}</small><br />{m.noi_dung}</li>)}
        {msgs.length === 0 && <li className="pm-note">Chưa có phản hồi.</li>}
      </ul>
      <label htmlFor={id}>Nội dung phản hồi</label>
      <textarea id={id} rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      <div className="pm-actions">
        <button type="button" className="pm-btn pm-ghost" disabled={busy || !text.trim()} onClick={() => void act(() => onReply(sub.sub_id, text))}>Gửi phản hồi</button>
        {isStaff && sub.trang_thai !== 'DA_DUYET' && <>
          <button type="button" className="pm-btn" disabled={busy} onClick={() => void act(() => onReview(sub.sub_id, 'DA_DUYET', text))}>Duyệt – đưa vào cây hồ sơ</button>
          <button type="button" className="pm-btn pm-danger" disabled={busy || !text.trim()} onClick={() => void act(() => onReview(sub.sub_id, 'YEU_CAU_BO_SUNG', text))}>Yêu cầu bổ sung</button>
        </>}
      </div>
      {err && <p className="pm-err" role="alert">{err}</p>}
    </li>
  );
}

/**
 * Tab 6 — Cổng Nhà thầu PMS.
 *  - Nhà thầu (đăng nhập Google, email trùng email_lien_he của gói thầu): nộp PDF ĐÃ KÝ SỐ, theo dõi trạng thái, phản hồi.
 *  - Ban QLDA: xem hồ sơ theo dự án đang chọn, phản hồi, duyệt (đưa vào cây hồ sơ) hoặc yêu cầu bổ sung (bắt buộc ghi lý do).
 */
export default function PortalTab() {
  const client = usePmisStore((s) => s.client);
  const me = usePmisStore((s) => s.me);
  const maDA = usePmisStore((s) => s.maDA);
  const refresh = usePmisStore((s) => s.refresh);
  const isStaff = me?.role !== 'CONTRACTOR';

  const [data, setData] = useState<PortalData | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [gt, setGt] = useState('');
  const [gd, setGd] = useState('P4');
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileInfo, setFileInfo] = useState<PdfSignatureInfo | null>(null);
  const [formErr, setFormErr] = useState('');
  const [formOk, setFormOk] = useState('');
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const d = await client.call<PortalData>('portalList', maDA ? { maDA } : {}, { onUpdate: (x) => setData(x) });
      setData(d); setLoadErr('');
    } catch (e) { setLoadErr(String((e as Error).message || e)); }
  }, [client, maDA]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => client?.subscribe(() => { void load(); }), [client, load]);

  const pkgs = useMemo(() => data?.packages ?? [], [data]);
  useEffect(() => { if (!pkgs.some((p) => p.ma_gt === gt)) setGt(pkgs[0]?.ma_gt ?? ''); }, [pkgs, gt]);

  const pick = async (f: File | null): Promise<void> => {
    setFile(f); setFileInfo(null); setFormErr(''); setFormOk('');
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) { setFormErr(`Tệp ${fmtBytes(f.size)} vượt giới hạn ${fmtBytes(MAX_UPLOAD_BYTES)}.`); return; }
    const s = sniffPdfSignatureString(await f.arrayBuffer());
    setFileInfo(s);
    if (!s.signed) setFormErr('Tệp chưa có chữ ký số nên không thể nộp. Hãy ký số trước rồi chọn lại.');
    else if (!s.coversWholeFile) setFormErr('Tệp bị thay đổi sau khi ký. Hãy ký lại.');
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault(); setFormErr(''); setFormOk('');
    if (!client || !file) return setFormErr('Chọn tệp PDF đã ký số.');
    if (!gt) return setFormErr('Chọn gói thầu.');
    const pkg = pkgs.find((p) => p.ma_gt === gt);
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await uploadSignedOnly({ name: file.name, data: bytes }, { maDA: pkg?.ma_da ?? '', maGT: gt, tenTL: file.name, nguon: 'UPLOAD' }, {
        maxBytes: MAX_UPLOAD_BYTES, issuerPolicy: 'warn',
        store: (f, meta) => sendPdf(client, 'portalSubmit', {
          ma_gt: meta.maGT, giai_doan: gd, ten_file: f.name, nguoi_ky: f.signature.signerName, ghi_chu: note.trim(),
        }, f.bytes, f.sha256, { onProgress: setProg }),
      });
      setFormOk(`Đã nộp “${file.name}” (${fmtBytes(r.size)}). Ban QLDA sẽ duyệt hoặc phản hồi tại đây.`);
      setFile(null); setFileInfo(null); setNote('');
      if (fileRef.current) fileRef.current.value = '';
      await load(); void refresh({ force: true });
    } catch (x) {
      setFormErr(x instanceof UnsignedPdfError ? `Bị từ chối: ${x.message}` : transferErrorText(x));
    } finally { setBusy(false); setProg(null); }
  };

  const reply = useCallback(async (subId: string, text: string): Promise<void> => {
    if (!client) return; setBusy(true);
    try { await client.mutate('portalReply', { sub_id: subId, noi_dung: text }); await load(); } finally { setBusy(false); }
  }, [client, load]);
  const review = useCallback(async (subId: string, tt: 'DA_DUYET' | 'YEU_CAU_BO_SUNG', text: string): Promise<void> => {
    if (!client) return; setBusy(true);
    try { await client.mutate('portalReview', { sub_id: subId, trang_thai: tt, noi_dung: text }); await load(); void refresh({ force: true }); } finally { setBusy(false); }
  }, [client, load, refresh]);

  if (!data) return <p role={loadErr ? 'alert' : 'status'} className={loadErr ? 'pm-err' : 'pm-note'}>{loadErr || 'Đang tải cổng nhà thầu…'}</p>;
  const subs = [...data.submissions].sort((a, b) => String(b.thoi_gian).localeCompare(String(a.thoi_gian)));

  return (
    <div className="pm-stack">
      {!isStaff && (
        <section className="pm-card" aria-labelledby="pt-h">
          <h3 id="pt-h">Nộp hồ sơ PDF đã ký số</h3>
          {pkgs.length === 0 ? <p className="pm-note">Email của bạn chưa gắn với gói thầu nào.</p> : (
            <form className="pm-form" onSubmit={(e) => void submit(e)}>
              <label>Gói thầu
                <select value={gt} onChange={(e) => setGt(e.target.value)}>{pkgs.map((p) => <option key={p.ma_gt} value={p.ma_gt}>{p.ma_gt} · {p.ten_gt}</option>)}</select>
              </label>
              <label>Giai đoạn hồ sơ
                <select value={gd} onChange={(e) => setGd(e.target.value)}>{GIAI_DOAN.map((g) => <option key={g.v} value={g.v}>{g.t}</option>)}</select>
              </label>
              <label>Tệp PDF đã ký số
                <input id="pt-file" ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={(e) => void pick(e.target.files?.[0] ?? null)} aria-describedby="pt-fh" />
                <small id="pt-fh" className="pm-note">Tối đa {fmtBytes(MAX_UPLOAD_BYTES)} (tệp lớn được gửi theo từng khúc). Chỉ nhận tệp có chữ ký số.</small>
              </label>
              {fileInfo?.signed && <p className="pm-ok">Có chữ ký số{fileInfo.signerName ? ` của ${fileInfo.signerName}` : ''}. (Chỉ kiểm tra có chữ ký, chưa xác minh hiệu lực chứng thư.)</p>}
              <label>Ghi chú
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
              </label>
              <div className="pm-actions"><button type="submit" className="pm-btn" disabled={busy || !file || !fileInfo?.signed || !fileInfo.coversWholeFile}>{busy ? (prog && prog.total > 2_400_000 ? `Đang nộp ${Math.round((prog.done / prog.total) * 100)}%…` : 'Đang nộp…') : 'Nộp hồ sơ'}</button></div>
              {busy && prog && prog.total > 2_400_000 && <progress max={prog.total} value={prog.done} aria-label="Tiến trình nộp tệp" style={{ width: '100%' }} />}
            </form>
          )}
          <div aria-live="polite">{formErr && <p className="pm-err" role="alert">{formErr}</p>}{formOk && <p className="pm-ok">{formOk}</p>}</div>
        </section>
      )}

      <section className="pm-card" aria-labelledby="ps-h">
        <div className="pm-row">
          <h3 id="ps-h">{isStaff ? `Hồ sơ nhà thầu đã nộp${maDA ? ` – dự án ${maDA}` : ''}` : 'Hồ sơ đã nộp & phản hồi'} ({subs.length})</h3>
          <button type="button" className="pm-btn pm-ghost" onClick={() => void load()} disabled={busy}>Tải lại</button>
        </div>
        {loadErr && <p className="pm-err" role="alert">{loadErr}</p>}
        {subs.length === 0 ? <p className="pm-note">Chưa có hồ sơ.</p> : (
          <ul className="pm-subs">
            {subs.map((s) => <Thread key={s.sub_id} sub={s} msgs={data.messages.filter((m) => m.sub_id === s.sub_id).sort((a, b) => String(a.thoi_gian).localeCompare(String(b.thoi_gian)))} isStaff={isStaff} busy={busy} onReply={reply} onReview={review} />)}
          </ul>
        )}
      </section>
    </div>
  );
}
