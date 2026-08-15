import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // STATIC EXPORT, AND THIS LINE IS LOAD-BEARING.
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: false,
};

export default nextConfig;
