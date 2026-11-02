import React, { useMemo } from 'react';
import GanttScheduleEngine, { GanttDataSource, GanttPayload, FieldReport, ReportInput } from '../GanttScheduleEngine';
import { usePmisStore } from '../usePmisStore';

/**
 * Tab 4 — Gantt & phân tích EVM (khôi phục từ CPM 5.0). Nguồn dữ liệu = action `ganttBootstrap` qua /api/gas
 * (cache SWR ở proxy + ở trình duyệt), lọc theo `maDA` đang chọn ở phía client nên đổi dự án là tức thì.
 * Ghi báo cáo hiện trường → `addFieldReport`; sau đó làm mới ảnh chụp Master để các tab khác đồng bộ.
 */
export default function GanttTab() {
  const client = usePmisStore((s) => s.client);
  const maDA = usePmisStore((s) => s.maDA);
  const version = usePmisStore((s) => s.dataVersion);

  const ds = useMemo<GanttDataSource | null>(() => {
    if (!client) return null;
    const only = <T extends { ma_da: string | number }>(rows: T[]): T[] => (maDA ? rows.filter((r) => String(r.ma_da) === maDA) : rows);
    return {
      async load(): Promise<GanttPayload> {
        const p = await client.call<GanttPayload>('ganttBootstrap', {});
        return { ...p, projects: only(p.projects), gantt: only(p.gantt), reports: only(p.reports), tasks: only(p.tasks) };
      },
      async addReport(input: ReportInput): Promise<FieldReport> {
        const r = await client.mutate<{ report: FieldReport }>('addFieldReport', input as unknown as Record<string, unknown>);
        return r.report; // mutate() đã xoá cache và báo store làm mới Master DB
      },
    };
  }, [client, maDA]);

  if (!ds) return <p className="pm-note" role="status">Đang kết nối…</p>;
  // key theo maDA: đổi dự án thì dựng lại ngay từ cache; refreshKey theo dataVersion: dữ liệu Master đổi thì tải lại.
  return <GanttScheduleEngine key={maDA || 'ALL'} dataSource={ds} refreshKey={version} pollMs={60000} height="calc(100dvh - 260px)" />;
}
