import type { Plugin } from 'vite';
import { THEME_BOOT_SCRIPT, themeBootAttributes, type ThemePaint } from './boot-paint';

/** FNV-1a, as eight hex digits: the content hash Vite's own names carry, which
 *  the hosts' caching reads as immutable (`isContentHashedName`). */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Puts the theme boot tag (`./boot-paint.ts`) first in an `index.html` app's
 * body, as a same-origin file under the build's assets directory: every such
 * app is served a `script-src` that refuses an inline script.
 */
export function themeBootPlugin(scope: string, fallback: ThemePaint, classes: readonly string[] = []): Plugin {
  const file = `theme-boot-${contentHash(THEME_BOOT_SCRIPT)}.js`;
  let assetPath = `assets/${file}`;
  let src = `/${assetPath}`;
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
        res.end(THEME_BOOT_SCRIPT);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: assetPath, source: THEME_BOOT_SCRIPT });
    },
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src, ...themeBootAttributes(scope, fallback, classes) }, injectTo: 'body-prepend' }];
    },
  };
}
