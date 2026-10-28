"""Register one explicit NON-SECRET health reference, without starting or changing any tunnel."""
from pathlib import Path
import argparse,json,os,tempfile
from ingress_health import IngressSources,IngressHealth
from link_workbench import write_reference
from task_domain import TaskError
ROOT=Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('id','name','tunnel-id','health-url-file','connection-id'):p.add_argument('--'+name,required=True)
    p.add_argument('--config',type=Path,default=ROOT/'.local/control-center/ingresses.json');a=p.parse_args()
    raw={'id':a.id,'name':a.name,'tunnel_id':a.tunnel_id,'health_url_file':a.health_url_file,'connection_id':a.connection_id}
    config=a.config.resolve();config.parent.mkdir(parents=True,exist_ok=True);lock=config.with_name(config.name+'.lock');fd=None
    try:
        fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
        sources=IngressSources.load(config)
        if a.id in sources.entries:
            e=sources.get(a.id)
            if any(e[k]!=v for k,v in raw.items()):raise ValueError('Existing source differs. Review the local file explicitly; not overwritten.')
            print('Existing exact reference retained; no new registration.');return 0
        entries=[{k:v for k,v in e.items() if k!='fingerprint'} for e in sources.entries.values()]+[raw]
        merged=IngressSources(entries);result=IngressHealth(merged).observe(a.id)
        if result['state']!='polling':raise ValueError('Health identity/fresh poll not confirmed: '+result['state']+' / '+str(result.get('error_code')))
        body={'schema_version':1,'sources':entries}
        if not config.exists():write_reference(config,body)
        else:
            fd2,name=tempfile.mkstemp(prefix='.ingresses-',suffix='.tmp',dir=config.parent)
            try:
                with os.fdopen(fd2,'w',encoding='utf-8') as f:json.dump(body,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
                os.replace(name,config)
            finally:Path(name).unlink(missing_ok=True)
        print('Non-secret health reference saved. Restart only Control Center when ready; no tunnel or credentials changed.');return 0
    except (OSError,ValueError,TaskError) as exc:
        print('Reference was not registered:',str(exc));return 1
    finally:
        if fd is not None:os.close(fd);lock.unlink(missing_ok=True)
if __name__=='__main__':raise SystemExit(main())
