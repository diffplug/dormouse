import { LinkNode } from '@lexical/link';
import { markdownLink } from '../src/markdown-links';

// Lexical formats bare filenames as https:// links even though their stored
// URL is relative. Preserve validated document references for rendering and
// the link dialog, leaving its scheme sanitizer in charge of every other URL.
const sanitizeLink = LinkNode.prototype.sanitizeUrl;
export function sanitizeLinkUrl(this: LinkNode, url: string): string {
  return markdownLink(url) ? url : sanitizeLink.call(this, url);
}
LinkNode.prototype.sanitizeUrl = sanitizeLinkUrl;
