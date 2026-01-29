/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@aramis/database', '@aramis/shared'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

module.exports = nextConfig;
