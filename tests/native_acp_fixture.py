"""No-model ACP stdio peer for pinned native integration only.
Runs only when explicitly configured in an isolated test Runner. No network,
credentials, shell, project edits or real Codex calls. Records protocol facts,
not arbitrary instruction text, to the caller-owned test directory.
"""
from pathlib import Path
import hashlib
import json
import os
import sys


def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stdin.reconfigure(encoding='utf-8')
    log=Path(sys.argv[1]).resolve()
    if not log.parent.is_dir():raise SystemExit('Explicit test directory required')
    values={'model':'clw-no-model','reasoning_effort':'high','mode':'read-only'}
    choices={'model':['clw-no-model'],'reasoning_effort':['high','max'],'mode':['read-only']}
    def options():return [{'id':k,'name':k,'type':'select','currentValue':v,'options':[{'value':x,'name':x} for x in choices[k]]} for k,v in values.items()]
    def record(value):
        with log.open('a',encoding='utf-8') as f:f.write(json.dumps(value,ensure_ascii=False)+'\n')
    def send(value):print(json.dumps(value),flush=True)
    record({'kind':'process','pid':os.getpid(),'network_used':False,'model_used':False})
    for line in sys.stdin:
        message=json.loads(line);method=message.get('method');rid=message.get('id');params=message.get('params') or {}
        record({'kind':'method','method':method})
        if method=='initialize':
            send({'jsonrpc':'2.0','id':rid,'result':{'protocolVersion':1,'agentCapabilities':{}}})
        elif method=='session/new':
            record({'kind':'cwd','path':params.get('cwd')})
            send({'jsonrpc':'2.0','id':rid,'result':{'sessionId':'clw-test-session','configOptions':options()}})
        elif method=='session/set_config_option':
            k=params['configId'];v=params['value']
            if k not in choices or v not in choices[k]:
                send({'jsonrpc':'2.0','id':rid,'error':{'code':-32602,'message':'unsupported test option'}});continue
            values[k]=v;record({'kind':'option','name':k,'value':v})
            send({'jsonrpc':'2.0','id':rid,'result':{'configOptions':options()}})
        elif method=='session/prompt':
            prompt=params.get('prompt',[])
            text=''.join(x.get('text','') for x in prompt if isinstance(x,dict) and x.get('type')=='text')
            record({'kind':'prompt','sha256':hashlib.sha256(text.encode()).hexdigest(),'config':values.copy()})
            for used,cost in [(53,0.045),(70,0.050)]:
                send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'clw-test-session','update':{'sessionUpdate':'usage_update','used':used,'size':200,'cost':{'amount':cost,'currency':'USD'}}}})
            send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'clw-test-session','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Isolated ACP protocol fixture completed; no model called.'}}}})
            send({'jsonrpc':'2.0','id':rid,'result':{'stopReason':'end_turn'}})
        elif method=='session/cancel':
            record({'kind':'cancel_received'})
        elif rid is not None:
            send({'jsonrpc':'2.0','id':rid,'error':{'code':-32601,'message':'fixture method not implemented'}})
if __name__=='__main__':main()
