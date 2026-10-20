import type { NextConfig } from 'next';
import { checkDeploymentSettings } from './lib/settings';
import { SKILL_EXTENSION } from './lib/server/skill';

// A wrong setting stops the build with what to fix, instead of a page that does not load, refuses
// every swap, or runs without its fee (lib/settings.ts).
checkDeploymentSettings(process.env);

// The Content-Security-Policy for pages is set per request, with a nonce, in proxy.ts.
// API responses are JSON (and the skill's files) under nosniff.
const config: NextConfig = {
  transpilePackages: ['@orientim/builder', '@orientim/certificate', '@orientim/jupiter'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Next adds a hash to the script tags it writes, so a browser refuses those scripts when they are
  // altered in transit or at the edge. The pages add it to their own chunks from the manifest this
  // writes (lib/server/scriptIntegrity.ts); the browser test checks the coverage (SECURITY.md).
  experimental: { sri: { algorithm: 'sha384' } },
  // A build id that depends on the commit, not on the clock: two builds of the same source produce
  // the same output, which is what makes `tools/build-digest.ts` worth publishing. Vercel names the
  // commit itself, so a deploy of a tag builds what release.yml published for it.
  generateBuildId: () => process.env.ORIENTIM_BUILD_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'orientim',
  // The downloads this site served before @orientimhq/swap: the extension is now on the GitHub
  // release, and the skill comes with the package.
  async redirects() {
    return [
      { source: '/skill/orientim.mcpb', destination: SKILL_EXTENSION, permanent: false },
      { source: '/skill/:path*', destination: '/developers#start', permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // A site that opens Orientim keeps no handle to it (no reverse tabnabbing); a wallet's own
          // popup, opened from here, still works.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default config;
