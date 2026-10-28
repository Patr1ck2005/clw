import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { observedAdapter } from '../../observed-adapter';
import { responseRequest } from '../../upstream/src/server';
import { defaultConfig } from '../../upstream/src/config';

const [home, phase, captureDirectory] = process.argv.slice(2);
if (!home || !captureDirectory || !['initial', 'replay'].includes(phase)) {
  throw new Error('Expected isolated home, initial|replay, and capture directory');
}

const sendMarker = join(captureDirectory, 'physical-sends.jsonl');
const factoryMarker = join(captureDirectory, 'adapter-factories.jsonl');
let handled = false;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/responses' || handled) {
      return new Response('Unexpected fixture request', { status: 409 });
    }
    handled = true;
    const requestSha256 = createHash('sha256').update(await request.clone().text()).digest('hex');
    let journalCommittedAtDone = false;
    const upstream = await responseRequest(request, defaultConfig('full'), provider =>
      observedAdapter(provider, home, () => {
        appendFileSync(factoryMarker, JSON.stringify({ phase, pid: process.pid }) + '\n');
        return {
          name: 'offline-delivery-drop',
          async runTurn(_parsed: unknown, _incoming: unknown, emit: (event: unknown) => void) {
            appendFileSync(sendMarker, JSON.stringify({ phase, pid: process.pid }) + '\n');
            emit({ type: 'text_delta', text: 'The durable final answer.', phase: 'final_answer' });
            emit({ type: 'done', stopReason: 'stop', endTurn: true });
          },
        } as any;
      }, `http-owner-${phase}`), {
      rememberState: false,
      onAdapterEvent(event) {
        if (event.type !== 'done') return;
        try {
          const files = readdirSync(join(home, 'runtime', 'native-final-replay'));
          if (files.length !== 1 || !files[0]!.endsWith('.json')) return;
          const journal = JSON.parse(readFileSync(join(home, 'runtime', 'native-final-replay', files[0]!), 'utf8'));
          journalCommittedAtDone = journal.events?.at(-1)?.type === 'done';
        } catch { /* The test rejects this owner after collecting its capture. */ }
      },
    });
    const fullWire = await upstream.text();
    const frames = fullWire.split(/\r?\n\r?\n/);
    const terminals = frames.filter(frame => /^event: response\.completed(?:\r?\n|$)/.test(frame));
    if (upstream.status !== 200 || !journalCommittedAtDone || terminals.length !== 1) {
      throw new Error('Offline final was not durably committed before terminal SSE delivery');
    }
    writeFileSync(join(captureDirectory, `${phase}.json`), JSON.stringify({
      requestSha256, fullWire, journalCommittedAtDone, status: upstream.status,
    }));
    if (phase === 'replay') return new Response(fullWire, { status: upstream.status, headers: upstream.headers });

    // The HTTP owner has the complete upstream response, but its client sees EOF
    // before response.completed. The test then ends this process and retries.
    const delivered = frames.filter(frame => frame && !/^event: response\.completed(?:\r?\n|$)/.test(frame)
      && !/^data: \[DONE\]/.test(frame)).join('\n\n') + '\n\n';
    return new Response(delivered, { status: upstream.status, headers: upstream.headers });
  },
});

process.stdout.write(JSON.stringify({ port: server.port, pid: process.pid }) + '\n');
