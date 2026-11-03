'use client';
/**
 * supabaseClient.ts — client Supabase (tùy chọn) cho app PMIS.
 *
 * Chỉ bật khi có đủ 2 biến môi trường phía trình duyệt:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 * Nếu thiếu → getSupabase() trả null và app tiếp tục dùng nguồn GAS/Sheets như cũ (không đổi hành vi).
 *
 * Đăng nhập Supabase Auth bằng chính Google ID token đang có (reuse, không bắt đăng nhập lại).
 * Cần cấu hình Google là Auth provider trong Supabase (dùng cùng Google Client ID của app).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  _client = url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;
  return _client;
}

let _signIn: Promise<void> | null = null;

/** Đảm bảo có phiên Supabase (đăng nhập bằng Google ID token nếu chưa có). Ném lỗi nếu không đăng nhập được. */
export function ensureSupabaseSession(getIdToken: () => Promise<string>): Promise<void> {
  const sb = getSupabase();
  if (!sb) return Promise.reject(new Error('SUPABASE_CHUA_CAU_HINH'));
  if (!_signIn) {
    _signIn = (async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) return;
      const idToken = await getIdToken();
      const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: idToken });
      if (error) { _signIn = null; throw new Error(error.message); }
    })();
  }
  return _signIn;
}

export async function signOutSupabase(): Promise<void> {
  _signIn = null;
  const sb = getSupabase();
  try { await sb?.auth.signOut(); } catch { /* bỏ qua */ }
}
