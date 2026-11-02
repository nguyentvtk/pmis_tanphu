import type { ReactNode } from 'react';

export const metadata = { title: 'PMIS Tân Phú', description: 'Hệ thống số điều hành tập trung – Ban QLDA ĐTXD xã Tân Phú' };
export const viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
