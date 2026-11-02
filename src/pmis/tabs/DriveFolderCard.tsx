import React, { useCallback, useEffect, useState } from 'react';
import type { GasClient } from '../gasClient';
import { GIAI_DOAN, fmtBytes } from './pdfUtil';
import { DriveFolderInfo, DriveScanFile, driveFolder, driveRegister, driveScan, transferErrorText, MAX_FILE_BYTES } from './transfer';

/**
 * Tuỳ chọn thay cho tải/đóng gói trong trình duyệt: mở thư mục Google Drive của dự án.
 *  - Dùng chức năng "Tải xuống" của Drive (Drive tự nén cả thư mục) cho hồ sơ rất lớn.
 *  - Tệp PDF lớn có thể kéo-thả thẳng vào thư mục giai đoạn P1..P6 rồi "Quét" để đăng ký vào hồ sơ
 *    (máy chủ kiểm tra PDF + có chữ ký số + SHA-256 trước khi ghi sổ).
 */
export default function DriveFolderCard({ client, maDA }: { client: GasClient; maDA: string }) {
  const [info, setInfo] = useState<DriveFolderInfo | null>(null);
  const [files, setFiles] = useState<DriveScanFile[] | null>(null);
  const [trunc, setTrunc] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => { setInfo(null); setFiles(null); setSel({}); setErr(''); setMsg(''); }, [maDA]);

  const open = useCallback(async () => {
    setErr(''); setMsg(''); setBusy('folder');
    try { setInfo(await driveFolder(client, maDA)); } catch (e) { setErr(transferErrorText(e)); } finally { setBusy(''); }
  }, [client, maDA]);

  const scan = useCallback(async () => {
    setErr(''); setMsg(''); setBusy('scan');
    try {
      const r = await driveScan(client, maDA);
      setFiles(r.files); setTrunc(r.truncated);
      setSel(Object.fromEntries(r.files.filter((f) => f.isPdf).map((f) => [f.fileId, true])));
      setMsg(r.files.length ? '' : 'Không có tệp mới nào chưa đăng ký.');
    } catch (e) { setErr(transferErrorText(e)); } finally { setBusy(''); }
  }, [client, maDA]);

  const register = async (): Promise<void> => {
    const items = (files ?? []).filter((f) => sel[f.fileId]).map((f) => ({ fileId: f.fileId, giai_doan: f.stage }));
    if (!items.length) return;
    setErr(''); setMsg(''); setBusy('reg');
    try {
      const res = await driveRegister(client, maDA, items);
      const ok = res.filter((r) => r.ok).length, bad = res.filter((r) => !r.ok);
      setMsg(`Đã đăng ký ${ok}/${res.length} tệp.` + (bad.length ? ' Bị từ chối: ' + bad.map((b) => `${files?.find((f) => f.fileId === b.fileId)?.name ?? b.fileId} (${transferErrorText(new Error(b.error))})`).join('; ') : ''));
      const okIds = new Set(res.filter((r) => r.ok).map((r) => r.fileId));
      setFiles((fs) => (fs ?? []).filter((f) => !okIds.has(f.fileId)));
      setSel({});
    } catch (e) { setErr(transferErrorText(e)); } finally { setBusy(''); }
  };

  const nSel = Object.values(sel).filter(Boolean).length;
  const stageName = (k: string): string => GIAI_DOAN.find((g) => g.v === k)?.t ?? k;

  return (
    <section className="pm-card" aria-labelledby="ds-drive">
      <h3 id="ds-drive">Thư mục Google Drive của dự án</h3>
      <p className="pm-note">
        Dùng khi hồ sơ lớn hoặc tệp vượt {fmtBytes(MAX_FILE_BYTES)}: mở thư mục và tải bằng chính Google Drive (chọn thư mục → Tải xuống, Drive tự nén),
        hoặc kéo-thả tệp PDF đã ký vào thư mục giai đoạn rồi bấm “Quét tệp mới” để đưa vào hồ sơ. Cần được chia sẻ quyền truy cập thư mục gốc.
      </p>
      <div className="pm-actions">
        <button type="button" className="pm-btn" onClick={() => void open()} disabled={!!busy}>{busy === 'folder' ? 'Đang lấy liên kết…' : 'Lấy liên kết thư mục'}</button>
        <button type="button" className="pm-btn pm-ghost" onClick={() => void scan()} disabled={!!busy}>{busy === 'scan' ? 'Đang quét…' : 'Quét tệp mới trong thư mục'}</button>
      </div>
      {info && (
        <ul className="pm-links" aria-label="Liên kết thư mục Drive">
          <li><a href={info.url} target="_blank" rel="noopener noreferrer"><b>Thư mục dự án {info.maDA}</b> (mở trong Drive)</a></li>
          {info.stages.map((s) => <li key={s.stage}><a href={s.url} target="_blank" rel="noopener noreferrer">{stageName(s.stage)}</a></li>)}
        </ul>
      )}
      {files && files.length > 0 && (
        <fieldset className="pm-fieldset">
          <legend>Tệp chưa có trong hồ sơ ({files.length}{trunc ? '+' : ''})</legend>
          <ul className="pm-list">
            {files.map((f) => (
              <li key={f.fileId}>
                <label className="pm-check">
                  <input type="checkbox" checked={!!sel[f.fileId]} disabled={!f.isPdf || !!busy} onChange={(e) => setSel((s) => ({ ...s, [f.fileId]: e.target.checked }))} />
                  {f.name} <small>· {f.stage} · {fmtBytes(f.size)}{f.isPdf ? '' : ' · không phải PDF'}</small>
                </label>
              </li>
            ))}
          </ul>
          {trunc && <p className="pm-note">Chỉ hiển thị 200 tệp đầu; đăng ký xong hãy quét lại.</p>}
          <div className="pm-actions">
            <button type="button" className="pm-btn" disabled={!!busy || nSel === 0} onClick={() => void register()}>{busy === 'reg' ? 'Đang kiểm tra & đăng ký…' : `Đăng ký ${nSel} tệp vào hồ sơ`}</button>
          </div>
          <p className="pm-note">Chỉ nhận PDF có chữ ký số (chỉ kiểm tra “có chữ ký”). Mỗi lần tối đa 8 tệp được kiểm tra, hệ thống tự chia lô.</p>
        </fieldset>
      )}
      <p role="status" className="pm-note">{msg}</p>
      {err && <p className="pm-err" role="alert">{err}</p>}
    </section>
  );
}
