'use strict';
// Serialized into the owned page. Inspect only rendered public controls.
// The application supplies task authority; page text never grants authority.
function publicApproval(action='inspect',expected={}) {
  const visible=e=>!!e&&!e.closest('[hidden],[inert],[aria-hidden="true"]')&&!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
  const text=e=>String(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const label=e=>{
    const clone=e.cloneNode(true);for(const k of clone.querySelectorAll('kbd,[aria-hidden="true"],[data-testid="keyboard-shortcut"]'))k.remove();
    return text(clone).replace(/\s*(?:⏎|↵|Enter|Esc|Escape|回车|回車)\s*$/i,'').trim();
  };
  const all=[...document.querySelectorAll('button')].filter(visible);
  const once=e=>/^(Allow(?: once)?|允许一次|僅允許一次|仅允许一次)$/i.test(label(e));
  const remember=e=>/^(Always allow|Allow always|始终允许|始終允許|始终允許)$/i.test(label(e));
  const deny=e=>/^(Deny|拒绝|拒絕)$/i.test(label(e));
  const users=[...document.querySelectorAll('[data-user-message-bubble],[data-message-author-role="user"]')];
  const user=users.at(-1),searchGroup=user?.closest('[data-content-search-turn-key]'),group=user?.closest('[data-turn-key]');
  // Use the same logical user identity as page-dom's task snapshot. Grouped
  // renderers have a role-scoped key; a nested message UUID is a different ID.
  let userId='';
  if(searchGroup){
    const key=searchGroup.getAttribute('data-content-search-turn-key');
    const units=[...searchGroup.querySelectorAll('[data-content-search-unit-key]')].filter(unit=>{
      const value=unit.getAttribute('data-content-search-unit-key')||'';
      return unit.closest('[data-content-search-turn-key]')===searchGroup&&value.startsWith(`${key}:`)&&value.endsWith(':user')&&!!unit.querySelector('[data-user-message-bubble]');
    });
    const unitKey=units.at(-1)?.getAttribute('data-content-search-unit-key');
    if(unitKey)userId=`group:user:${unitKey}`;
  }else if(group)userId=`group:user:${group.getAttribute('data-turn-key')}`;
  else{
    const turn=user?.closest('[data-testid^="conversation-turn-"]')||user?.closest('[data-turn-id],[data-message-id]');
    userId=turn?.getAttribute('data-turn-id')||turn?.getAttribute('data-message-id')||turn?.querySelector('[data-message-id]')?.getAttribute('data-message-id')||'';
  }
  // Search fallback keys are viewport ordinals. Use page-dom's unique exact
  // task marker identity, while retaining the old opaque journal signature.
  if(/^fallback-turn-/.test(searchGroup?.getAttribute('data-content-search-turn-key')||'')){
    // Collapsed long user bubbles clip innerText, while page-dom binds the
    // original turn using textContent. Display controls still use visible text;
    // only the existing user identity reads the same complete bubble as snapshot.
    const identityText=e=>String(e?.textContent||'').replace(/\s+/g,' ').trim();
    const body=identityText(user),markers=[...body.matchAll(/\[CLW:(control_[0-9a-f]{32})\]/g)];
    const marker=markers.length===1&&/^(?:\s|…|\.{3}|Show more|显示更多|展开)*$/i.test(body.slice(markers[0].index+markers[0][0].length))?markers[0][0]:null;
    const bubbles=[...new Set(users.map(e=>e.matches('[data-user-message-bubble]')?e:e.querySelector('[data-user-message-bubble]')||e))];
    if(marker&&bubbles.filter(e=>identityText(e).includes(marker)).length===1)userId=`managed-public:${marker}:user`;
  }
  // Preserve the old opaque card signature so a prior unknown click receipt
  // remains the same journal entry after this identity correction.
  const receiptTurn=user?.closest('[data-turn-key],[data-turn-id],[data-message-id],[data-testid^="conversation-turn-"]');
  const receiptUserId=receiptTurn?.getAttribute('data-turn-key')||receiptTurn?.getAttribute('data-turn-id')||receiptTurn?.getAttribute('data-message-id')||receiptTurn?.getAttribute('data-testid')||'';
  const candidates=[],cards=new Set();
  for(const button of all.filter(e=>once(e)||remember(e))){
    if(button.disabled||button.getAttribute('aria-disabled')==='true'||button.closest('.markdown,pre,code,[data-user-message-bubble],[data-message-author-role="user"]'))continue;
    if(!user||!(user.compareDocumentPosition(button)&Node.DOCUMENT_POSITION_FOLLOWING))continue;
    let card=button.parentElement;
    for(let level=0;card&&level<10&&card!==document.body;level++,card=card.parentElement){
      const body=text(card);if(body.length>8000)break;
      const controls=[...card.querySelectorAll('button')].filter(visible);
      if(!controls.some(deny))continue;
      // The rendered application label is an exact identity, not a substring
      // anywhere in the explanatory text. Keep A's real public name distinct
      // from B and reject aliases, suffixes and cards naming both connectors.
      const appNames=[...new Set([...card.querySelectorAll('span,strong,b,h1,h2,h3,h4,h5,h6')].filter(visible).map(text).filter(name=>/^Local-MCP(?:-B)?$/.test(name)))];
      // Ordinary tool cards can render the exact app in their headline only.
      // An anchored public label accepts that layout without substring grants.
      for(const element of [card,...card.querySelectorAll('*')].filter(visible)){
        for(const node of Array.from(element.childNodes).filter(node=>node.nodeType===3)){
          const match=/^(?:Allow ChatGPT to use|允许 ChatGPT 使用|允許 ChatGPT 使用)\s+(Local-MCP(?:-B)?)\s*[?？]?$/.exec(String(node.textContent||'').trim());
          if(match&&!appNames.includes(match[1]))appNames.push(match[1]);
        }
      }
      // Read visible text nodes separately: textContent can concatenate an app
      // label with the next English heading and manufacture a false suffix.
      const mentions=[card,...card.querySelectorAll('*')].filter(visible).flatMap(element=>Array.from(element.childNodes).filter(node=>node.nodeType===3).flatMap(node=>[...String(node.textContent||'').matchAll(/[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Cf}.]*Local-MCP[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Cf}.]*/gu)].map(match=>match[0])));
      const returnedNames=[...body.matchAll(/(?:对|對)\s+(.+?)\s+(?:返回|傳回)的/g)].map(match=>match[1].trim());
      const connector=appNames.length===1&&mentions.length>0&&mentions.every(name=>name===appNames[0])&&returnedNames.every(name=>name===appNames[0])?appNames[0]:'';
      const attachment=/允许文件实体化|允許檔案實體化|Allow file materialization/i.test(body)&&/文件附件|檔案附件|file attachments?/i.test(body);
      const tool=/Allow ChatGPT to use|允许 ChatGPT 使用|允許 ChatGPT 使用/i.test(body);
      if(!attachment&&!tool)continue;
      if(cards.has(card))break;
      cards.add(card);
      const policyBlocked=/safety.{0,30}(?:blocked|denied)|安全.{0,30}(?:拦截|阻止|拒绝)/i.test(body);
      const kind=attachment?'returned_file':'tool';
      // Repeated file results within one user turn share this card's wording.
      // Its rendered message UUID identifies each pending confirmation.
      const messageId=button.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')||'';
      const approvalIdentity=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(messageId)
        ?JSON.stringify([location.href,receiptUserId,kind,connector,messageId]):null;
      // Include the visible card and original user turn. Never include prompts,
      // credentials, tool arguments or attachment contents in the event journal.
      const persistent=controls.filter(e=>remember(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
      const single=controls.filter(e=>once(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
      const selected=persistent.length===1?persistent[0]:single.length===1?single[0]:null;
      candidates.push({button:selected,kind,connector,userId,approvalIdentity,signature:JSON.stringify([location.href,receiptUserId,kind,body]),eligible:!!connector&&!policyBlocked&&!!selected});break;
    }
  }
  const sameTurn=candidates.length>1&&candidates.every(c=>c.eligible&&c.connector===candidates[0].connector&&c.userId===candidates[0].userId);
  if(candidates.length!==1&&!sameTurn)return {required:candidates.length>0,eligible:false,reason:candidates.length?'ambiguous':'none',implementationVersion:2};
  const c=candidates[0];
  const snapshot={required:true,kind:c.kind,connector:c.connector,userId:c.userId,approvalIdentity:c.approvalIdentity,signature:c.signature,eligible:c.eligible,url:location.href,implementationVersion:2};
  if(action==='inspect')return snapshot;
  if(action!=='allow-once'||!c.eligible||expected.signature!==c.signature||expected.url!==location.href||expected.connector!==c.connector||
      (expected.approvalIdentity!==undefined&&expected.approvalIdentity!==c.approvalIdentity))throw Error('approval_identity_changed');
  c.button.click();return {...snapshot,clicked:true};
}
module.exports={publicApproval};
