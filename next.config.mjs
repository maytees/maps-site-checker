/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app only ever runs on your machine (next dev / next start).
  reactStrictMode: true,
  // Playwright is server-only; don't try to bundle it for the browser.
  serverExternalPackages: ['playwright', 'playwright-core'],
};

export default nextConfig;
