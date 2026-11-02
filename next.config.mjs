/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Tệp lớn đi theo khúc 2 MiB (≈2,8 MB base64) nên nằm dưới giới hạn thân yêu cầu của hàm serverless.
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    ] }];
  },
};
