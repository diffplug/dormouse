import type { ReactElement } from 'react';
import { $createParagraphNode, DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from 'lexical';
import { addExportVisitor$, addImportVisitor$, addLexicalNode$, addMdastExtension$, realmPlugin, type LexicalVisitor, type MdastExtension, type MdastImportVisitor } from '@mdxeditor/editor';

// MDXEditor parses `<!-- … -->` and drops it, so a save would delete every
// comment. These keep each one, verbatim, as an inline node.

type SerializedComment = SerializedLexicalNode & { text: string };
type CommentMdast = { type: 'comment'; value: string };

export class CommentNode extends DecoratorNode<ReactElement> {
  __text: string;
  static getType() { return 'dormouse-comment'; }
  static clone(node: CommentNode) { return new CommentNode(node.__text, node.__key); }
  static importJSON(json: SerializedComment) { return new CommentNode(json.text); }
  constructor(text: string, key?: NodeKey) { super(key); this.__text = text; }
  exportJSON(): SerializedComment { return { ...super.exportJSON(), type: CommentNode.getType(), version: 1, text: this.__text }; }
  createDOM() { const span = document.createElement('span'); span.className = 'md-comment'; return span; }
  updateDOM() { return false; }
  isInline() { return true; }
  getText() { return this.getLatest().__text; }
  decorate() { return <span title={this.__text}>{this.__text.length > 48 ? `${this.__text.slice(0, 44)}… -->` : this.__text}</span>; }
}

const $isCommentNode = (node: LexicalNode | null | undefined): node is CommentNode => node instanceof CommentNode;

// Registered after the core's own handlers, so these replace them.
const fromMarkdown = {
  canContainEols: ['comment'],
  // The buffer swallows the comment's data tokens; the node takes its source verbatim.
  enter: { comment(this: any) { this.buffer(); } },
  exit: { comment(this: any, token: any) { this.resume(); this.enter({ type: 'comment', value: this.sliceSerialize(token) }, token); this.exit(token); } },
} as unknown as MdastExtension;

const importVisitor = {
  testNode: 'comment',
  visitNode({ mdastNode, lexicalParent }: { mdastNode: CommentMdast; lexicalParent: LexicalNode }) {
    const node = new CommentNode(mdastNode.value);
    if (lexicalParent.getType() === 'root') (lexicalParent as any).append($createParagraphNode().append(node));
    else (lexicalParent as any).append(node);
  },
};

const exportVisitor: LexicalVisitor = {
  testLexicalNode: $isCommentNode,
  visitLexicalNode({ mdastParent, lexicalNode, actions }) {
    actions.appendToParent(mdastParent, { type: 'html', value: (lexicalNode as CommentNode).getText() });
  },
};

export const commentsPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addMdastExtension$]: fromMarkdown,
      [addImportVisitor$]: importVisitor as unknown as MdastImportVisitor<never>,
      [addLexicalNode$]: CommentNode,
      [addExportVisitor$]: exportVisitor,
    });
  },
});
