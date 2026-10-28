"""Extension-only bounded control-wire route. Never an arbitrary tool proxy."""
import json
from harness_state import HarnessError, require
from harness_recovery import EXTENSION


def handle_control_wire(h, control):
    origin = h.headers.get('Origin', '')
    valid = bool(EXTENSION.fullmatch(origin))
    def respond(status, value):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        h.send_response(status)
        if valid:
            h.send_header('Access-Control-Allow-Origin', origin);h.send_header('Vary', 'Origin')
        h.send_header('Cache-Control', 'no-store')
        h.send_header('Content-Type', 'application/json;charset=utf-8')
        h.send_header('Content-Length', str(len(body)));h.end_headers();h.wfile.write(body)
    try:
        require(h.headers.get('Host') == f'127.0.0.1:{h.server.server_address[1]}', 'control_host_not_allowed', 403)
        require(valid, 'control_extension_origin_required', 403)
        require(all(len(h.headers.get_all(k, [])) <= 1 for k in ('Origin','Host','X-CLW-Control','Content-Length','Content-Type')), 'control_duplicate_header', 400)
        if h.command == 'OPTIONS':
            require(h.headers.get('Access-Control-Request-Method') == 'POST', 'method_not_allowed', 405)
            names = {x.strip().lower() for x in h.headers.get('Access-Control-Request-Headers','').split(',') if x.strip()}
            require(names <= {'content-type','x-clw-control'}, 'control_headers_not_allowed', 403)
            h.send_response(204);h.send_header('Access-Control-Allow-Origin', origin)
            h.send_header('Access-Control-Allow-Methods', 'POST');h.send_header('Access-Control-Allow-Headers','Content-Type, X-CLW-Control')
            h.send_header('Vary','Origin');h.send_header('Content-Length','0');h.end_headers();return True
        require(h.command == 'POST', 'method_not_allowed', 405)
        require(h.headers.get_content_type() == 'application/json' and not h.headers.get('Transfer-Encoding'), 'control_json_required', 415)
        n = h.headers.get('Content-Length','')
        require(n.isdecimal() and len(n) < 7 and 0 < int(n) <= 262144, 'control_body_too_large', 413)
        raw = h.rfile.read(int(n));require(len(raw) == int(n), 'control_incomplete_body')
        result = control.wire(origin,h.headers.get('X-CLW-Control'),json.loads(raw))
        respond(200,{'success':True,**result})
    except HarnessError as e:respond(e.status,{'success':False,'code':e.code})
    except (ValueError,TypeError,KeyError):respond(400,{'success':False,'code':'control_invalid_input'})
    except (BrokenPipeError,ConnectionError):pass
    except Exception:respond(503,{'success':False,'code':'control_unknown_no_retry'})
    return True
