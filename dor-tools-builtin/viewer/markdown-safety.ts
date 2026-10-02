import { GenericHTMLNode, ImageNode, $isImageNode, realmPlugin, addExportVisitor$, type LexicalVisitor } from '@mdxeditor/editor';

// The page keeps 'unsafe-inline' scripts for the host's injected iframe shim,
// so document HTML must never reach the live DOM with its own attributes: an
// `onerror` there would run with the page's save and paste routes.

const SAFE_TAGS = new Set(['a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center',
  'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre',
  'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr']);
const SAFE_ATTRIBUTES = new Set(['abbr', 'align', 'alt', 'color', 'colspan', 'datetime', 'dir', 'face', 'headers', 'height',
  'lang', 'open', 'reversed', 'rowspan', 'scope', 'size', 'span', 'start', 'title', 'type', 'valign', 'width']);
const SAFE_HREF = /^(?:https?:|mailto:|#|[^:]*$)/i;

/** Renders an HTML element from the document through the allowlists above;
 * the node keeps every original attribute, so saving preserves them. */
function safeCreateDOM(this: GenericHTMLNode): HTMLElement {
  const tag = this.getTag().toLowerCase();
  const element = document.createElement(SAFE_TAGS.has(tag) ? tag : 'span');
  for (const attribute of this.getAttributes()) {
    if (attribute.type !== 'mdxJsxAttribute') continue;
    // A bare attribute such as `open` has a null value.
    const value = attribute.value ?? '';
    if (typeof value !== 'string') continue;
    const name = attribute.name.toLowerCase();
    if (SAFE_ATTRIBUTES.has(name) || (name === 'href' && SAFE_HREF.test(value.trim()))) element.setAttribute(name, value);
  }
  return element;
}
GenericHTMLNode.prototype.createDOM = safeCreateDOM;

// Elements of a document without a browsing context never load or run handlers.
const inert = document.implementation.createHTMLDocument('');

/** MDXEditor's image export builds its `<img>` in the live document, where a
 * `srcset` loads and fires the node's `onerror`; this one serializes in `inert`. */
const safeImageVisitor: LexicalVisitor = {
  priority: 1,
  testLexicalNode: $isImageNode,
  visitLexicalNode({ mdastParent, lexicalNode, actions }) {
    const node = lexicalNode as ImageNode & { shouldBeSerializedAsElement(): boolean };
    if (!node.shouldBeSerializedAsElement()) {
      actions.appendToParent(mdastParent, { type: 'image', url: node.getSrc(), alt: node.getAltText(), title: node.getTitle() });
      return;
    }
    const img = inert.createElement('img');
    if (node.getHeight() !== 'inherit') img.height = node.getHeight() as number;
    if (node.getWidth() !== 'inherit') img.width = node.getWidth() as number;
    if (node.getAltText()) img.alt = node.getAltText();
    if (node.getTitle()) img.title = node.getTitle()!;
    for (const attribute of node.getRest()) {
      if (attribute.type === 'mdxJsxAttribute' && typeof attribute.value === 'string') img.setAttribute(attribute.name, attribute.value);
    }
    // Set last, as MDXEditor writes it, so outerHTML escapes it with the rest.
    img.setAttribute('src', node.getSrc());
    actions.appendToParent(mdastParent, { type: 'html', value: img.outerHTML.replace(/>$/, ' />') });
  },
};

export const markdownSafetyPlugin = realmPlugin({
  init(realm) { realm.pub(addExportVisitor$, safeImageVisitor); },
});
