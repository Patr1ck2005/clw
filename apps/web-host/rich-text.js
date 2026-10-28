'use strict';
(function(scope){
  // Rendering is a local display operation. The original source remains owned
  // by WorkRecord and is the only value used for full-text copying.
  const MAX_SOURCE=256*1024,MAX_OUTPUT=2*1024*1024,MAX_MATH_SOURCE=8192,MAX_MATH_COUNT=128;
  let engines=null;
  if(typeof module==='object'&&module.exports){
    engines={markdownit:require('./assets/vendor/markdown-it/markdown-it.min.js'),
      katex:require('./assets/vendor/katex/katex.min.js'),texmath:require('./assets/vendor/markdown-it-texmath/texmath.js')};
  }
  const escape=text=>String(text??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const sourceMath=token=>{
    const open=token.markup||token.tag||(token.block?'$$':'$');
    return open+token.content+(open==='\\('? '\\)':open==='\\['?'\\]':open);
  };
  function parser(){
    const libraries=engines||scope;
    if(typeof libraries.markdownit!=='function'||typeof libraries.texmath!=='function'||typeof libraries.katex?.renderToString!=='function')return null;
    const md=libraries.markdownit({html:false,linkify:false,typographer:false,breaks:true,maxNesting:64});
    md.use(libraries.texmath,{engine:libraries.katex,delimiters:['dollars','brackets'],katexOptions:{trust:false}});
    // A price prefix must not consume the opening delimiter of a later
    // equation. Let the mature math rule handle numeric expressions; only
    // ordinary standalone currency amounts are emitted as text tokens here.
    md.inline.ruler.before('math_inline_double','clw_currency',(state,silent)=>{
      const rest=state.src.slice(state.pos),amount=/^\$[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/.exec(rest);
      if(!amount)return false;
      const suffix=/^(?:美元|人民币|美金|元|USD|CNY|RMB)(?=$|[\s,.;:!?，。；：！？、)])/i.exec(rest.slice(amount[0].length));
      const literal=amount[0]+(suffix?.[0]||''),after=rest.slice(literal.length),next=after.trimStart()[0];
      if(after[0]==='$'||(after[0]&&!/[\s,.;:!?，。；：！？、)]/.test(after[0]))||next&&/[+*/_=^<>\\-]/.test(next))return false;
      if(!silent)state.pending+=literal;state.pos+=literal.length;return true;
    });
    // Source links and image destinations are display text; reading a reply
    // never navigates the carrier, dispatches a command, or loads a resource.
    md.renderer.rules.link_open=()=>'<span class="rich-link-label">';
    md.renderer.rules.link_close=()=>'</span>';
    md.renderer.rules.image=(tokens,index)=>'<span class="rich-image-label">[图像：'+escape(md.renderer.renderInlineAsText(tokens[index].children||[],md.options,{}))+']</span>';
    md.renderer.rules.table_open=()=>'<div class="rich-table"><table>';
    md.renderer.rules.table_close=()=>'</table></div>';
    md.renderer.rules.fence=(tokens,index)=>{
      const token=tokens[index],language=String(token.info||'').trim().split(/\s+/)[0];
      return '<div class="rich-code-block"><div class="rich-code-label">'+escape(language||'代码')+'</div><pre><code>'+escape(token.content)+'</code></pre></div>';
    };
    let mathCount=0;
    const math=(tokens,index)=>{
      const token=tokens[index],display=token.block||token.type==='math_inline_double';
      let rendered;
      if(++mathCount>MAX_MATH_COUNT||token.content.length>MAX_MATH_SOURCE)rendered='<code class="math-source">'+escape(sourceMath(token))+'</code>';
      else{
        try{
          rendered=libraries.katex.renderToString(token.content,{displayMode:display,output:'htmlAndMathml',throwOnError:true,
            trust:false,maxExpand:1000,maxSize:20,strict:'ignore',globalGroup:false,macros:Object.create(null)});
        }catch{rendered='<code class="math-source">'+escape(sourceMath(token))+'</code>';}
      }
      if(!display)return '<span class="rich-math-inline">'+rendered+'</span>';
      const number=token.type==='math_block_eqno'?'<span class="rich-equation-number">('+escape(token.info||'')+')</span>':'';
      const tag=token.block?'div':'span';return '<'+tag+' class="rich-math-display">'+rendered+number+'</'+tag+'>';
    };
    for(const name of ['math_inline','math_inline_double','math_block','math_block_eqno'])md.renderer.rules[name]=math;
    return source=>{mathCount=0;return md.render(source).trim();};
  }
  function paint(target,text,{complete=true}={}){
    text=String(text??'');target.classList.add('rich-text');
    const plain=reason=>{target.dataset.renderFormat='plain';target.dataset.renderReason=reason;target.textContent=text;return {format:'plain',reason};};
    if(!complete)return plain('preview');
    if(text.length>MAX_SOURCE)return plain('source_bound');
    try{
      const render=parser();if(!render)return plain('dependency_unavailable');
      const html=render(text);if(html.length>MAX_OUTPUT)return plain('output_bound');
      // Only the pinned parser's escaped output and trusted KaTeX-generated
      // markup reach this sink. Raw HTML is disabled, resource renderers above.
      target.innerHTML=html;target.dataset.renderFormat='markdown';target.dataset.renderReason='';
      return {format:'markdown',reason:null};
    }catch{return plain('render_failed');}
  }
  const api={paint,limits:{source:MAX_SOURCE,output:MAX_OUTPUT,mathSource:MAX_MATH_SOURCE,mathCount:MAX_MATH_COUNT}};
  if(typeof module==='object'&&module.exports)module.exports=api;else scope.CLWRichText=api;
})(globalThis);
