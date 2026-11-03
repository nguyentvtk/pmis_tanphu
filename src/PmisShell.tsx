'use client';
import { useEffect, useRef, useState } from 'react';
import MainPmisApp from './pmis/MainPmisApp';
import type { Libs } from './pmis/SettlementZipExporter';
import { getGoogleIdToken, initGoogleSignIn, signOutGoogle } from './lib/googleAuth';

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

const loadLibs = async (): Promise<Libs> => {
  const [z, e] = await Promise.all([import('jszip'), import('exceljs')]);
  return { JSZip: (z as { default?: unknown }).default ?? z, ExcelJS: (e as { default?: unknown }).default ?? e };
};

export default function PmisShell() {
  const btn = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (email) return;
    if (!CLIENT_ID) { setErr('Thiếu NEXT_PUBLIC_GOOGLE_CLIENT_ID.'); return; }
    if (btn.current) initGoogleSignIn(CLIENT_ID, btn.current, setEmail).catch((e: Error) => setErr(e.message));
  }, [email]);

  if (email) {
    return <MainPmisApp getIdToken={getGoogleIdToken} loadLibs={loadLibs} vgcaBaseUrl={process.env.NEXT_PUBLIC_VGCA_URL || undefined}
      onSignOut={() => {
        signOutGoogle();
        // Dọn cache dữ liệu (SWR) kèm email trong sessionStorage để máy dùng chung không lộ dữ liệu phiên trước.
        try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const key = sessionStorage.key(i); if (key && key.startsWith('pmis:swr:')) sessionStorage.removeItem(key); } } catch { /* bỏ qua */ }
        // Reset URL về gốc (xoá hash-route của phiên trước) cho sạch sau khi đăng xuất.
        try { history.replaceState(null, '', location.pathname + location.search); } catch { /* bỏ qua */ }
        setEmail('');
      }} />;
  }
  return (
    <main style={{ maxWidth: 420, margin: '12vh auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22 }}>PMIS Tân Phú</h1>
      <p>Hệ thống số điều hành tập trung – Ban QLDA ĐTXD xã Tân Phú. Đăng nhập bằng tài khoản Google đã được đăng ký.</p>
      <div ref={btn} aria-label="Đăng nhập Google" />
      {err && <p role="alert" style={{ color: '#b42318' }}>{err}</p>}
    </main>
  );
}
