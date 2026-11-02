/**
 * Đặt tệp này tại:  app/api/gas/route.ts   (Next.js App Router)
 *
 * Biến môi trường (CHỈ phía máy chủ, không có tiền tố NEXT_PUBLIC_):
 *   GAS_EXEC_URL      = https://script.google.com/macros/s/…/exec   (URL triển khai web app của Apps Script)
 *   GOOGLE_CLIENT_ID  = OAuth client ID của Google Sign-In (trùng Script property GOOGLE_CLIENT_ID trong Apps Script)
 *
 * Ứng dụng gọi POST /api/gas với {action, idToken, payload}; không bao giờ gọi trực tiếp URL Apps Script.
 */
import { after } from 'next/server';
import { createGasProxy } from '../../../src/pmis/gasProxyCore'; // chỉnh đường dẫn theo cấu trúc dự án

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let proxy: ReturnType<typeof createGasProxy> | null = null;
function getProxy() {
  if (!proxy) {
    const gasUrl = process.env.GAS_EXEC_URL, clientId = process.env.GOOGLE_CLIENT_ID;
    if (!gasUrl || !clientId) throw new Error('THIEU_BIEN_MOI_TRUONG_GAS_EXEC_URL_HOAC_GOOGLE_CLIENT_ID');
    proxy = createGasProxy({ gasUrl, clientId, defer: (p) => after(() => p) });
  }
  return proxy;
}

export async function POST(req: Request): Promise<Response> {
  let p: ReturnType<typeof createGasProxy>;
  try { p = getProxy(); } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  const r = await p.handle(await req.text());
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Pmis-Cache': r.cache },
  });
}
