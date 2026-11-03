import React, { useEffect, useMemo, useState } from 'react';
import GanttScheduleEngine, { GanttDataSource, GanttPayload, FieldReport, ReportInput, createSupabaseDataSource, SupabaseLike } from '../GanttScheduleEngine';
import { usePmisStore } from '../usePmisStore';
import { getSupabase, ensureSupabaseSession } from '../lib/supabaseClient';
import { getGoogleIdToken } from '../../lib/googleAuth';

/**
 * Tab 4 — Gantt & phân tích EVM.
 * Nguồn dữ liệu:
 *   - Mặc định: action `ganttBootstrap` qua /api/gas (GAS/Sheets), cache SWR.
 *   - Nếu đã cấu hình Supabase (NEXT_PUBLIC_SUPABASE_URL + ANON_KEY) VÀ đăng nhập Supabase Auth thành công:
 *     đọc trực tiếp từ Supabase (rpc_gantt_bootstrap). Nếu Supabase lỗi → tự rơi về GAS (không làm hỏng tab).
 * Lọc theo `maDA` đang chọn ở phía client nên đổi dự án là tức thì.
 */
export default function GanttTab() {
  const client = usePmisStore((s) => s.client);
  const maDA = usePmisStore((s) => s.maDA);
  const version = usePmisStore((s) => s.dataVersion);
  const [source, setSource] = useState<{ ds: GanttDataSource; via: 'supabase' | 'gas' } | null>(null);

  const only = useMemo(() => <T extends { ma_da: string | number }>(rows: T[]): T[] => (maDA ? rows.filter((r) => String(r.ma_da) === maDA) : rows), [maDA]);

  // Nguồn GAS (mặc định) — luôn sẵn sàng khi store đã có client.
  const gasDs = useMemo<GanttDataSource | null>(() => {
    if (!client) return null;
    return {
      async load(): Promise<GanttPayload> {
        const p = await client.call<GanttPayload>('ganttBootstrap', {});
        return { ...p, projects: only(p.projects), gantt: only(p.gantt), reports: only(p.reports), tasks: only(p.tasks) };
      },
      async addReport(input: ReportInput): Promise<FieldReport> {
        const r = await client.mutate<{ report: FieldReport }>('addFieldReport', input as unknown as Record<string, unknown>);
        return r.report;
      },
    };
  }, [client, only]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!gasDs) { setSource(null); return; }
      const sb = getSupabase();
      if (sb) {
        try {
          await ensureSupabaseSession(getGoogleIdToken);
          const base = createSupabaseDataSource(sb as unknown as SupabaseLike);
          const ds: GanttDataSource = {
            ...base,
            async load(): Promise<GanttPayload> {
              const p = await base.load();
              return { ...p, projects: only(p.projects), gantt: only(p.gantt), reports: only(p.reports), tasks: only(p.tasks) };
            },
          };
          if (alive) { setSource({ ds, via: 'supabase' }); return; }
        } catch (e) {
          console.warn('[PMIS] Supabase Gantt không khả dụng, dùng GAS:', (e as Error).message);
        }
      }
      if (alive) setSource({ ds: gasDs, via: 'gas' });
    })();
    return () => { alive = false; };
  }, [gasDs, only]);

  if (!source) return <p className="pm-note" role="status">Đang kết nối…</p>;
  // key theo nguồn + maDA: đổi nguồn/dự án thì dựng lại; refreshKey theo dataVersion.
  return <GanttScheduleEngine key={source.via + '|' + (maDA || 'ALL')} dataSource={source.ds} refreshKey={version} pollMs={60000} height="calc(100dvh - 260px)" />;
}
