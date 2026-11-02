# PMIS Tân Phú – ứng dụng web (Next.js 15)

## Chạy thử trên máy
```bash
npm install
cp .env.example .env.local     # điền các biến, xem dưới
npm run dev                    # http://localhost:3000
```
## Biến môi trường
| Biến | Nơi | Giá trị |
|---|---|---|
| `GAS_EXEC_URL` | máy chủ | URL `/exec` của Web app Apps Script |
| `GOOGLE_CLIENT_ID` | máy chủ | OAuth Client ID (trùng Script property) |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | trình duyệt | cùng Client ID |
| `NEXT_PUBLIC_VGCA_URL` | trình duyệt | tuỳ chọn, địa chỉ VGCA Web Signer |

## Đưa lên Vercel
1. Đẩy thư mục này lên một kho GitHub (riêng tư). 2. Vercel → Add New → Project → chọn kho (tự nhận Next.js).
3. Settings → Environment Variables: thêm 4 biến trên cho Production. 4. Deploy.
5. Google Cloud Console → Credentials → OAuth client → *Authorized JavaScript origins*: thêm `https://<tên-miền-vercel>` (và `http://localhost:3000` khi chạy thử).
6. Đặt mẫu quyết toán vào `public/templates/TT73_BCQT.xlsx` rồi deploy lại.

Đổi biến môi trường xong phải **Redeploy** mới có hiệu lực.
