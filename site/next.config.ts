import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pure static export: everything is rendered at build time from public/data/*.json.
  output: "export",
  reactStrictMode: true,
  // No image optimizer in a static export; avatars are plain <img> tags anyway.
  images: { unoptimized: true },
  // The repo root has its own package-lock.json (scraper); keep Turbopack scoped to site/.
  turbopack: { root: __dirname },
};

export default nextConfig;
