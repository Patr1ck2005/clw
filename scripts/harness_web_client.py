"""Read one exact local Web request after ordinary project authorization.
This does not send model work, grant scopes, or impersonate an Agent reply.
"""
from pathlib import Path
import argparse,json,sys
from urllib.parse import urlencode
from urllib.request import Request,build_opener,ProxyHandler,HTTPRedirectHandler
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from live_transport import validate_origin
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('redirect_not_allowed')
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['receive']);p.add_argument('--request-id',required=True);p.add_argument('--store-id',required=True);p.add_argument('--origin',default='http://127.0.0.1:18944');a=p.parse_args()
    origin=validate_origin(a.origin);op=build_opener(ProxyHandler({}),NoRedirect())
    q=urlencode({'request_id':a.request_id,'store_id':a.store_id})
    with op.open(Request(origin+'/api/harness/web-request?'+q,headers={'Origin':origin}),timeout=12) as r:
        body=r.read(262145)
    if len(body)>262144:raise ValueError('oversized_reply')
    result=json.loads(body)
    if not result.get('success') or result.get('request_id')!=a.request_id or result.get('store_id')!=a.store_id:raise ValueError('request_identity_mismatch')
    print(json.dumps(result,ensure_ascii=False,indent=2));return 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError) as exc:
        print(json.dumps({'status':'blocked','code':type(exc).__name__,'instruction':'Preserve original request. Check same application/store and confirmed native receipt. No alternate target or write was attempted.'}));raise SystemExit(1)
