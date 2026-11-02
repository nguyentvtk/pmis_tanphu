'use client';
import dynamic from 'next/dynamic';

const PmisShell = dynamic(() => import('../src/PmisShell'), { ssr: false, loading: () => <p role="status" style={{ padding: 16 }}>Đang tải…</p> });

export default function Page() {
  return <PmisShell />;
}
