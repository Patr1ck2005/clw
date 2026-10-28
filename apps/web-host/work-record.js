'use strict';
(function(scope){
  const rich=typeof module==='object'&&module.exports?require('./rich-text.js'):null;
  const paintText=(target,text,complete)=>{
    const renderer=scope.CLWRichText||rich;
    if(renderer?.paint)renderer.paint(target,text,{complete});else target.textContent=text;
  };
  function preview(text,limit=1900){
    text=String(text??'');
    if(text.length<=limit&&text.split('\n').length<=18)return text;
    const head=text.slice(0,1400).split('\n').slice(0,12).join('\n'),tail=text.slice(-350);
    // Copy the small result so substring backing storage cannot keep the original
    // long reply alive after the caller releases it.
    return (head+'\n\n… 已收起中间内容 …\n\n'+tail).split('').join('');
  }
  function body(text,{load=null,length=null,expanded=false,onToggle=()=>{},onBeforeLayout=()=>{},isCurrent=()=>true}={}){
    text=String(text??'');
    const total=Math.max(text.length,Number(length)||0),remote=typeof load==='function';
    if(remote)text=preview(text);
    if(!remote&&preview(text)===text){const e=document.createElement('div');e.className='text';paintText(e,text,true);return e;}
    const wrap=document.createElement('div');wrap.className='record-body';wrap.dataset.expanded=String(expanded);
    const content=document.createElement('div');content.className='text';
    const actions=document.createElement('div');actions.className='record-body-actions';
    const toggle=document.createElement('button');toggle.type='button';toggle.className='quiet record-body-toggle';
    const copy=document.createElement('button');copy.type='button';copy.className='quiet';copy.textContent='复制全文';
    const status=document.createElement('span');status.className='scope-hint';status.setAttribute('role','status');
    let full=remote?null:text,pending=null,open=expanded,disposed=false,version=0,lifecycle=0;const actionsPending=new Set(),paintWaits=new Set();
    const current=()=>!disposed&&isCurrent();
    const paint=()=>{paintText(content,open&&full!==null?full:preview(full??text),open&&full!==null);wrap.dataset.expanded=String(open);
      toggle.textContent=open?'收起全文':'展开全文'+(total&&(!remote||length!==null)?' · '+total.toLocaleString()+' 字符':'');toggle.setAttribute('aria-expanded',String(open));};
    const obtain=async()=>{
      if(!current())throw Error('正文读取已取消。');
      if(full!==null)return full;
      if(!pending){const expected=lifecycle;
        const request=Promise.resolve().then(()=>{if(!current()||expected!==lifecycle)throw Error('正文读取已取消。');return load();}).then(value=>{
          if(!current()||expected!==lifecycle)throw Error('正文读取已取消。');
          if(typeof value!=='string')throw Error('完整正文暂不可用。');full=value;return value;
        }).finally(()=>{if(pending===request)pending=null;});pending=request;
      }
      return pending;
    };
    const releaseClosed=()=>{if(remote&&!open&&!actionsPending.size)full=null;};
    const finishReading=node=>{node.disabled=false;node.classList.remove('interaction-pending');node.setAttribute('aria-busy','false');};
    const canPaint=()=>!(wrap.isConnected===false||!wrap.ownerDocument.documentElement.contains(wrap)||wrap.closest('[hidden], details:not([open])'));
    const showPendingFrame=()=>new Promise(resolve=>{
      const doc=wrap.ownerDocument,view=typeof scope.requestAnimationFrame==='function'?scope:doc.defaultView||scope.window||scope;
      let frame=null,timer=null,done=false;
      const finish=()=>{if(done)return;done=true;if(frame!==null)view.cancelAnimationFrame?.(frame);scope.clearTimeout(timer);
        doc.removeEventListener('visibilitychange',visibilityChanged);paintWaits.delete(finish);resolve();};
      const visibilityChanged=()=>{if(doc.hidden)finish();};
      paintWaits.add(finish);
      if(doc.hidden||typeof view.requestAnimationFrame!=='function'){timer=scope.setTimeout(finish,0);return;}
      doc.addEventListener('visibilitychange',visibilityChanged);
      // One rAF resumes its promise before paint. Two let the pending controls
      // appear before synchronous Markdown/DOM work; the timer also bounds
      // throttled or suspended frame delivery.
      timer=scope.setTimeout(finish,120);
      frame=view.requestAnimationFrame(()=>{frame=view.requestAnimationFrame(finish);});
    });
    const cancelPaintWaits=()=>{for(const finish of paintWaits)finish();};
    const collapse=()=>{onBeforeLayout();version++;lifecycle++;open=false;pending=null;actionsPending.clear();cancelPaintWaits();if(remote)full=null;status.textContent='';
      finishReading(toggle);finishReading(copy);paint();onToggle(false);};
    toggle.onclick=async()=>{
      if(!current())return;const request=++version;
      if(open){collapse();return;}
      const action={};actionsPending.add(action);
      toggle.disabled=true;toggle.classList.add('interaction-pending');toggle.setAttribute('aria-busy','true');status.textContent=remote&&full===null?'正在读取正文…':'';
      try{await obtain();if(!current()||request!==version)return;
        if(full.length>16000){
          if(!canPaint()){status.textContent='';return;}
          status.textContent='正在展开正文…';await showPendingFrame();if(!current()||request!==version)return;
          if(!canPaint()){status.textContent='';return;}
        }
        onBeforeLayout();open=true;status.textContent='';paint();onToggle(true);}
      catch(error){if(current()&&request===version)status.textContent=String(error.message||error);}
      finally{actionsPending.delete(action);releaseClosed();if(current()&&request===version)finishReading(toggle);}
    };
    copy.onclick=async()=>{
      if(!current())return;const expected=lifecycle,action={};actionsPending.add(action);
      copy.disabled=true;copy.classList.add('interaction-pending');copy.setAttribute('aria-busy','true');status.textContent='正在读取并复制全文…';
      try{const value=await obtain();if(!current()||expected!==lifecycle)return;
        if(scope.window?.clw?.command)await scope.window.clw.command('copy-record-text',{text:value});
        else await scope.navigator.clipboard.writeText(value);if(current()&&expected===lifecycle)status.textContent='已复制全文';}
      catch{if(current()&&expected===lifecycle)status.textContent='复制未完成，请展开后选取正文。';}
      finally{actionsPending.delete(action);releaseClosed();if(current()&&expected===lifecycle)finishReading(copy);}
    };
    wrap.collapse=collapse;
    wrap.dispose=()=>{disposed=true;version++;lifecycle++;open=false;pending=null;actionsPending.clear();cancelPaintWaits();full=null;text='';content.textContent='';};
    wrap.expand=()=>{if(!open)return toggle.onclick();};
    paint();actions.append(toggle,copy,status);wrap.append(content,actions);
    if(expanded&&remote){open=false;paint();void toggle.onclick();}
    return wrap;
  }
  function message(label,text,bodyOptions){
    const row=document.createElement('div');row.className='message';
    const meta=document.createElement('div');meta.className='message-meta';
    const name=document.createElement('strong');name.textContent=label;meta.append(name);
    row.append(meta,body(text,bodyOptions));return row;
  }
  function tools(container,rows,{empty='当前日志窗口没有可展示的工具调用。',note='',renderDetails=null}={}){
    const oldMore=container.querySelector?.('.mcp-activity-more');
    const expanded=oldMore?oldMore.open:container.dataset?.moreExpanded==='true';
    container.replaceChildren();
    if(!rows.length){const p=document.createElement('p');p.className='scope-hint';p.textContent=empty;container.append(p);}
    const list=document.createElement('ol');list.className='mcp-activity-list';
    const more=document.createElement('details'),summary=document.createElement('summary'),older=document.createElement('ol');
    more.className='mcp-activity-more';older.className='mcp-activity-list';summary.textContent='展开其余 '+Math.max(0,rows.length-12)+' 次近期调用';more.append(summary,older);
    const appendRows=(target,items)=>{for(const row of items){
      const item=document.createElement('li');if(row.phase)item.dataset.phase=row.phase;
      const name=document.createElement('strong');name.textContent=row.tool;
      const status=document.createElement('span');status.textContent=row.status;
      const detail=document.createElement('small');detail.textContent=row.detail;
      item.append(name,status,detail);if(renderDetails)renderDetails(item,row);target.append(item);
    }};
    appendRows(list,rows.slice(0,12));
    let mounted=false;more.addEventListener('toggle',()=>{if(container.dataset)container.dataset.moreExpanded=String(more.open);if(more.open&&!mounted){mounted=true;appendRows(older,rows.slice(12));}else if(!more.open){mounted=false;older.replaceChildren();}});
    if(expanded){more.open=true;mounted=true;appendRows(older,rows.slice(12));}
    if(rows.length)container.append(list);if(rows.length>12)container.append(more);
    if(note){const p=document.createElement('p');p.className='scope-hint';p.textContent=note;container.append(p);}
  }
  const api={body,message,tools,preview};if(typeof module!=='undefined')module.exports=api;else scope.CLWWorkRecord=api;
})(globalThis);
