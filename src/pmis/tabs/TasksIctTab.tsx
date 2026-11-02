import React, { useCallback } from 'react';
import TaskAndIctSyncManager from '../TaskAndIctSyncManager';
import { usePmisStore } from '../usePmisStore';

export interface TabCommonProps { getIdToken: () => Promise<string>; endpoint: string }

/**
 * Tab 2 — Giám đốc giao việc → Chuyên viên xử lý (1 cấp), checkbox "Liên kết ICT" hút văn bản đã ký
 * từ vbdh.tayninh.gov.vn qua userscript cầu nối (phiên đăng nhập của chính người dùng).
 * Lọc theo `maDA` đang chọn; sau mỗi thao tác ghi, làm mới ảnh chụp Master để các tab khác thấy ngay.
 */
export default function TasksIctTab({ getIdToken, endpoint }: TabCommonProps) {
  const maDA = usePmisStore((s) => s.maDA);
  const refresh = usePmisStore((s) => s.refresh);
  const onChanged = useCallback(() => { void refresh({ force: true }); }, [refresh]);
  return <TaskAndIctSyncManager gasUrl={endpoint} getIdToken={getIdToken} maDA={maDA || undefined} onChanged={onChanged} />;
}
