import {resolve} from 'node:path';
import {createNativeTurnAdmission} from '../apps/codex-web-bridge/native-turn-admission';

// Maintenance-only reconciliation; never creates a trace, token, task or Send.
const [home, threadId] = process.argv.slice(2);
if (!home || !/^[0-9a-f-]{36}$/i.test(threadId || '')) {
  throw Error('Usage: bun scripts/reconcile_codex_web_failures.ts <bridge-home> <native-thread-id>');
}
const result = createNativeTurnAdmission(resolve(home)).reconcileThread(threadId!);
console.log(JSON.stringify({...result, threadId, modelSends: 0, originalFailuresPreserved: true}));
