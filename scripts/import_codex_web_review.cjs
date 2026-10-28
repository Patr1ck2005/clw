'use strict';
const path=require('node:path');
const {importReview}=require('../apps/codex-web-bridge/import-review.cjs');
const root=path.resolve(__dirname,'..');
try{
 const [traceId,directory]=process.argv.slice(2);
 if(!/^[a-f0-9]{12}$/.test(traceId||'')||!path.isAbsolute(directory||''))throw Error('usage: import_codex_web_review.cjs <traceId> <absolute result directory>');
 console.log(JSON.stringify(importReview(path.join(root,'.local/codex-web-bridge'),traceId,directory)));
}catch(e){console.error(e.message);process.exitCode=1;}
