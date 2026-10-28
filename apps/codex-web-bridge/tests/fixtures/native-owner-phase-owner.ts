// Offline crash target for native-owner-phase-faults.test.ts. No browser or Web model is started.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createNativeTurnAdmission } from '../../native-turn-admission';
import { defaultBrokerEndpoint } from '../../upstream/src/config';
import { callTurnBroker, TurnBroker } from '../../upstream/src/adapters/chatgpt-web/turn-broker';

const require = createRequire(import.meta.url);
const { installTurnJournal } = require('../../turn-journal.cjs');
const [home, phase] = process.argv.slice(2);
if (!home || !['delivered', 'complete_ack_lost', 'synthetic_send_activated', 'synthetic_send_accepted'].includes(phase)) {
  throw new Error('Offline owner fixture requires home and a known phase');
}

// A deliberately unusable proxy makes an accidental fetch fail closed. The fixture itself only
// uses a local broker socket and never creates a browser helper or HTTP client.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) process.env[key] = 'http://127.0.0.1:9';
process.env.NO_PROXY = '127.0.0.1,localhost';

// Native adapter traces are twelve lowercase hex characters; this also lets the activity journal
// retain the exact trace identity rather than applying its privacy hash for external labels.
const traceId = ({ delivered: 'abcdef123401', complete_ack_lost: 'abcdef123402',
  synthetic_send_activated: 'abcdef123403', synthetic_send_accepted: 'abcdef123404' } as Record<string, string>)[phase]!;
const identity = { threadId: `thread_${phase}`, turnId: `turn_${phase}` };
createNativeTurnAdmission(home, `owner_${phase}`).admit(identity, traceId);
const tab = { id: 'offline-tab', traceId, view: { webContents: { getURL: () => 'about:blank', on() {} } } };
const host = { turnTabs: new Map([[tab.id, tab]]), async beginTurn() { return { tabId: tab.id }; }, async endTurn() {} };
installTurnJournal(host, home);
await host.beginTurn();

const phaseFile = join(home, 'phase.json');
if (phase.startsWith('synthetic_send_')) {
  // This is a durable fixture marker, not a claim that a Web Send occurred.
  const checkpoint = join(home, 'diagnostics', 'browser-turns', `${traceId}-fixture`);
  mkdirSync(checkpoint, { recursive: true });
  writeFileSync(join(checkpoint, phase === 'synthetic_send_accepted'
    ? '01-submission-accepted.json' : '01-send-activated.json'), '{}\n');
  writeFileSync(phaseFile, JSON.stringify({ phase, traceId, identity, syntheticWebCheckpoint: true }));
  setInterval(() => {}, 1000);
} else {
  const socketPath = defaultBrokerEndpoint(home);
  const activityPath = join(home, 'native-activity.jsonl');
  const broker = TurnBroker.forSocket(socketPath, activityPath);
  await broker.listen();
  const environment = { cwd: home, roots: [home], writableRoots: [home],
    sandboxPolicy: { type: 'dangerFullAccess' as const },
    tools: [{ name: 'exec_command', description: 'Offline marker only', parameters: { type: 'object' } }],
  };
  const token = await broker.register(environment, 60_000, traceId);
  const { bindingId } = await callTurnBroker<{ bindingId: string }>(socketPath, { method: 'claim', token });
  const invocation = callTurnBroker(socketPath, {
    method: 'invoke', bindingId, wireName: 'exec_command', arguments: { cmd: 'offline-marker' },
  }, null);
  void invocation.catch(() => {});
  const [request] = await broker.nextToolBatch(token);
  if (!request) throw new Error('Broker did not deliver the offline call');
  appendFileSync(join(home, 'tool-executions.jsonl'), JSON.stringify({ traceId, callId: request.callId }) + '\n');
  if (phase === 'delivered') {
    writeFileSync(phaseFile, JSON.stringify({ phase, traceId, identity, callId: request.callId }));
  } else {
    // Inject the failure at the exact ACK boundary: the real broker has committed the result,
    // but its successful owner_complete response is deliberately withheld from the socket.
    const originalWrite = (broker as any).writeSocketResponse.bind(broker);
    (broker as any).writeSocketResponse = (socket: unknown, response: any) => {
      if (response?.result?.completed === true) {
        writeFileSync(phaseFile, JSON.stringify({ phase, traceId, identity,
          callId: request.callId, ackWithheld: true }));
        return;
      }
      originalWrite(socket, response);
    };
    void callTurnBroker(socketPath, { method: 'owner_complete', token, callId: request.callId,
      toolResult: { content: [{ type: 'text', text: 'offline-result' }] } }, null).catch(() => {});
  }
  setInterval(() => {}, 1000);
}
