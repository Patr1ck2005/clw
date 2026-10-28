'use strict';
// Adapted from pinned upstream markdown.ts; MIT notice retained in vendor.
const Turndown=require('turndown');const {gfm}=require('turndown-plugin-gfm');
const td=new Turndown({headingStyle:'atx',bulletListMarker:'-',codeBlockStyle:'fenced',fence:'```',emDelimiter:'*',strongDelimiter:'**',linkStyle:'inlined',preformattedCode:true});td.use(gfm);td.remove(['button','script','style','svg']);
const fencedCode=(code,language='')=>{const label=/^[\w+-]+$/.test(language.trim())?language.trim():'';const runs=code.match(/`+/g)||[];const fence='`'.repeat(Math.max(3,...runs.map(x=>x.length+1)));return `\n\n${fence}${label}\n${code.replace(/\n$/,'')}\n${fence}\n\n`;};
td.addRule('latex',{filter:node=>node.classList?.contains('katex-display')||(node.classList?.contains('katex')&&!node.parentElement?.closest('.katex-display')),replacement:(_content,node)=>{const math=node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;if(!math)return node.textContent||'';return node.classList.contains('katex-display')?`\n\n\\[\n${math}\n\\]\n\n`:`\\(${math}\\)`;}});
td.addRule('sourceCode',{filter:'pre',replacement:(_content,node)=>{const c=node.querySelector('code');const code=(c||node).textContent||'';const language=/language-([\w+-]+)/.exec(c?.getAttribute('class')||'')?.[1]||'';return fencedCode(code,language);}});
// ChatGPT's newer public code widget uses a labeled header and a code pane,
// without a <pre>. Its copy controls and header are not part of the code body.
td.addRule('chatgptCodeWidget',{filter:node=>node.nodeName==='DIV'&&node.getAttribute('data-markdown-copy')==='code-block'&&!!node.querySelector('[data-markdown-copy="exclude"] .truncate')&&!!node.querySelector('[class*="InlineCodePane-"] code'),replacement:(_content,node)=>{const label=node.querySelector('[data-markdown-copy="exclude"] .truncate').textContent||'';const code=node.querySelector('[class*="InlineCodePane-"] code').textContent||'';return fencedCode(code,label);}});
function markdown(html){if(typeof html!=='string'||Buffer.byteLength(html)>8*1024*1024)throw Error('public_result_exceeds_capture_bound');return td.turndown(html).trim();}
module.exports={markdown};
