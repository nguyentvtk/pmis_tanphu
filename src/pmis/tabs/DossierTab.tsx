import React, { useEffect, useMemo, useState } from 'react';
import SettlementZipExporter, { Libs, PHASES, REQUIRED_DOCS, classifyPhase, norm, TaiLieuRow } from '../SettlementZipExporter';
import { usePmisStore, str } from '../usePmisStore';
import { createMasterSettlementSource, toSettlementData } from './settlementSource';
import DriveFolderCard from './DriveFolderCard';
import { MAX_FILE_BYTES } from './transfer';
import { fmtBytes } from './pdfUtil';

export interface DossierTabProps {
  /** Nạp JSZip + ExcelJS khi cần (dynamic import) để không nặng gói chính. */
  loadLibs: () => Promise<Libs>;
  /** URL tệp Excel mẫu BCQT TT 73/2026/TT-BTC. */
  templateUrl: string;
}

/** Tab 3 — Cây hồ sơ công trình P1→P6 của dự án đang chọn + xuất gói .ZIP quyết toán TT 73/2026/TT-BTC. */
export default function DossierTab({ loadLibs, templateUrl }: DossierTabProps) {
  const overview = usePmisStore((s) => s.overview);
  const client = usePmisStore((s) => s.client);
  const maDA = usePmisStore((s) => s.maDA);
  const setMaDA = usePmisStore((s) => s.setMaDA);
  const [libs, setLibs] = useState<Libs | null>(null);
  const [libErr, setLibErr] = useState('');

  useEffect(() => { let off = false; loadLibs().then((l) => { if (!off) setLibs(l); }).catch((e) => { if (!off) setLibErr(String((e as Error).message || e)); }); return () => { off = true; }; }, [loadLibs]);

  const source = useMemo(() => (client ? createMasterSettlementSource({ client, getOverview: () => usePmisStore.getState().overview }) : null), [client]);

  const tree = useMemo(() => {
    if (!overview || !maDA) return null;
    let data;
    try { data = toSettlementData(overview, maDA); } catch { return null; }
    const gt = new Map(data.goiThau.map((g) => [g.ma_gt, g]));
    const docs = data.taiLieu.filter((t) => t.trang_thai !== 'SUPERSEDED').map((tl: TaiLieuRow) => ({ tl, phase: classifyPhase(tl, tl.ma_gt ? gt.get(tl.ma_gt) : undefined).phase }));
    return PHASES.map((p) => {
      const items = docs.filter((d) => d.phase === p.key);
      const req = REQUIRED_DOCS.filter((r) => r.phase === p.key).map((r) => ({ r, ok: items.some((d) => r.re.test(norm(d.tl.ten_tl))) }));
      return { phase: p, items, req };
    });
  }, [overview, maDA]);

  const projects = useMemo(() => (overview?.duAn ?? []).map((d) => ({ id: str(d.ma_da), ten: str(d.ten_da) })), [overview]);

  const loadTemplate = useMemo(() => async (): Promise<ArrayBuffer> => {
    const r = await fetch(templateUrl);
    if (!r.ok) throw new Error(`Không tải được mẫu BCQT (${r.status}).`);
    return r.arrayBuffer();
  }, [templateUrl]);

  if (!overview) return <p className="pm-note" role="status">Đang tải…</p>;

  return (
    <div className="pm-stack">
      <section className="pm-card" aria-labelledby="ds-tree">
        <h3 id="ds-tree">Cây hồ sơ công trình{maDA ? ` – ${projects.find((p) => p.id === maDA)?.ten ?? maDA}` : ''}</h3>
        {!maDA && <p className="pm-note">Chọn một dự án ở thanh trên để xem cây hồ sơ và xuất gói quyết toán.</p>}
        {tree && (
          <ul className="pm-tree" role="tree" aria-label="Cây hồ sơ 6 giai đoạn">
            {tree.map(({ phase, items, req }) => (
              <li key={phase.key} role="treeitem" aria-expanded="true">
                <details open={items.length > 0 || req.some((x) => !x.ok && x.r.batBuoc)}>
                  <summary><b>{phase.key.slice(0, 2)}</b> {phase.ten} <span className="pm-badge pm-ghost">{items.length} tệp</span>
                    {req.some((x) => !x.ok && x.r.batBuoc) && <span className="pm-badge" style={{ ['--k' as string]: 'var(--pm-orange)' }}>thiếu {req.filter((x) => !x.ok && x.r.batBuoc).length}</span>}</summary>
                  <ul role="group">
                    {req.filter((x) => !x.ok).map(({ r }) => <li key={r.ten} className={r.batBuoc ? 'pm-miss' : 'pm-note'}>{r.batBuoc ? 'Thiếu' : 'Chưa có (không bắt buộc)'}: {r.ten.replace(/ \((nếu có|khi đã có)\)$/, '')}</li>)}
                    {items.map(({ tl }) => (
                      <li key={String(tl.id)}>
                        {tl.url_nguon ? <span>{tl.ten_tl}</span> : <span>{tl.ten_tl} <span className="pm-badge pm-ghost">không có đường dẫn</span></span>}
                        {tl.nguon && <small> · {tl.nguon}</small>}{tl.ma_gt && <small> · {tl.ma_gt}</small>}
                      </li>
                    ))}
                    {items.length === 0 && req.every((x) => x.ok) && <li className="pm-note">Chưa có tệp.</li>}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
        {tree && <p className="pm-note">Phân loại giai đoạn theo từ khoá tên tài liệu rồi theo loại gói thầu (mặc định do hệ thống đề xuất). Việc kiểm tra chữ ký số chỉ xác nhận “có chữ ký”.</p>}
      </section>

      {libErr && <p className="pm-err" role="alert">Không nạp được thư viện đóng gói: {libErr}</p>}
      {!libs && !libErr && <p className="pm-note" role="status">Đang nạp thư viện đóng gói…</p>}
      {libs && source && (
        <SettlementZipExporter key={maDA} source={source} libs={libs} loadTemplate={loadTemplate} defaultMaDA={maDA} />
      )}
      {client && maDA && <DriveFolderCard client={client} maDA={maDA} />}
      <p className="pm-note">Tệp lưu trong Drive được tải theo từng khúc 2 MiB, mỗi tệp tối đa {fmtBytes(MAX_FILE_BYTES)} (theo MAX_FILE_MB ở Apps Script). Tệp lớn hơn được liệt kê trong “Tệp bị loại – không tải được”; khi đó hãy dùng thư mục Drive ở trên.</p>
    </div>
  );
}
