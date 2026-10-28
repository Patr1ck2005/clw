'use strict';
const label=value=>String(value||'').trim().toLowerCase();
const effortKey=value=>({'low':'低','medium':'中','中等':'中','high':'高','extra high':'极高','extra-high':'极高','xhigh':'极高','instant':'即时'}[label(value)]||label(value));
// Public picker labels are localized independently on each conversation.
// Preserve the version/family; only the known Latest choice has two names.
const modelKey=value=>label(value).split(/\s*·\s*/).map(part=>part==='最新'?'latest':part).join(' · ');
const sameModel=(a,b)=>modelKey(a)===modelKey(b);
const sameEffort=(a,b)=>effortKey(a)===effortKey(b);
function availablePositions(model){
  const s=model.slider,choices=model.efforts;
  if(!s||![s.min,s.max,s.value].every(Number.isInteger)||s.min>s.value||s.value>s.max||s.max-s.min>32||!Array.isArray(choices)||choices.length!==s.max-s.min+1||choices.some(x=>typeof x.available!=='boolean'))throw Error('网页尚未提供完整的档位可用性，请等待模型菜单就绪。');
  return choices.filter(x=>x.available).map(x=>x.value);
}
module.exports={sameModel,sameEffort,availablePositions};
