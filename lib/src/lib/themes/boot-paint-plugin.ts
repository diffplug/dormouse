import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { themeBootPaint } from './apply';
import { themeBootScript, type ThemePaintProfile } from './boot-paint';

/**
 * Puts the theme boot tag (`./boot-paint.ts`) first in an `index.html` app's
 * body, as a same-origin file under the build's assets directory: every such
 * app is served a `script-src` that refuses an inline script. The profile's
 * default rides in the file, which is cached immutable, not in the HTML.
 */
export function themeBootPlugin(profile: ThemePaintProfile): Plugin {
  const code = themeBootScript(themeBootPaint(profile), profile.classes);
  // Eight url-safe characters, the content hash Vite's own names carry and
  // the hosts' caching reads as immutable (`isContentHashedName`).
  const file = `theme-boot-${createHash('sha256').update(code).digest('base64url').slice(0, 8)}.js`;
  let assetPath: string;
  let src: string;
  return {
    name: 'dormouse-theme-boot',
    configResolved(config) {
      assetPath = `${config.build.assetsDir}/${file}`;
      src = `${config.base}${assetPath}`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== src) return next();
        res.setHeader('content-type', 'text/javascript');
        res.end(code);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: assetPath, source: code });
    },
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src }, injectTo: 'body-prepend' }];
    },
  };
}
