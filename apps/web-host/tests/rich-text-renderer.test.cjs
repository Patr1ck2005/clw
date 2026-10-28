'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createWindow}=require('../node_modules/@mixmark-io/domino');
const rich=require('../rich-text.js'),record=require('../work-record.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function dom(run){
  const previousDocument=global.document,previousWindow=global.window,w=createWindow('<div id="root"></div>'),commands=[];
  global.document=w.document;global.window={clw:{command:async(action,payload)=>{commands.push({action,payload});}}};
  for(const name of ['append','replaceChildren'])if(!w.Element.prototype[name])w.Element.prototype[name]=function(...items){if(name==='replaceChildren')while(this.firstChild)this.removeChild(this.firstChild);for(const item of items)this.appendChild(item);};
  if(!('dataset' in w.Element.prototype))Object.defineProperty(w.Element.prototype,'dataset',{get(){const attr=key=>'data-'+key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());return new Proxy({},{get:(_,key)=>this.getAttribute(attr(key)),set:(_,key,value)=>{this.setAttribute(attr(key),value);return true;}});}});
  try{await run(w.document.getElementById('root'),commands,w);}finally{global.document=previousDocument;if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}
}
const annotations=root=>Array.from(root.querySelectorAll('annotation[encoding="application/x-tex"]')).map(node=>node.textContent);
const copyButton=root=>Array.from(root.querySelectorAll('button')).find(node=>node.textContent==='复制全文');

test('pinned parser renders real Markdown structure while code retains literal TeX and HTML',()=>dom(root=>{
  const source='# 科研笔记\n\n**定义**与 `\\(literal\\)`。\n\n- 项目一\n- 项目二\n\n> 引用\n\n| 名称 | 数值 |\n| --- | --- |\n| 系数 | 1 |\n\n```html\n<script>alert(1)</script>\n$$x^2$$\n```';
  assert.equal(rich.paint(root,source).format,'markdown');
  assert.equal(root.querySelector('h1').textContent,'科研笔记');assert.equal(root.querySelector('strong').textContent,'定义');
  assert.equal(root.querySelectorAll('li').length,2);assert.equal(root.querySelectorAll('table').length,1);assert.ok(root.querySelector('blockquote'));
  assert.match(root.querySelector('pre code').textContent,/<script>alert\(1\)<\/script>\n\$\$x\^2\$\$/);assert.equal(root.querySelectorAll('.katex').length,0);assert.equal(root.querySelectorAll('script').length,0);
}));

test('dollar and bracket delimiters render together in paragraphs, tables and display blocks',()=>dom(root=>{
  const source='行内 $x^2$ 与 \\(a+b\\)。\n\n$$\\frac{1}{2}$$\n\n\\[\n\\sum_{n=1}^{N} n = \\frac{N(N+1)}{2}\n\\]\n\n| 量 | 表达式 |\n| --- | --- |\n| 能量 | $E=mc^2$ |';
  assert.equal(rich.paint(root,source).format,'markdown');
  assert.equal(root.querySelectorAll('.katex').length,5);assert.equal(root.querySelectorAll('.rich-math-display').length,2);
  assert.deepEqual(annotations(root),['x^2','a+b','\\frac{1}{2}','\n\\sum_{n=1}^{N} n = \\frac{N(N+1)}{2}\n','E=mc^2']);
  rich.paint(root,'文字 $$x^2$$ 后续。');assert.equal(root.querySelectorAll('.katex').length,1);assert.equal(root.querySelector('.rich-math-display').tagName,'SPAN');assert.match(root.textContent,/后续/);
}));

test('ordinary prices, escaped dollars and code do not become equations',()=>dom(root=>{
  const source='价格 $5 与 $10，预算 $20。公式 $x+1$。\n\n转义 \\$x\\$ 与代码 `$a$`。';
  rich.paint(root,source);assert.deepEqual(annotations(root),['x+1']);
  assert.match(root.textContent,/\$5 与 \$10，预算 \$20/);assert.equal(root.querySelector('code').textContent,'$a$');
  rich.paint(root,'价格 $1,000.50 and $20; 数值 $1 + 2$、$2x$、$1/2$、$-5$ 与 \\(5\\)。');
  assert.deepEqual(annotations(root),['1 + 2','2x','1/2','-5','5']);assert.match(root.textContent,/\$1,000.50 and \$20/);
  rich.paint(root,'价格 $5.99美元 与 $10美元，公式 $x+1$。');
  assert.deepEqual(annotations(root),['x+1']);assert.equal(root.querySelectorAll('.math-source').length,0);
  assert.match(root.textContent,/\$5\.99美元 与 \$10美元，公式/);
  rich.paint(root,'金额 $12元、$500人民币、$20USD，公式 $2x$、$1+2$、$1/2$。');
  assert.deepEqual(annotations(root),['2x','1+2','1/2']);assert.equal(root.querySelectorAll('.math-source').length,0);
  assert.match(root.textContent,/\$12元、\$500人民币、\$20USD/);
}));

test('raw model HTML is visible text and reply destinations never become executable links or images',()=>dom(root=>{
  const source='<script>globalThis.pwned=1</script>\n<img src="https://example.invalid/track" onerror="pwned()">\n<svg onload="pwned()"></svg>\n\n[正常引用](https://example.invalid/a) ![图注](https://example.invalid/pixel.png) [坏](javascript:alert(1))';
  rich.paint(root,source);assert.equal(root.querySelectorAll('script,img,svg,iframe,a').length,0);
  assert.equal(root.querySelectorAll('[href],[src],[onload],[onerror]').length,0);assert.match(root.textContent,/<script>/);assert.match(root.textContent,/正常引用/);assert.match(root.textContent,/图注/);
}));

test('untrusted math cannot create resource URLs, arbitrary styles or active HTML even through parse errors',()=>dom(root=>{
  const source=['\\href{javascript:alert(1)}{x}','\\includegraphics{https://example.invalid/a.png}',
    '\\htmlStyle{position:fixed;inset:0}{x}','\\url{https://example.invalid/tracker}',
    '\\unknown{<img src=x onerror=alert(1)>}'].map(tex=>'\\('+tex+'\\)').join('\n\n');
  rich.paint(root,source);assert.equal(root.querySelectorAll('a,img,script,iframe,[href],[src],[onerror]').length,0);
  assert.equal(root.querySelectorAll('[style*="position:fixed"]').length,0);assert.ok(root.querySelector('.math-source'));assert.match(root.textContent,/unknown/);
}));

test('macro definitions remain local to one equation and failed expressions preserve source safely',()=>dom(root=>{
  rich.paint(root,'$\\gdef\\clwPrivate{x}\\clwPrivate$\n\n$\\clwPrivate$\n\n$\\undefined{<script>} $');
  assert.equal(root.querySelectorAll('.katex').length,1);assert.match(root.querySelector('.math-source').textContent,/\\clwPrivate/);assert.equal(root.querySelectorAll('script').length,0);
  rich.paint(root,'$\\clwPrivate$');assert.equal(root.querySelectorAll('.katex').length,0);assert.match(root.textContent,/\\clwPrivate/);
}));

test('rendering limits keep complete large source readable and bound expression count, macro loops and dimensions',()=>dom(root=>{
  const huge='首部 $$x^2$$\n'+'x'.repeat(rich.limits.source+1)+'\n尾部';
  assert.deepEqual(rich.paint(root,huge),{format:'plain',reason:'source_bound'});assert.equal(root.textContent,huge);assert.equal(root.querySelectorAll('.katex').length,0);
  rich.paint(root,Array.from({length:rich.limits.mathCount+3},()=>'$x$').join(' '));assert.equal(root.querySelectorAll('.katex').length,rich.limits.mathCount);assert.equal(root.querySelectorAll('.math-source').length,3);
  rich.paint(root,'$\\def\\loop{\\loop}\\loop$');assert.equal(root.querySelectorAll('.katex').length,0);assert.match(root.textContent,/loop/);
  rich.paint(root,'$\\rule{999999em}{999999em}$');assert.ok(!root.innerHTML.includes('999999em;'));assert.ok(root.querySelector('.katex'));
}));

test('incomplete previews stay exact plain text without invoking any Markdown or TeX library',()=>dom(root=>{
  const context={globalThis:null};context.globalThis=context;let calls=0;
  context.markdownit=()=>{calls++;throw Error('must not render a preview');};
  context.katex={renderToString(){calls++;}};context.texmath=()=>{};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../rich-text.js'),'utf8'),context);
  const preview='**start** \\[x\n… 已收起中间内容 …\n\\] <img src=x>';
  assert.deepEqual(JSON.parse(JSON.stringify(context.CLWRichText.paint(root,preview,{complete:false}))),{format:'plain',reason:'preview'});
  assert.equal(root.textContent,preview);assert.equal(calls,0);assert.equal(root.querySelectorAll('img,.katex,strong').length,0);
  delete context.markdownit;assert.equal(context.CLWRichText.paint(root,preview).reason,'dependency_unavailable');assert.equal(root.textContent,preview);
}));

test('remote rich replies render only exact full source and copying always uses unmodified Markdown and TeX',()=>dom(async(root,commands)=>{
  const full='# 原始全文\n\n$E=mc^2$\n\n'+'普通段落。\n\n'.repeat(280)+'\n\\[\\frac{a}{b}\\]';let reads=0;
  const control=record.body(record.preview(full),{length:full.length,load:()=>{reads++;return full;}});root.append(control);
  assert.equal(control.querySelector('.text').dataset.renderFormat,'plain');assert.equal(reads,0);assert.equal(control.querySelectorAll('.katex').length,0);
  await control.expand();assert.equal(reads,1);assert.equal(control.querySelectorAll('.katex').length,2);assert.equal(control.querySelector('h1').textContent,'原始全文');
  await copyButton(control).onclick();assert.deepEqual(commands,[{action:'copy-record-text',payload:{text:full}}]);
  control.collapse();assert.equal(control.querySelectorAll('.katex,h1').length,0);assert.equal(control.querySelector('.text').dataset.renderFormat,'plain');
  await copyButton(control).onclick();assert.equal(reads,2);assert.equal(control.querySelectorAll('.katex').length,0);assert.equal(commands.at(-1).payload.text,full);
  control.dispose();assert.equal(control.querySelector('.text').textContent,'');assert.equal(control.querySelectorAll('.katex').length,0);
}));

test('a disposed or foreign-owner rich-body read cannot paint or copy late source',()=>dom(async(root,commands)=>{
  for(const invalidate of ['dispose','owner']){
    let finish,current=true;const control=record.body('saved preview',{length:3000,isCurrent:()=>current,load:()=>new Promise(resolve=>{finish=resolve;})});root.append(control);
    const expanded=control.expand(),copied=copyButton(control).onclick();await flush();
    if(invalidate==='dispose')control.dispose();else current=false;
    finish('# Late owner\n\n$E=mc^2$');await Promise.all([expanded,copied]);
    assert.equal(control.querySelectorAll('h1,.katex').length,0);assert.deepEqual(commands,[]);control.dispose();
  }
}));

test('twelve two-million-character remote replies keep only plain previews without eager parsing, reads or copying',()=>dom(async(root,commands)=>{
  let reads=0;const originals=new Map();
  for(let index=0;index<12;index++){
    const key='reply-'+index,full='# '+key+'\n\n\\[\\frac{x}{y}\\]\n'+'x'.repeat(2000000)+'\n\\[\\sum_n n\\]';originals.set(key,full);
    root.append(record.message(key,full,{length:full.length,load:()=>{reads++;return originals.get(key);}}));
  }
  assert.equal(reads,0);assert.deepEqual(commands,[]);assert.equal(root.querySelectorAll('.message').length,12);
  assert.equal(root.querySelectorAll('.katex,h1').length,0);
  const content=Array.from(root.querySelectorAll('.text'));assert.ok(content.every(node=>node.dataset.renderFormat==='plain'&&node.textContent.length<2000));
  assert.ok(content.reduce((total,node)=>total+node.textContent.length,0)<24000);
  const first=root.querySelector('.record-body');await first.expand();assert.equal(reads,1);
  assert.equal(first.querySelector('.text').dataset.renderReason,'source_bound');assert.equal(first.querySelector('.text').textContent,originals.get('reply-0'));
  await copyButton(first).onclick();assert.equal(commands[0].payload.text,originals.get('reply-0'));
  first.collapse();assert.equal(first.querySelectorAll('.katex,h1').length,0);assert.ok(first.querySelector('.text').textContent.length<2000);
  for(const control of root.querySelectorAll('.record-body'))control.dispose();assert.equal(root.querySelectorAll('.text').length,12);assert.equal(root.textContent.includes('x'.repeat(100)),false);
}));

test('isolated browser renders offline math fonts, responsive structure and exact full-source copying under the production CSP',async()=>{
  const {chromium}=require('../node_modules/playwright-core'),output=path.resolve('.local/product-control-20261006/rich-regression'),host=path.resolve(__dirname,'..');
  fs.mkdirSync(output,{recursive:true});
  const fileURL=file=>'file:///'+file.replaceAll('\\','/'),source='# 网页式回复\n\n**数学公式**、表格与代码在同一段回复中保持自然排版。行内 \\(E=mc^2\\)，价格 $5 和 $10 不变。\n\n\\[\n\\int_0^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n\\]\n\n$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\binom{x}{y}=\\binom{u}{v}$$\n\n| 内容 | 显示方式 |\n| --- | --- |\n| 公式 | $\\alpha+\\beta=1$ |\n| 代码 | 保留原始语法 |\n\n```python\n# $x$ 与 \\(y\\) 在代码中保持原样\nenergy = mass * c**2\n```\n\n> 复制全文得到原始 Markdown 和 LaTeX。';
  const csp=fs.readFileSync(path.join(host,'index.html'),'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const sourceHashes=()=>Object.fromEntries(['rich-text.js','rich-text.css','work-record.js'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(host,name))).digest('hex')])),frozenSources=sourceHashes();
  const styles=['shell.css','assets/vendor/katex/katex-swap.min.css','rich-text.css'].map(name=>'<link rel="stylesheet" href="'+fileURL(path.join(host,name))+'">').join('');
  const scripts=['assets/vendor/markdown-it/markdown-it.min.js','assets/vendor/katex/katex.min.js','assets/vendor/markdown-it-texmath/texmath.js','rich-text.js','work-record.js'].map(name=>'<script src="'+fileURL(path.join(host,name))+'"></script>').join('');
  fs.writeFileSync(path.join(output,'fixture.css'),'body{display:block;height:auto;overflow:auto}.fixture{width:min(760px,calc(100vw - 40px));margin:30px auto}.fixture .text{font:15px/1.8 system-ui,sans-serif}.fixture>.scope-hint{margin-bottom:24px}');
  const full='# 完整原文\n\n$E=mc^2$\n\n'+'只读渲染，不连接现场。\n\n'.repeat(180)+'\\[\\frac{a}{b}\\]';
  fs.writeFileSync(path.join(output,'fixture.js'),'window.copyCommands=[];window.clw={command:async(action,payload)=>{copyCommands.push({action,payload});return {copied:true};}};'+
    'CLWRichText.paint(document.getElementById("reply"),'+JSON.stringify(source)+');'+
    'window.exactFull='+JSON.stringify(full)+';document.getElementById("remote").append(CLWWorkRecord.body(CLWWorkRecord.preview(exactFull),{length:exactFull.length,load:()=>exactFull}));');
  fs.writeFileSync(path.join(output,'fixture.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+csp+'">'+styles+'<link rel="stylesheet" href="fixture.css"></head><body><main class="fixture"><p class="scope-hint">隔离预览 · 离线组件 · 不连接现场</p><div id="reply" class="text"></div><div id="remote"></div></main>'+scripts+'<script src="fixture.js"></script></body></html>');
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1060}}),errors=[],failed=[],external=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('requestfailed',request=>failed.push(request.url()));
    await page.route('**/*',route=>{if(route.request().url().startsWith('file:'))return route.continue();external.push(route.request().url());return route.abort();});
    await page.goto(fileURL(path.join(output,'fixture.html')));await page.locator('#reply .katex').first().waitFor();
    await page.evaluate(()=>document.fonts.ready);assert.equal(await page.locator('#reply .katex').count(),4);
    assert.equal(await page.locator('#reply pre code').count(),1);assert.equal(await page.locator('#reply table').count(),1);
    assert.equal(await page.locator('#remote .katex').count(),0);assert.equal(await page.locator('#remote .text').getAttribute('data-render-format'),'plain');
    for(const width of [1440,430]){
      await page.setViewportSize({width,height:1060});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await page.screenshot({path:path.join(output,'rich-replies-dark-'+width+'.png'),fullPage:true});
      await page.locator('#reply').screenshot({path:path.join(output,'rich-display-dark-'+width+'.png')});
    }
    await page.evaluate(()=>document.body.classList.add('light'));await page.setViewportSize({width:1440,height:1060});
    await page.screenshot({path:path.join(output,'rich-replies-light-1440.png'),fullPage:true});
    await page.locator('#reply').screenshot({path:path.join(output,'rich-display-light-1440.png')});
    await page.locator('#remote .record-body-toggle').click();assert.equal(await page.locator('#remote .katex').count(),2);
    await page.locator('#remote button').filter({hasText:'复制全文'}).click();
    assert.equal(await page.evaluate(()=>copyCommands[0].action==='copy-record-text'&&copyCommands[0].payload.text===exactFull),true);
    await page.locator('#remote .record-body-toggle').click();assert.equal(await page.locator('#remote .katex').count(),0);
    await page.setViewportSize({width:430,height:1060});await page.evaluate(()=>{
      const wide=document.createElement('div');wide.id='wide';wide.className='text';document.querySelector('.fixture').append(wide);
      CLWRichText.paint(wide,'\\[a'+('+a'.repeat(70))+'\\]\n\n```text\n'+('long_code_'.repeat(100))+'\n```');
    });
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.equal(await page.locator('#wide .rich-math-display').evaluate(node=>node.scrollWidth>node.clientWidth),true);
    assert.equal(await page.locator('#wide pre').evaluate(node=>node.scrollWidth>node.clientWidth),true);
    assert.equal(await page.evaluate(()=>Array.from(document.fonts).some(font=>font.status==='loaded'&&font.family.startsWith('KaTeX_'))),true);
    assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);assert.deepEqual(external,[]);
    assert.deepEqual(sourceHashes(),frozenSources);
    fs.writeFileSync(path.join(output,'browser-validation.json'),JSON.stringify({scope:'Isolated headless file fixture, production CSP, pinned local assets; no original GUI/profile/auth/network or model sends.',widths:[1440,430],themes:['dark','light'],formula_count:4,loaded_local_math_fonts:true,raw_copy_exact:true,wide_math_and_code_scroll_inside:true,source_sha256:frozenSources,csp,failed_requests:failed,external_requests:external,page_errors:errors},null,2)+'\n');
  }finally{await browser.close();}
});
