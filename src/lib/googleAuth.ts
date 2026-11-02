/**
 * Đăng nhập Google (Google Identity Services) → ID token cho /api/gas.
 * ID token sống ~1 giờ; getIdToken() tự xin lại im lặng (auto_select) khi sắp hết hạn.
 */
interface Gis {
  accounts: { id: {
    initialize(o: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean; cancel_on_tap_outside?: boolean }): void;
    renderButton(el: HTMLElement, o: Record<string, unknown>): void;
    prompt(cb?: (n: { isNotDisplayed(): boolean; isSkippedMoment(): boolean }) => void): void;
    disableAutoSelect(): void;
  } };
}
declare global { interface Window { google?: Gis } }

let token = '', expMs = 0, listener: ((email: string) => void) | null = null;
let waiting: { res: (t: string) => void; rej: (e: Error) => void }[] = [];

function decode(jwt: string): { exp: number; email: string } {
  const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(atob(p).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
}

function onCredential(r: { credential: string }): void {
  token = r.credential;
  const p = decode(token); expMs = p.exp * 1000;
  listener?.(p.email);
  waiting.forEach((w) => w.res(token)); waiting = [];
}

export function loadGis(): Promise<Gis> {
  if (window.google) return Promise.resolve(window.google);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = () => (window.google ? res(window.google) : rej(new Error('GIS_KHONG_SAN_SANG')));
    s.onerror = () => rej(new Error('KHONG_TAI_DUOC_GOOGLE_SIGN_IN'));
    document.head.appendChild(s);
  });
}

export async function initGoogleSignIn(clientId: string, button: HTMLElement, onSignedIn: (email: string) => void): Promise<void> {
  const g = await loadGis();
  listener = onSignedIn;
  g.accounts.id.initialize({ client_id: clientId, callback: onCredential, auto_select: true, cancel_on_tap_outside: false });
  g.accounts.id.renderButton(button, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'vi', width: 280 });
  g.accounts.id.prompt();
}

export async function getGoogleIdToken(): Promise<string> {
  if (token && expMs - Date.now() > 90_000) return token;
  const g = window.google;
  if (!g) throw new Error('CHUA_DANG_NHAP');
  return new Promise<string>((res, rej) => {
    waiting.push({ res, rej });
    g.accounts.id.prompt((n) => {
      if (n.isNotDisplayed() || n.isSkippedMoment()) { waiting.forEach((w) => w.rej(new Error('PHIEN_DANG_NHAP_HET_HAN'))); waiting = []; }
    });
    setTimeout(() => { const i = waiting.findIndex((w) => w.res === res); if (i >= 0) { waiting.splice(i, 1); rej(new Error('PHIEN_DANG_NHAP_HET_HAN')); } }, 15_000);
  });
}

export function signOutGoogle(): void {
  token = ''; expMs = 0; window.google?.accounts.id.disableAutoSelect();
}
