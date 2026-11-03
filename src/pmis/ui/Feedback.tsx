'use client';
/**
 * Feedback.tsx — hệ thống phản hồi dùng chung cho PMIS:
 *   - toast(message, kind): thông báo nổi, tự đóng sau 3s, aria-live cho trình đọc màn hình.
 *   - confirmDialog(opts): hộp thoại xác nhận (modal) trả Promise<boolean> — thay cho window.confirm().
 * Cả hai dùng API mệnh lệnh qua singleton module (không prop-drilling); <ToastHost/> và <ConfirmHost/>
 * được gắn một lần trong MainPmisApp. CSS nằm trong khối CSS của MainPmisApp (.pm-toast*, .pm-modal*).
 */
import React, { useEffect, useRef, useState } from 'react';

// ─────────────────────────── Toast ───────────────────────────
type ToastKind = 'ok' | 'err' | 'info';
interface ToastItem { id: number; message: string; kind: ToastKind }
let pushToast: ((m: string, k: ToastKind) => void) | null = null;

/** Hiện một toast (tự đóng sau 3s). Gọi được từ bất kỳ đâu sau khi <ToastHost/> đã gắn. */
export function toast(message: string, kind: ToastKind = 'info'): void { pushToast?.(message, kind); }

export function ToastHost(): React.ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    pushToast = (message, kind) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs, { id, message, kind }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3000);
    };
    return () => { pushToast = null; };
  }, []);
  return (
    <div className="pm-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`pm-toast pm-toast-${t.kind}`}>
          <span aria-hidden="true">{t.kind === 'ok' ? '✓' : t.kind === 'err' ? '!' : 'ℹ'}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

// ────────────────────────── Confirm ──────────────────────────
export interface ConfirmOpts { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
let askConfirm: ((o: ConfirmOpts) => Promise<boolean>) | null = null;

/** Mở hộp thoại xác nhận; trả true nếu người dùng đồng ý. Fallback window.confirm nếu host chưa gắn. */
export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  if (askConfirm) return askConfirm(o);
  if (typeof window !== 'undefined') return Promise.resolve(window.confirm(o.message || o.title));
  return Promise.resolve(false);
}

export function ConfirmHost(): React.ReactElement | null {
  const [state, setState] = useState<{ o: ConfirmOpts; resolve: (b: boolean) => void } | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { askConfirm = (o) => new Promise<boolean>((resolve) => setState({ o, resolve })); return () => { askConfirm = null; }; }, []);
  useEffect(() => { if (state) okRef.current?.focus(); }, [state]);
  if (!state) return null;
  const close = (v: boolean): void => { state.resolve(v); setState(null); };
  const { o } = state;
  return (
    <div className="pm-modal-wrap" role="presentation" onClick={() => close(false)} onKeyDown={(e) => { if (e.key === 'Escape') close(false); }}>
      <div className="pm-modal" role="dialog" aria-modal="true" aria-labelledby="pm-modal-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="pm-modal-title">{o.title}</h3>
        {o.message && <p className="pm-note">{o.message}</p>}
        <div className="pm-actions pm-modal-act">
          <button type="button" className="pm-btn pm-ghost" onClick={() => close(false)}>{o.cancelLabel || 'Hủy'}</button>
          <button type="button" ref={okRef} className={`pm-btn ${o.danger ? 'pm-danger' : ''}`} onClick={() => close(true)}>{o.confirmLabel || 'Xác nhận'}</button>
        </div>
      </div>
    </div>
  );
}
