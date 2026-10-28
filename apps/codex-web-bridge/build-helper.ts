import {join} from 'node:path';
const root=join(import.meta.dir,'upstream');
const result=await Bun.build({entrypoints:[join(root,'src/adapters/chatgpt-web/browser-helper-main.ts')],
  target:'node',format:'cjs',minify:true,external:['playwright-core'],packages:'external',outdir:join(root,'dist'),naming:'browser-helper.cjs'});
if(!result.success)throw new AggregateError(result.logs,'Browser helper build failed');
console.log('Built pinned browser helper; no model call or Codex configuration change.');
