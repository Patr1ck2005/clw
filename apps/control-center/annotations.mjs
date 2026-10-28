import {emptyAnnotations,validateAnnotations,setBinding,setGroup,MAX_BYTES} from './model.mjs';
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
/** Cooperative cross-tab serialized persistence, plus per-item optimistic guards.
 * No fallback to an unlocked read-modify-write: missing Locks blocks persistence,
 * not viewing, task exports or use of WebCodex. The lock is not backend authority.
 */
export function createAnnotationStore({key,snapshot,storage,locks,retainDetached=false}) {
  function raw(){return storage.getItem(key);}
  function decode(value){
    if(value==null)return emptyAnnotations(snapshot.runtime.id);
    if(typeof value!=='string'||new TextEncoder().encode(value).length>MAX_BYTES)throw Error('本地标注体积异常；原记录未覆盖');
    return validateAnnotations(JSON.parse(value),snapshot,{retainDetached});
  }
  function locked(action,isCurrent=()=>true){
    if(!locks||typeof locks.request!=='function')return Promise.reject(Error('浏览器不支持安全的多窗口保存锁；未写入，请保留草稿并换受支持浏览器。'));
    return locks.request(key,{mode:'exclusive'},()=>{
      if(!isCurrent())throw Error('数据源或编辑上下文已改变，未保存旧操作。');
      return action();
    });
  }
  function saveOne(kind,value,expected,isCurrent){
    return locked(()=>{
      const before=raw(),current=decode(before);
      const previous=kind==='binding'?current.bindings.find(b=>b.session_id===value.session_id):current.groups.find(g=>g.project_id===value.project_id);
      if(!same(previous,expected))throw Error('其他窗口已修改同一项；草稿保留，请关闭并重新核对后保存。');
      // New edits must reference an actually observed entity. Old labels can stay detached
      // when a paged live view changes; preserving metadata grants no authority.
      const next=kind==='binding'?setBinding(current,snapshot,value,{retainDetached}):setGroup(current,snapshot,value,{retainDetached});
      if(raw()!==before)throw Error('本地标注发生并发变化，未覆盖其他窗口。');
      // setItem is all-or-error; do not update UI state before the write succeeds.
      storage.setItem(key,JSON.stringify(next));return next;
    },isCurrent);
  }
  return {
    raw,
    read:()=>decode(raw()),
    saveBinding:(value,expected,isCurrent)=>saveOne('binding',value,expected,isCurrent),
    saveGroup:(value,expected,isCurrent)=>saveOne('group',value,expected,isCurrent),
    replace:(next,expectedRaw,isCurrent)=>locked(()=>{
      const validated=validateAnnotations(next,snapshot);
      if(raw()!==expectedRaw)throw Error('导入期间本地标注已改变，未覆盖新记录；请重新核对后导入。');
      storage.setItem(key,JSON.stringify(validated));return validated;
    },isCurrent)
  };
}
