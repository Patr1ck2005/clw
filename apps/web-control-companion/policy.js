/* Closed, pure, testable policy. No provider calls or model/effort selection. */
(() => {
  'use strict';
  const normal = x => typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').toLowerCase() : '';
  const chat = /^https:\/\/chatgpt\.com\/(?:g\/[A-Za-z0-9_-]+\/)?c\/(?:WEB:)?[A-Za-z0-9-]{16,128}$/;
  const permitted = (model, effort) => /\bsol\b/.test(normal(model)) && !/\bpro\b/.test(normal(model)) && ['medium', '中等', 'extra high', '极高'].includes(normal(effort));
  function safe(page, expected) {
    return !!page && permitted(page.model_label, page.effort_label) &&
      normal(page.model_label) === normal(expected.model_label) && normal(page.effort_label) === normal(expected.effort_label) &&
      page.visible === true && page.controls_known === true && /^[0-9a-f]{64}$/.test(page.user_hash) &&
      /^[0-9a-f]{64}$/.test(page.failure_hash) && ['', 'cannot_think', 'generation_failed'].includes(page.failure_kind) &&
      ['generating','draft','composing','focused','blocked','stopped'].every(k => page[k] === false);
  }
  const fields = Object.freeze({pulse:['page'], dispatch:['attempt_id','page'], finish:['attempt_id','result'], disable:[]});
  function actionValid(x) {
    return !!x && Object.hasOwn(fields, x.action) &&
      Object.keys(x).sort().join('|') === ['action', ...fields[x.action]].sort().join('|');
  }
  globalThis.CLWControlPolicy = Object.freeze({normal, permitted, safe, actionValid, isChat:url=>chat.test(url)});
})();
