import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const viewer = createRequire(new URL('../viewer/mermaid-block.tsx', import.meta.url));
const mermaid = createRequire(viewer.resolve('mermaid'));
const katex = mermaid('katex');

// Exercise Mermaid's resolved dependency and renderToString options: the
// scoped override crosses KaTeX's declared compatibility range.
for (const output of ['mathml', 'htmlAndMathml']) {
  test(`Mermaid's KaTeX renders fractions and superscripts as ${output}`, () => {
    const rendered = katex.renderToString(String.raw`\frac{1}{2} + x^2`, {
      throwOnError: true, displayMode: true, output,
    });
    assert.match(rendered, /<mfrac>/);
    assert.match(rendered, /<msup>/);
    assert.equal(rendered.includes('class="katex-html"'), output === 'htmlAndMathml');
  });

  test(`Mermaid's KaTeX rejects inherited trust in ${output} (GHSA-238p-pmpm-9mq7)`, () => {
    const expression = String.raw`\href{https://example.com/}{link}`;
    const options = { throwOnError: true, displayMode: true, output };
    const inherited = Object.assign(Object.create({ trust: true }), options);
    assert.doesNotMatch(katex.renderToString(expression, inherited), /href=/);
    assert.match(katex.renderToString(expression, { ...options, trust: true }), /href=/);
  });
}
