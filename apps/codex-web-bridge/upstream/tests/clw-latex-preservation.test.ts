import { expect, test } from "bun:test";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

const math = '<span class="katex"><span class="katex-mathml"><math><semantics><mrow>x2+y2</mrow><annotation encoding="application/x-tex">x^2+y^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2+y2</span></span>';

test("CLW rendered inline formula has one copy of its original TeX", () => {
  expect(chatGptHtmlToMarkdown(`<p>formula=${math}</p>`)).toBe(String.raw`formula=\(x^2+y^2\)`);
});

test("CLW display TeX keeps its environment, line breaks and one delimiter pair", () => {
  const tex = String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`;
  const html = `<span class="katex-display">${math.replace("x^2+y^2", tex.replaceAll("&", "&amp;"))}</span>`;
  expect(chatGptHtmlToMarkdown(html)).toBe(`\\[\n${tex}\n\\]`);
});

test("CLW unannotated formula remains visible and source code is unchanged", () => {
  expect(chatGptHtmlToMarkdown('<p><span class="katex">unannotated x</span></p>')).toBe('unannotated x');
  expect(chatGptHtmlToMarkdown('<pre><code>\\(x^2+y^2\\)</code></pre>')).toBe('```\n\\(x^2+y^2\\)\n```');
});
