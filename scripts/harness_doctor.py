"""Read-only CLW diagnosis, usable while the app is down. Never starts services.

Reads only bounded public metadata from the exact project-local store and HTTP
endpoint. It does not instantiate HarnessState (which would migrate/write), read
local keys, inspect browser profiles, dispatch tools, or retry model work.
"""
from __future__ import annotations
import argparse, json, sqlite3, stat, time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from harness_handoff import request_handoff
ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://127.0.0.1:18944'

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('doctor_redirect_rejected')


def inspect_store(path):
    path = Path(path)
    if not path.exists():
        return {'status': 'store_missing', 'store_id': None, 'requests': []}
    # Refuse links/reparse points instead of silently following another store.
    if any(p.is_symlink() or (getattr(p.lstat(), 'st_file_attributes', 0) & 0x400)
           for p in (path, *path.parents)):
        raise ValueError('doctor_store_link_rejected')
    s = path.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise ValueError('doctor_store_not_regular')
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'metadata', 'host_requests', 'host_bindings'} <= tables:
            return {'status': 'unsupported_store_schema', 'store_id': None, 'requests': []}
        ident = db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()
        rows = db.execute("""SELECT r.id,r.thread_id,r.phase,r.cancel_requested,
          b.target_id,b.enabled,b.wait_until FROM host_requests r
          JOIN host_bindings b ON b.thread_id=r.thread_id
          WHERE r.phase IN ('queued','processing','suspended') ORDER BY r.created_at LIMIT 33""").fetchall()
        output = []
        for r in rows[:32]:
            output.append({'request_id': r['id'], 'target_id': r['target_id'], 'phase': r['phase'],
                           'handoff': request_handoff(db, r, r, time.time())})
        return {'status': 'read_only', 'store_id': ident[0] if ident else None,
                'requests': output, 'truncated': len(rows) > 32,
                'legacy_handoff_history_unknown': 'host_handoffs' not in tables}
    finally:
        db.close()


def probe_live(expected_store, expected_root):
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        req = Request(ORIGIN + '/api/harness/info', headers={'Origin': ORIGIN})
        with opener.open(req, timeout=5) as response:
            if response.headers.get_content_type() != 'application/json':
                raise ValueError('doctor_response_type')
            raw = response.read(262145)
        if len(raw) > 262144:
            raise ValueError('doctor_response_too_large')
        v = json.loads(raw)
        if v.get('success') is not True or v.get('store_id') != expected_store or Path(v.get('root', '')).resolve() != expected_root.resolve():
            return {'status': 'identity_mismatch', 'next_action': 'inspect_exact_owner_no_restart'}
        life = v.get('lifetime') or {}
        return {'status': 'online', 'instance_id': v.get('instance_id'), 'version': v.get('version'),
                'lifetime_owner': life.get('owner', 'not_reported'),
                'durability_verified': False, 'service_restart_performed': False}
    except HTTPError as exc:
        code = exc.code;exc.close()
        return {'status': 'http_rejected', 'http_status': code, 'next_action': 'inspect_original_response_no_replay'}
    except (URLError, TimeoutError, OSError):
        return {'status': 'offline_or_unreachable', 'next_action': 'reconcile_original_app_job_then_START_HARNESS'}
    except (ValueError, TypeError, KeyError):
        return {'status': 'response_unverified', 'next_action': 'inspect_exact_owner_no_restart'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--no-network', action='store_true')
    a = p.parse_args()
    store = inspect_store(ROOT / '.local/harness/harness.sqlite3')
    live = {'status': 'not_probed'} if a.no_network else probe_live(store['store_id'], ROOT)
    print(json.dumps({'format': 'clw.handoff-doctor.v1', 'store': store, 'app': live,
                      'no_mutations': True, 'model_calls': 0, 'automatic_restart': False,
                      'note': 'Registration/polling is not a Host turn. A Runner Job lifetime is not normal application lifetime.'},
                     ensure_ascii=False))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
