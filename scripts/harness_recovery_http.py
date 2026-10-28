"""A single extension-only route; ordinary harness/Host APIs remain same-origin."""
import json
from harness_state import HarnessError, require
from harness_recovery import EXTENSION

def handle_recovery_wire(h, recovery):
    origin=h.headers.get('Origin','')
    valid_origin=bool(EXTENSION.fullmatch(origin))
    def respond(status, value):
        body=json.dumps(value,ensure_ascii=False).encode()
        h.send_response(status)
        if valid_origin:
            h.send_header('Access-Control-Allow-Origin',origin)
            h.send_header('Vary','Origin')
        h.send_header('Content-Type','application/json;charset=utf-8')
        h.send_header('Content-Length',str(len(body)));h.end_headers();h.wfile.write(body)
    try:
        port=h.server.server_address[1]
        require(h.headers.get('Host')==f'127.0.0.1:{port}','host_not_allowed',403)
        require(valid_origin,'recovery_extension_origin_required',403)
        if h.command=='OPTIONS':
            require(h.headers.get('Access-Control-Request-Method')=='POST','method_not_allowed',405)
            names={x.strip().lower() for x in h.headers.get('Access-Control-Request-Headers','').split(',') if x.strip()}
            require(names<={'content-type','x-clw-recovery'},'recovery_headers_not_allowed',403)
            h.send_response(204);h.send_header('Access-Control-Allow-Origin',origin)
            h.send_header('Access-Control-Allow-Methods','POST');h.send_header('Access-Control-Allow-Headers','Content-Type, X-CLW-Recovery')
            h.send_header('Vary','Origin');h.send_header('Content-Length','0');h.end_headers();return True
        require(h.command=='POST','method_not_allowed',405)
        require(h.headers.get_content_type()=='application/json' and not h.headers.get('Transfer-Encoding'),'recovery_json_required',415)
        n=h.headers.get('Content-Length','');require(n.isdecimal() and 0<int(n)<=8192,'recovery_body_too_large',413)
        raw=h.rfile.read(int(n));require(len(raw)==int(n),'incomplete_body')
        result=recovery.wire(origin,h.headers.get('X-CLW-Recovery'),json.loads(raw))
        respond(200,{'success':True,**result})
    except HarnessError as e:respond(e.status,{'success':False,'code':e.code})
    except (ValueError,TypeError,KeyError):respond(400,{'success':False,'code':'invalid_input'})
    except (BrokenPipeError,ConnectionError):pass
    except Exception:respond(503,{'success':False,'code':'recovery_unknown_no_dispatch_retry'})
    return True
