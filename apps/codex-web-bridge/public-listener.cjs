'use strict';
// This process owns only the published loopback socket. The upstream server,
// broker, helper and browser turns remain in the separate long-lived owner.
const http = require('node:http');
const path = require('node:path');

function validPort(value) {
  const port = Number(value);
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isInteger(port) || port > 65535)
    throw Error('bridge_listener_port_invalid');
  return port;
}

function validPid(value) {
  const pid = Number(value);
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(pid))
    throw Error('bridge_listener_owner_pid_invalid');
  return pid;
}

function ownerAlive(pid) {
  if (pid === undefined) return true;
  // A replacement process can bind the same loopback port after the owner exits.
  // Its responses must not be mistaken for this owner's task or health state.
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function ownerUnavailable(response) {
  response.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'})
    .end('bridge_owner_unavailable\n');
}

function createPublicListener(publicPort, ownerPort, ownerPid, {beforeOwnerResponse} = {}) {
  publicPort = validPort(publicPort);
  ownerPort = validPort(ownerPort);
  if (ownerPid !== undefined) ownerPid = validPid(ownerPid);
  if (publicPort === ownerPort) throw Error('bridge_listener_owner_port_reused');
  const server = http.createServer((request, response) => {
    if (!ownerAlive(ownerPid)) {
      request.resume();
      return ownerUnavailable(response);
    }
    // Keep the method, raw path, headers and body on this one attempt. In
    // particular, a dropped SSE stream must never cause a new Web send.
    let rejected = false;
    const upstream = http.request({
      hostname: '127.0.0.1', port: ownerPort, method: request.method,
      path: request.url, headers: request.rawHeaders, agent: false,
    }, ownerResponse => {
      // The owner may exit after request admission while this socket is in flight.
      // The optional hook lets a local test hold exactly this boundary.
      const deliver = async () => {
        try { if (beforeOwnerResponse) await beforeOwnerResponse(); }
        catch { rejected = true; }
        if (rejected || !ownerAlive(ownerPid)) {
          rejected = true;
          if (!response.destroyed && !response.headersSent) ownerUnavailable(response);
          ownerResponse.destroy();
          upstream.destroy();
          return;
        }
        if (response.destroyed || response.writableEnded) { upstream.destroy(); return; }
        response.writeHead(ownerResponse.statusCode, ownerResponse.statusMessage, ownerResponse.rawHeaders);
        ownerResponse.pipe(response);
        ownerResponse.on('aborted', () => response.destroy());
        ownerResponse.on('error', () => response.destroy());
      };
      void deliver();
    });
    upstream.on('error', () => {
      if (rejected || response.destroyed || response.writableEnded) return;
      if (response.headersSent) response.destroy();
      else ownerUnavailable(response);
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    response.on('error', () => upstream.destroy());
    request.pipe(upstream);
  });
  // A model turn or SSE response can be quiet for longer than HTTP defaults.
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

async function main() {
  const publicPort = validPort(process.argv[2]);
  const ownerPort = validPort(process.argv[3]);
  const ownerPid = process.argv[4] === undefined ? undefined : validPid(process.argv[4]);
  const server = createPublicListener(publicPort, ownerPort, ownerPid);
  // The owner capability is inherited only through this parent's private pipe.
  // It is never accepted from an HTTP request or echoed to a support log.
  const capability=process.env.CLW_LISTENER_PARENT_CAPABILITY;
  if(capability&&/^[a-f0-9]{64}$/.test(capability)){
    let buffer='',stopping=false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{
      if(stopping)return;buffer+=chunk;
      if(buffer.length>4096){buffer='';return;}
      const end=buffer.indexOf('\n');if(end<0)return;
      const line=buffer.slice(0,end);buffer='';let command;
      try{command=JSON.parse(line);}catch{return;}
      if(command.kind!=='native_listener_shutdown'||command.listenerPid!==process.pid||command.ownerPid!==ownerPid||
        command.capability!==capability||typeof command.operationId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(command.operationId)))return;
      stopping=true;process.stdin.pause();process.stdin.unref?.();
      server.close(error=>{if(error)process.exitCode=1;process.stdin.destroy();});
      server.closeIdleConnections?.();
    });
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(publicPort, '127.0.0.1', resolve);
  });
  process.stdout.write(JSON.stringify({ready: true, pid: process.pid, port: publicPort}) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = {createPublicListener};
