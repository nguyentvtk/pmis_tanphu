/**
 * VgcaSignService.ts — Thẩm định & ký số PDF bằng USB Token VGCA (Ban Cơ yếu Chính phủ).
 *
 * Phạm vi:
 *  1. sniffPdfSignatureString(buf) : đọc nhị phân PDF, tìm /Type /Sig, /ByteRange, /Contents,
 *     trích signerName. CHỈ kiểm tra "có chữ ký" ở phía client (không xác thực mật mã).
 *  2. uploadSignedOnly(...)        : chặn nộp tệp chưa ký; tính SHA-256; đẩy qua `store`.
 *  3. VgcaWebSignerClient          : luồng ký "Ký số TOKEN → Thêm số, thêm ngày tháng,
 *                                    ký số tổ chức → HOÀN THÀNH" qua VGCA Web Signer.
 *
 * QUY ƯỚC / GHI CHÚ QUAN TRỌNG
 *  - Chỉ hỗ trợ USB Token Chữ ký số Chuyên dùng Công vụ VGCA. Không có mã nào cho VNPT-CA
 *    hay nhà cung cấp khác; không có luồng ký bằng file .p12/.pfx hay khoá trong trình duyệt.
 *  - Không đọc, không lưu mã PIN. PIN do VGCA Web Signer / driver token hỏi trực tiếp.
 *  - Mã nguồn gốc của `sniffPdfSignatureString` (PMS eSign) KHÔNG có trong phiên làm việc này,
 *    nên hàm được viết lại theo mô tả hành vi. Cần đối chiếu với bản gốc trước khi thay thế.
 *  - Giao thức VGCA Web Signer (cổng, tên hành động, tham số) chưa có tài liệu trong phiên này.
 *    Mọi giao tiếp đi qua `VgcaTransport` do đơn vị cắm vào; tên hành động trong
 *    `VGCA_ACTIONS` là GIẢ ĐỊNH và phải đối chiếu tài liệu chính thức khi tích hợp.
 */

/* ───────────────────────── Kiểu dữ liệu ───────────────────────── */

export interface PdfSignatureInfo {
  /** Có ít nhất một chữ ký hoàn chỉnh (ByteRange hợp lệ + Contents khác rỗng/không toàn 0). */
  signed: boolean;
  /** Số chữ ký hoàn chỉnh tìm thấy. */
  count: number;
  /** Tên người ký / đơn vị ký (CN trong chứng thư; hoặc /Name). Rỗng nếu không trích được. */
  signerName: string;
  organization: string;
  issuerName: string;
  /** /M của từ điển chữ ký, dạng ISO nếu đọc được. */
  signTime: string;
  /** ByteRange của chữ ký cuối phủ đến hết tệp (không bị thêm dữ liệu sau khi ký). */
  coversWholeFile: boolean;
  /** Chứng thư do Ban Cơ yếu Chính phủ cấp (nhận diện theo chuỗi — chỉ mang tính cảnh báo). */
  issuerLooksVgca: boolean;
  /** Có ô chữ ký trống (/FT /Sig không có /V) chưa được ký. */
  hasEmptyField: boolean;
  /** Lý do khi signed=false hoặc cảnh báo. */
  reasons: string[];
}

export class UnsignedPdfError extends Error {
  info: PdfSignatureInfo;
  constructor(msg: string, info: PdfSignatureInfo) {
    super(msg);
    this.name = 'UnsignedPdfError';
    this.info = info;
  }
}

/* ───────────────────────── Tiện ích nhị phân ───────────────────────── */

const toU8 = (b: ArrayBuffer | Uint8Array): Uint8Array =>
  b instanceof Uint8Array ? b : new Uint8Array(b);

/** Giải mã latin1 theo khối để tránh tràn stack với tệp lớn. */
function latin1(u: Uint8Array): string {
  const CH = 0x8000;
  let s = '';
  for (let i = 0; i < u.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(u.subarray(i, Math.min(i + CH, u.length))));
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/[^0-9a-fA-F]/g, '');
  const n = h.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const u = toU8(buf);
  const ab = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  const d = await crypto.subtle.digest('SHA-256', ab);
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ───────────────────────── DER tối thiểu (PKCS#7) ───────────────────────── */

interface Der { tag: number; start: number; hdr: number; len: number; end: number }

function derAt(u: Uint8Array, p: number, limit = u.length): Der | null {
  if (p + 2 > limit) return null;
  const tag = u[p];
  let l = u[p + 1];
  let hdr = 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    if (n === 0 || n > 4 || p + 2 + n > limit) return null; // không hỗ trợ độ dài bất định
    l = 0;
    for (let i = 0; i < n; i++) l = l * 256 + u[p + 2 + i];
    hdr = 2 + n;
  }
  const end = p + hdr + l;
  if (end > limit) return null;
  return { tag, start: p, hdr, len: l, end };
}

function derChildren(u: Uint8Array, d: Der): Der[] {
  const out: Der[] = [];
  let p = d.start + d.hdr;
  while (p < d.end) {
    const c = derAt(u, p, d.end);
    if (!c) break;
    out.push(c);
    p = c.end;
  }
  return out;
}

function derString(u: Uint8Array, d: Der): string {
  const b = u.subarray(d.start + d.hdr, d.end);
  if (d.tag === 0x1e) { // BMPString
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (d.tag === 0x0c) return new TextDecoder('utf-8').decode(b);
  return latin1(b);
}

const OID_CN = [0x55, 0x04, 0x03];
const OID_O = [0x55, 0x04, 0x0a];

/** Đọc RDNSequence → { CN, O }. */
function readName(u: Uint8Array, name: Der): { cn: string; o: string } {
  const r = { cn: '', o: '' };
  for (const rdn of derChildren(u, name)) {
    for (const atv of derChildren(u, rdn)) {
      const [oid, val] = derChildren(u, atv);
      if (!oid || !val || oid.tag !== 0x06) continue;
      const ob = u.subarray(oid.start + oid.hdr, oid.end);
      const eq = (a: number[]) => ob.length === a.length && a.every((x, i) => ob[i] === x);
      if (eq(OID_CN) && !r.cn) r.cn = derString(u, val);
      else if (eq(OID_O) && !r.o) r.o = derString(u, val);
    }
  }
  return r;
}

interface CertBrief { serialHex: string; subject: { cn: string; o: string }; issuer: { cn: string; o: string } }

function readCert(u: Uint8Array, cert: Der): CertBrief | null {
  const tbs = derChildren(u, cert)[0];
  if (!tbs) return null;
  let k = derChildren(u, tbs);
  if (k[0] && k[0].tag === 0xa0) k = k.slice(1); // [0] version
  // k: serial, sigAlg, issuer, validity, subject, spki...
  if (k.length < 5) return null;
  const ser = u.subarray(k[0].start + k[0].hdr, k[0].end);
  return {
    serialHex: Array.from(ser).map((x) => x.toString(16).padStart(2, '0')).join('').replace(/^0+/, ''),
    issuer: readName(u, k[2]),
    subject: readName(u, k[4]),
  };
}

/** PKCS#7 SignedData → chứng thư của người ký (khớp serial trong SignerInfo; nếu không, chứng thư đầu). */
function signerFromPkcs7(der: Uint8Array): CertBrief | null {
  try {
    const ci = derAt(der, 0);
    if (!ci || ci.tag !== 0x30) return null;
    const content0 = derChildren(der, ci)[1]; // [0] EXPLICIT
    if (!content0) return null;
    const sd = derChildren(der, content0)[0];
    if (!sd) return null;
    const parts = derChildren(der, sd); // version, digestAlgs, contentInfo, [0] certs, [1] crls?, signerInfos
    const certsD = parts.find((p) => p.tag === 0xa0);
    const sis = parts[parts.length - 1];
    if (!certsD) return null;
    const certs = derChildren(der, certsD).map((c) => readCert(der, c)).filter((c): c is CertBrief => !!c);
    if (!certs.length) return null;
    let serial = '';
    if (sis && sis.tag === 0x31) {
      const si = derChildren(der, sis)[0];
      if (si) {
        const f = derChildren(der, si); // version, issuerAndSerial, ...
        const ias = f[1];
        if (ias && ias.tag === 0x30) {
          const s = derChildren(der, ias)[1];
          if (s) {
            serial = Array.from(der.subarray(s.start + s.hdr, s.end))
              .map((x) => x.toString(16).padStart(2, '0')).join('').replace(/^0+/, '');
          }
        }
      }
    }
    return certs.find((c) => serial && c.serialHex === serial) || certs[0];
  } catch {
    return null;
  }
}

/* ───────────────────────── sniffPdfSignatureString ───────────────────────── */

function unescapePdfString(s: string): string {
  // Chuỗi literal (…) hoặc hex <FEFF…>
  s = s.trim();
  if (s.startsWith('<')) {
    const b = hexToBytes(s.slice(1, -1));
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      let o = '';
      for (let i = 2; i + 1 < b.length; i += 2) o += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return o;
    }
    return latin1(b);
  }
  s = s.slice(1, -1).replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] || c)
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let o = '';
    for (let i = 2; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return o;
  }
  return s;
}

function pdfDateToIso(s: string): string {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return '';
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', sg, th = '00', tm = '00'] = m;
  const tz = !sg || sg === 'Z' || sg === 'z' ? 'Z' : `${sg}${th}:${tm}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}${tz}`;
}

const VGCA_RE = /(c[ơo]\s*y[ếe]u|co\s*yeu|ban\s*c[ơo]\s*y[ếe]u|government\s*certification|vgca|bcy)/i;

/**
 * Kiểm tra nhị phân PDF có chữ ký số hay không và trích tên người ký.
 * Chỉ là kiểm tra "có chữ ký / cấu trúc hợp lệ", KHÔNG xác thực toàn vẹn hay chuỗi chứng thư.
 */
export function sniffPdfSignatureString(arrayBuffer: ArrayBuffer | Uint8Array): PdfSignatureInfo {
  const u = toU8(arrayBuffer);
  const info: PdfSignatureInfo = {
    signed: false, count: 0, signerName: '', organization: '', issuerName: '', signTime: '',
    coversWholeFile: false, issuerLooksVgca: false, hasEmptyField: false, reasons: [],
  };
  if (u.length < 8 || latin1(u.subarray(0, 1024)).indexOf('%PDF-') < 0) {
    info.reasons.push('Không phải tệp PDF (thiếu tiêu đề %PDF-).');
    return info;
  }
  const txt = latin1(u);
  const brRe = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  // Ô chữ ký trống: /FT /Sig mà không có chữ ký hoàn chỉnh tương ứng.
  const ftSig = (txt.match(/\/FT\s*\/Sig(?![A-Za-z])/g) || []).length;

  let m: RegExpExecArray | null;
  let lastEnd = -1;
  let best: { cms: Uint8Array; name: string; m: string } | null = null;
  while ((m = brRe.exec(txt))) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
    if (!(a === 0 && b > 0 && c > b && d >= 0 && c + d <= u.length + 2 && c <= u.length)) {
      info.reasons.push('ByteRange không hợp lệ.');
      continue;
    }
    // Khoảng hở giữa 2 đoạn ByteRange chính là chuỗi hex <...> của /Contents.
    const gap = txt.slice(b, c);
    if (gap.charAt(0) !== '<' || gap.charAt(gap.length - 1) !== '>') {
      info.reasons.push('Khoảng hở ByteRange không khớp /Contents.');
      continue;
    }
    const cms = hexToBytes(gap.slice(1, -1));
    if (!cms.some((x) => x !== 0)) { info.reasons.push('/Contents rỗng (chỗ dành sẵn, chưa ký).'); continue; }

    info.count++;
    lastEnd = c + d;
    const near = txt.slice(Math.max(0, m.index - 1500), m.index) + txt.slice(m.index, m.index + 1500).replace(/<[0-9A-Fa-f\s]{200,}>/g, '<>');
    const nm = /\/Name\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(near);
    const mm = /\/M\s*\((D:[^)]*)\)/.exec(near);
    best = { cms, name: nm ? unescapePdfString(nm[1]) : '', m: mm ? mm[1] : '' };
  }

  info.hasEmptyField = ftSig > info.count;
  if (!info.count) {
    if (!info.reasons.length) info.reasons.push('Không tìm thấy chữ ký số (/Type /Sig + /ByteRange + /Contents).');
    return info;
  }

  info.signed = true;
  info.coversWholeFile = lastEnd >= u.length - 2; // cho phép 1–2 byte EOL cuối
  if (!info.coversWholeFile) info.reasons.push('Tệp có dữ liệu sau chữ ký cuối (có thể đã bị chỉnh sửa sau khi ký).');
  if (best) {
    const cert = signerFromPkcs7(best.cms);
    info.signerName = (cert && cert.subject.cn) || best.name || '';
    info.organization = cert ? cert.subject.o : '';
    info.issuerName = cert ? cert.issuer.cn || cert.issuer.o : '';
    info.signTime = best.m ? pdfDateToIso(best.m) : '';
    info.issuerLooksVgca = VGCA_RE.test(`${cert?.issuer.cn || ''} ${cert?.issuer.o || ''}`);
  }
  if (!info.signerName) info.reasons.push('Không trích xuất được tên người ký.');
  return info;
}

/* ───────────────────────── uploadSignedOnly ───────────────────────── */

export interface SignedUploadMeta {
  maDA: string;
  maGT?: string;
  tenTL: string;
  loai?: string;
  /** Nguồn: 'UPLOAD' (tải trực tiếp) hoặc 'ICT' (đồng bộ vbdh.tayninh.gov.vn). */
  nguon?: 'UPLOAD' | 'ICT';
  nguoiTao?: string;
}

export interface SignedUploadResult {
  sha256: string;
  size: number;
  signature: PdfSignatureInfo;
  stored: unknown;
}

export interface UploadSignedOptions {
  /** Hàm lưu thực tế (Storage + tai_lieu). Chỉ được gọi khi PDF ĐÃ KÝ. */
  store: (file: { name: string; bytes: Uint8Array; sha256: string; signature: PdfSignatureInfo }, meta: SignedUploadMeta) => Promise<unknown>;
  /** Móc ghi nhật ký (nhat_ky) — không bắt buộc. */
  onAudit?: (ev: { action: 'UPLOAD_SIGNED' | 'REJECT_UNSIGNED'; meta: SignedUploadMeta; sha256?: string; reason?: string }) => void | Promise<void>;
  /** 'warn' (mặc định): chỉ cảnh báo nếu chứng thư không giống VGCA. 'enforce': từ chối. */
  issuerPolicy?: 'warn' | 'enforce';
  /** Từ chối khi có dữ liệu sau chữ ký cuối. Mặc định true. */
  rejectModifiedAfterSign?: boolean;
  maxBytes?: number;
}

const DEFAULT_MAX = 50 * 1024 * 1024;

/** Chỉ cho nộp PDF đã ký số; chưa ký thì ném UnsignedPdfError và KHÔNG gọi store. */
export async function uploadSignedOnly(
  file: { name: string; data: ArrayBuffer | Uint8Array },
  meta: SignedUploadMeta,
  opt: UploadSignedOptions,
): Promise<SignedUploadResult> {
  const bytes = toU8(file.data);
  const max = opt.maxBytes ?? DEFAULT_MAX;
  const sig = sniffPdfSignatureString(bytes);
  const reject = async (reason: string): Promise<never> => {
    await opt.onAudit?.({ action: 'REJECT_UNSIGNED', meta, reason });
    throw new UnsignedPdfError(reason, sig);
  };
  if (bytes.length > max) return reject(`Tệp vượt quá giới hạn ${Math.round(max / 1048576)} MB.`);
  if (!sig.signed) return reject(`Tệp “${file.name}” chưa có chữ ký số. ${sig.reasons.join(' ')}`.trim());
  if ((opt.rejectModifiedAfterSign ?? true) && !sig.coversWholeFile) {
    return reject(`Tệp “${file.name}” bị thay đổi sau khi ký.`);
  }
  if (opt.issuerPolicy === 'enforce' && !sig.issuerLooksVgca) {
    return reject(`Chứng thư của “${file.name}” không phải chữ ký số chuyên dùng công vụ VGCA.`);
  }
  const sha = await sha256Hex(bytes);
  const stored = await opt.store({ name: file.name, bytes, sha256: sha, signature: sig }, meta);
  await opt.onAudit?.({ action: 'UPLOAD_SIGNED', meta, sha256: sha });
  return { sha256: sha, size: bytes.length, signature: sig, stored };
}

/* ───────────────────────── VGCA Web Signer ───────────────────────── */

/**
 * Tên hành động GIẢ ĐỊNH. Đối chiếu với tài liệu chính thức của VGCA Web Signer rồi sửa tại đây
 * (hoặc ánh xạ bên trong `transport`). Không thêm nhà cung cấp khác vào bảng này.
 */
export const VGCA_ACTIONS = {
  ping: 'ping',
  listCertificates: 'listCertificates',
  signPdf: 'signPdf',
} as const;

export type VgcaStep = 'KY_SO_TOKEN' | 'THEM_SO_NGAY_THANG' | 'KY_SO_TO_CHUC' | 'HOAN_THANH';

export interface VgcaTransport {
  (action: string, payload: Record<string, unknown>): Promise<any>;
}

export interface VgcaCertificate {
  id: string;
  subjectCN: string;
  organization?: string;
  serial?: string;
  notAfter?: string;
}

export interface VgcaSignRequest {
  pdf: ArrayBuffer | Uint8Array;
  fileName: string;
  /** Số văn bản (bước “Thêm số”). */
  soVanBan?: string;
  /** Ngày tháng văn bản dạng ISO yyyy-mm-dd (bước “thêm ngày tháng”). */
  ngayVanBan?: string;
  /** true: ký số tổ chức (con dấu số cơ quan); false: ký cá nhân. */
  kyToChuc: boolean;
  certificateId?: string;
  reason?: string;
  location?: string;
  onStep?: (s: VgcaStep) => void;
}

export class VgcaUnavailableError extends Error {
  constructor(msg = 'Không kết nối được VGCA Web Signer. Hãy mở ứng dụng và cắm USB Token.') {
    super(msg);
    this.name = 'VgcaUnavailableError';
  }
}

const b64ToU8 = (s: string): Uint8Array => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const u8ToB64 = (u: Uint8Array): string => {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + CH)));
  return btoa(s);
};

export class VgcaWebSignerClient {
  constructor(private transport: VgcaTransport) {}

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.transport(VGCA_ACTIONS.ping, {});
      return !!r && r.ok !== false;
    } catch {
      return false;
    }
  }

  async listCertificates(): Promise<VgcaCertificate[]> {
    if (!(await this.isAvailable())) throw new VgcaUnavailableError();
    const r = await this.transport(VGCA_ACTIONS.listCertificates, {});
    return ((r && r.certificates) || []) as VgcaCertificate[];
  }

  /**
   * Ký một PDF. Trả về PDF đã ký — đã được thẩm định lại bằng sniffPdfSignatureString;
   * nếu kết quả không có chữ ký thì ném UnsignedPdfError (không bao giờ trả tệp chưa ký).
   */
  async sign(req: VgcaSignRequest): Promise<{ bytes: Uint8Array; signature: PdfSignatureInfo; sha256: string }> {
    if (!(await this.isAvailable())) throw new VgcaUnavailableError();
    const orig = toU8(req.pdf);
    const before = sniffPdfSignatureString(orig).count;

    req.onStep?.('KY_SO_TOKEN');
    let certId = req.certificateId;
    if (!certId) {
      const certs = await this.listCertificates();
      if (!certs.length) throw new Error('Không tìm thấy chứng thư số trên USB Token.');
      if (certs.length > 1) throw new Error('Có nhiều chứng thư trên token; hãy chọn một chứng thư (certificateId).');
      certId = certs[0].id;
    }

    req.onStep?.('THEM_SO_NGAY_THANG');
    const stamp = { so: req.soVanBan || '', ngay: req.ngayVanBan || '' };

    req.onStep?.('KY_SO_TO_CHUC');
    const r = await this.transport(VGCA_ACTIONS.signPdf, {
      pdfBase64: u8ToB64(orig),
      fileName: req.fileName,
      certificateId: certId,
      organizationSeal: !!req.kyToChuc,
      stamp,
      reason: req.reason || '',
      location: req.location || '',
    });
    if (!r || r.ok === false || !r.signedPdfBase64) {
      throw new Error((r && r.error) || 'VGCA Web Signer không trả về tệp đã ký (người dùng huỷ hoặc sai PIN).');
    }
    const bytes = b64ToU8(r.signedPdfBase64);
    const signature = sniffPdfSignatureString(bytes);
    if (!signature.signed || signature.count <= before) {
      throw new UnsignedPdfError('Tệp trả về từ VGCA Web Signer không có chữ ký mới.', signature);
    }
    req.onStep?.('HOAN_THANH');
    return { bytes, signature, sha256: await sha256Hex(bytes) };
  }

  /** Ký xong thì nộp luôn (vẫn qua cổng chặn uploadSignedOnly). */
  async signAndUpload(req: VgcaSignRequest, meta: SignedUploadMeta, opt: UploadSignedOptions): Promise<SignedUploadResult> {
    const out = await this.sign(req);
    return uploadSignedOnly({ name: req.fileName, data: out.bytes }, meta, opt);
  }
}

/** Transport mẫu qua HTTP cục bộ — URL do cấu hình cung cấp, KHÔNG có giá trị mặc định đoán mò. */
export function createHttpTransport(baseUrl: string, fetchFn: typeof fetch = fetch): VgcaTransport {
  return async (action, payload) => {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`VGCA Web Signer trả mã ${res.status}`);
    return res.json();
  };
}
