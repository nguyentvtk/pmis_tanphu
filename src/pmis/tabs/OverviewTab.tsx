import React, { useMemo, useState } from 'react';
import { usePmisStore } from '../usePmisStore';
import { computeOverview, ProjectKpi, TinhTrang, AlertLevel } from './overviewKpis';

const ty = (v: number): string => (v / 1e9).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' tỷ';
const pct = (v: number | null): string => (v == null ? '—' : (v * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + '%');
const TT_COLOR: Record<TinhTrang, string> = {
  'Chưa khởi công': 'var(--pm-grey)', 'Đúng tiến độ': 'var(--pm-blue)', 'Cần lưu ý': 'var(--pm-amber)',
  'Chậm tiến độ': 'var(--pm-orange)', 'Quá hạn': 'var(--pm-red)', 'Đã hoàn thành': 'var(--pm-green)',
};
const LEVEL: Record<AlertLevel, string> = { CAO: 'Cao', TRUNG_BINH: 'Trung bình', THAP: 'Thấp' };

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="pm-kpi" style={{ ['--k' as string]: color }}>
      <dt>{label}</dt>
      <dd><b>{value}</b>{sub && <span>{sub}</span>}</dd>
    </div>
  );
}

function Donut({ data, label }: { data: { name: string; value: number; color: string }[]; label: string }) {
  const items = data.filter((d) => d.value > 0);
  const total = items.reduce((s, d) => s + d.value, 0);
  const R = 46, C = 56, L = 2 * Math.PI * R;
  let off = 0;
  if (total === 0) return <p className="pm-note">Chưa có dữ liệu.</p>;
  return (
    <div className="pm-donut">
      <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={label}>
        <g transform={`rotate(-90 ${C} ${C})`}>
          {items.map((d) => {
            const len = (d.value / total) * L;
            const el = <circle key={d.name} cx={C} cy={C} r={R} fill="none" stroke={d.color} strokeWidth="16" strokeDasharray={`${len} ${L - len}`} strokeDashoffset={-off}><title>{`${d.name}: ${d.value}`}</title></circle>;
            off += len;
            return el;
          })}
        </g>
        <text x={C} y={C + 5} textAnchor="middle" fontSize="18" fontWeight="700" fill="currentColor">{total}</text>
      </svg>
      <ul className="pm-legend">
        {items.map((d) => <li key={d.name}><i style={{ background: d.color }} aria-hidden="true" />{d.name}: <b>{d.value}</b></li>)}
      </ul>
    </div>
  );
}

export default function OverviewTab() {
  const overview = usePmisStore((s) => s.overview);
  const maDA = usePmisStore((s) => s.maDA);
  const status = usePmisStore((s) => s.overviewStatus);
  const error = usePmisStore((s) => s.overviewError);
  const setMaDA = usePmisStore((s) => s.setMaDA);
  const [nhom, setNhom] = useState<'ALL' | 'KY_THUAT' | 'KE_TOAN'>('ALL');

  const k = useMemo(() => (overview ? computeOverview(overview, maDA) : null), [overview, maDA]);
  const alerts = useMemo(() => (k ? k.alerts.filter((a) => nhom === 'ALL' || a.nhom === nhom) : []), [k, nhom]);

  if (!overview || !k) {
    return <p role={error ? 'alert' : 'status'} className={error ? 'pm-err' : 'pm-note'}>{status === 'error' ? `Không tải được dữ liệu: ${error}` : 'Đang tải tổng quan…'}</p>;
  }
  const pie = (['Đúng tiến độ', 'Cần lưu ý', 'Chậm tiến độ', 'Quá hạn', 'Đã hoàn thành', 'Chưa khởi công'] as TinhTrang[])
    .map((t) => ({ name: t, value: k.projects.filter((p) => p.tinhTrang === t).length, color: TT_COLOR[t] }));
  const nCao = k.alerts.filter((a) => a.muc === 'CAO').length;

  return (
    <div className="pm-stack">
      <dl className="pm-kpis" aria-label="Chỉ số chính">
        <Kpi label="Tổng số dự án" value={String(k.tong)} color="var(--pm-blue)" />
        <Kpi label="Đã hoàn thành" value={String(k.hoanThanh)} color="var(--pm-green)" />
        <Kpi label="Đang thực hiện" value={String(k.dangThucHien)} color="var(--pm-teal)" />
        <Kpi label="Chậm tiến độ" value={String(k.cham)} sub={`quá hạn: ${k.quaHan}`} color="var(--pm-red)" />
        <Kpi label="Chưa khởi công" value={String(k.chuaKhoiCong)} color="var(--pm-grey)" />
        <Kpi label="Vốn cấp / Tổng mức đầu tư" value={`${ty(k.vonCap)} / ${k.tmdt > 0 ? ty(k.tmdt) : '—'}`} color="var(--pm-violet)" />
        <Kpi label="Tỷ lệ giải ngân" value={pct(k.tyLeGiaiNgan)} sub={ty(k.giaiNgan)} color="var(--pm-green)" />
        <Kpi label="Cảnh báo thiếu hồ sơ" value={String(k.alerts.length)} sub={`mức cao: ${nCao}`} color="var(--pm-orange)" />
      </dl>

      <div className="pm-two">
        <section className="pm-card" aria-labelledby="ov-pie"><h3 id="ov-pie">Tình hình thực hiện</h3><Donut data={pie} label="Số dự án theo tình trạng tiến độ" /></section>
        <section className="pm-card" aria-labelledby="ov-nt">
          <h3 id="ov-nt">Nghiệm thu so với thanh toán</h3>
          <div className="pm-bars">
            <span>Lũy kế thanh toán hợp đồng</span><div className="pm-track"><div style={{ width: '100%', background: 'var(--pm-blue)' }} /></div><b>{ty(k.luyKe)}</b>
            <span>Nghiệm thu đã thanh toán</span><div className="pm-track"><div style={{ width: `${k.luyKe > 0 ? Math.min(100, (k.ntDaThanhToan / k.luyKe) * 100) : 0}%`, background: 'var(--pm-amber)' }} /></div><b>{ty(k.ntDaThanhToan)}</b>
          </div>
          {k.chenhNghiemThu > 0 && <p className="pm-note">Chênh {ty(k.chenhNghiemThu)}: cán bộ kỹ thuật chưa bổ sung hồ sơ nghiệm thu.</p>}
        </section>
      </div>

      <section className="pm-card" aria-labelledby="ov-gn">
        <h3 id="ov-gn">Giải ngân so với tiến độ thời gian <small>(vạch đen = % thời gian đã qua)</small></h3>
        <div className="pm-bars">
          {k.projects.filter((p) => p.vonCap > 0).sort((a, b) => (b.tyLeGiaiNgan ?? 0) - (a.tyLeGiaiNgan ?? 0)).map((p: ProjectKpi) => (
            <React.Fragment key={p.ma_da}>
              <button type="button" className="pm-link" onClick={() => setMaDA(p.ma_da)} title={`Chọn dự án ${p.ma_da}`}>{p.ten_da}</button>
              <div className="pm-track" title={`Giải ngân ${pct(p.tyLeGiaiNgan)} · thời gian ${pct(p.tienDoTg)}`}>
                <div style={{ width: `${Math.min(100, (p.tyLeGiaiNgan ?? 0) * 100)}%`, background: TT_COLOR[p.tinhTrang] }} />
                {p.tienDoTg != null && <u style={{ left: `${p.tienDoTg * 100}%` }} aria-hidden="true" />}
              </div>
              <b>{pct(p.tyLeGiaiNgan)}</b>
            </React.Fragment>
          ))}
        </div>
      </section>

      <section className="pm-card" aria-labelledby="ov-al">
        <div className="pm-row">
          <h3 id="ov-al">Cảnh báo thiếu hồ sơ / số liệu ({alerts.length})</h3>
          <label className="pm-inline">Nhóm nhận
            <select value={nhom} onChange={(e) => setNhom(e.target.value as typeof nhom)}>
              <option value="ALL">Tất cả</option><option value="KY_THUAT">Cán bộ kỹ thuật</option><option value="KE_TOAN">Kế toán</option>
            </select>
          </label>
        </div>
        {alerts.length === 0 ? <p className="pm-note">Không có cảnh báo.</p> : (
          <ul className="pm-alerts">
            {alerts.slice(0, 80).map((a) => (
              <li key={a.key} className={`lv-${a.muc}`}>
                <span className="pm-badge">{LEVEL[a.muc]}</span> <span className="pm-badge pm-ghost">{a.nhom === 'KY_THUAT' ? 'Kỹ thuật' : 'Kế toán'}</span> {a.text}
              </li>
            ))}
          </ul>
        )}
        {alerts.length > 80 && <p className="pm-note">Hiển thị 80/{alerts.length} cảnh báo đầu (ưu tiên mức cao). Lọc theo dự án để xem đầy đủ.</p>}
      </section>

      <section className="pm-card" aria-labelledby="ov-ls">
        <h3 id="ov-ls">Danh sách dự án</h3>
        <div className="pm-scroll">
          <table className="pm-table">
            <thead><tr><th scope="col">Mã</th><th scope="col">Dự án</th><th scope="col">Loại</th><th scope="col" className="r">Vốn cấp</th><th scope="col" className="r">Giải ngân</th><th scope="col" className="r">NT đã TT</th><th scope="col">Tình trạng</th></tr></thead>
            <tbody>
              {k.projects.map((p) => (
                <tr key={p.ma_da} aria-current={p.ma_da === maDA ? 'true' : undefined}>
                  <td>{p.ma_da}</td>
                  <td><button type="button" className="pm-link" onClick={() => setMaDA(p.ma_da)}>{p.ten_da}</button></td>
                  <td>{p.loai}</td><td className="r">{ty(p.vonCap)}</td><td className="r">{pct(p.tyLeGiaiNgan)}</td><td className="r">{ty(p.ntDaThanhToan)}</td>
                  <td><span className="pm-badge" style={{ ['--k' as string]: TT_COLOR[p.tinhTrang] }}>{p.tinhTrang}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
