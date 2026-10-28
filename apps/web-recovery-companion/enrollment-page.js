/* Only extracts a short public enrollment receipt, on explicit popup inspection.
   No transcript export, hidden-state access, cookies or network inspection. */
(() => {
 'use strict';
 const markerPattern=/^CLW-ENROLL:[0-9a-f]{32}:[A-Za-z0-9_-]{32}$/;
 const ticketPattern=/^(?:接入票据：|ticket[：:]\s*)(clwi_[A-Za-z0-9_-]{43})$/;
 globalThis.CLWEnrollmentReceipt=()=>{
  const messages=[...document.querySelectorAll('[data-message-author-role="assistant"]')].slice(-4).reverse();
  for(const message of messages){
   const matches=new Set();
   for(const node of [...message.querySelectorAll('p,code')].slice(-256)){
    if(node.closest('blockquote'))continue;
    const value=String(node.textContent||'').trim();
    if(value.length<=128&&markerPattern.test(value))matches.add(value);
   }
   if(matches.size>1)throw Error('team_ambiguous_enrollment_receipts');
   if(matches.size===1)return [...matches][0];
  }
  const users=[...document.querySelectorAll('[data-message-author-role="user"]')].slice(-4).reverse();
  for(const message of users){
   const tickets=new Set();
   for(const node of [...message.querySelectorAll('p,code')].slice(-256)){
    if(node.closest('blockquote'))continue;
    const value=String(node.textContent||'').trim().replace(/\s+/g,' ');
    if(value.length>160)continue;
    const hit=ticketPattern.exec(value);if(hit)tickets.add(hit[1]);
   }
   if(tickets.size>1)throw Error('team_ambiguous_enrollment_tickets');
   if(tickets.size===1)return {ticket:[...tickets][0]};
  }
  return null;
 };
})();
