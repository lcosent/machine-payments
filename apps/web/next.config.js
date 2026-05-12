/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
  },
  // Allow workspace packages to be transpiled by Next.
  transpilePackages: ['@autocompute/types', '@autocompute/mpp-sim'],
};

export default config;
