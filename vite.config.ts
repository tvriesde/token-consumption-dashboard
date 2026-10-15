import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

// SITE_PUBLIC_DIR / SITE_OUT_DIR let the test-data pipeline build isolated sites per scope.
function inlineDashboardData(): Plugin {
  const dataDir = path.resolve(process.env.SITE_PUBLIC_DIR ?? 'public', 'data');
  const data: Record<string, unknown> = {};
  const addJsonFiles = (dir: string, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) addJsonFiles(fullPath, relative);
      else if (entry.isFile() && entry.name.endsWith('.json')) data[relative] = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    }
  };
  addJsonFiles(dataDir);

  return {
    name: 'inline-dashboard-data',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const json = JSON.stringify(data).replace(/</g, '\\u003c');
        return html.replace('</head>', `<script id="dashboard-data" type="application/json">${json}</script>\n  </head>`);
      },
    },
  };
}

function inlineBuildAssets(): Plugin {
  const assetName = (url: string) => decodeURIComponent(url.split(/[?#]/, 1)[0]).replace(/^\.?\//, '');
  return {
    name: 'inline-build-assets',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(process.env.SITE_OUT_DIR ?? 'dist');
      const htmlPath = path.join(outDir, 'index.html');
      if (!fs.existsSync(htmlPath)) throw new Error(`The built page was not found at ${htmlPath}.`);
      let html = fs.readFileSync(htmlPath, 'utf8');

      html = html.replace(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*><\/script>/g, (_tag, url: string) => {
        const assetPath = path.join(outDir, ...assetName(url).split('/'));
        if (!fs.existsSync(assetPath)) throw new Error(`Could not inline JavaScript asset ${url}.`);
        return `<script type="module">\n${fs.readFileSync(assetPath, 'utf8')}\n</script>`;
      });
      html = html.replace(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*\/?>/g, (_tag, url: string) => {
        const assetPath = path.join(outDir, ...assetName(url).split('/'));
        if (!fs.existsSync(assetPath)) throw new Error(`Could not inline stylesheet asset ${url}.`);
        return `<style>\n${fs.readFileSync(assetPath, 'utf8')}\n</style>`;
      });

      if (/<(?:script|link)\b[^>]*(?:src|href)=["'][^"']+\.(?:js|css)(?:[?#][^"']*)?["']/i.test(html))
        throw new Error('The generated page still references an external JavaScript or CSS file.');

      fs.writeFileSync(htmlPath, html);
      fs.rmSync(path.join(outDir, 'assets'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: process.env.SITE_PUBLIC_DIR ?? 'public',
  // Primer CSS uses @custom-media; tell the CSS minifier about it.
  css: { lightningcss: { drafts: { customMedia: true } } },
  build: {
    outDir: process.env.SITE_OUT_DIR ?? 'dist',
    emptyOutDir: true,
    copyPublicDir: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 1500,
  },
  plugins: [inlineDashboardData(), inlineBuildAssets()],
  server: {
    port: Number(process.env.PORT ?? 5173),
  },
});
