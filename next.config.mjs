/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
    instrumentationHook: true,
  },
};
export default nextConfig;
