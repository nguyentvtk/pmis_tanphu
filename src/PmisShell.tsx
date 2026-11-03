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

const ERR_VI: Record<string, string> = {
  KHONG_TAI_DUOC_GOOGLE_SIGN_IN: 'Không tải được dịch vụ đăng nhập Google. Kiểm tra kết nối mạng rồi tải lại trang.',
  GIS_KHONG_SAN_SANG: 'Dịch vụ đăng nhập Google chưa sẵn sàng. Hãy tải lại trang.',
};
const HELP_DANG_NHAP = 'Nếu không đăng nhập được: đảm bảo trình duyệt này đã đăng nhập một tài khoản Google, và tài khoản đó đã được Ban QLDA cấp quyền. Bạn có thể bấm lại nút ở trên, thử trình duyệt khác, hoặc liên hệ Ban QLDA.';

export default function PmisShell() {
  const btn = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [hint, setHint] = useState('');

  useEffect(() => {
    if (email) return;
    if (!CLIENT_ID) { setErr('Thiếu cấu hình đăng nhập (NEXT_PUBLIC_GOOGLE_CLIENT_ID). Liên hệ quản trị hệ thống.'); return; }
    if (btn.current) initGoogleSignIn(CLIENT_ID, btn.current, setEmail, () => setHint(HELP_DANG_NHAP))
      .catch((e: Error) => setErr(ERR_VI[e.message] || ('Không đăng nhập được: ' + e.message)));
    // Nếu sau một lúc vẫn chưa đăng nhập và chưa có lỗi, hiện hướng dẫn để người dùng không bị kẹt.
    const t = setTimeout(() => setHint((h) => h || HELP_DANG_NHAP), 12_000);
    return () => clearTimeout(t);
  }, [email]);

  if (email) {
    return <MainPmisApp getIdToken={getGoogleIdToken} loadLibs={loadLibs} vgcaBaseUrl={process.env.NEXT_PUBLIC_VGCA_URL || undefined}
      onSignOut={() => { signOutGoogle(); setEmail(''); }} />;
  }
  return (
    <main style={{ maxWidth: 420, margin: '12vh auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22 }}>PMIS Tân Phú</h1>
      <p>Hệ thống số điều hành tập trung – Ban QLDA ĐTXD xã Tân Phú. Đăng nhập bằng tài khoản Google đã được đăng ký.</p>
      <div ref={btn} aria-label="Đăng nhập Google" />
      {err && <p role="alert" style={{ color: '#b42318' }}>{err}</p>}
      {!err && hint && <p role="status" style={{ color: '#475467', fontSize: 14, lineHeight: 1.5 }}>{hint}</p>}
    </main>
  );
}
