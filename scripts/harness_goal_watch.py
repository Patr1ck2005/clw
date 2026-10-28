"""Opt-in managed goals. Wait locally; submit through the existing operator API.

Goal metadata lives beside the original task ledger. No copied task queue, model
polling, account switching, or mutation of original execution receipts.
"""
from __future__ import annotations
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

from native_work_admission import AdmissionError, local_runtime_read
from harness_job_inventory import (ACTIVE, JobInventoryError, read_session_inventory,
                                   checked_inventory, job_terminal)
from product_runtime import FileLease, ProductError, atomic_json, read_json

ROOT = Path(__file__).resolve().parents[1]
WATCH_SOURCES = ('harness_goal_watch.py', 'harness_next_round.py',
                 'harness_goal_control.py', 'harness_goal_evidence.py', 'harness_managed_budget.py')
_STARTING = {}


def source_version(root):
    """Identity of the frozen watcher/continuation code requested at startup."""
    files = [(name, hashlib.sha256((Path(root) / 'scripts' / name).read_bytes()).hexdigest())
             for name in WATCH_SOURCES]
    return hashlib.sha256(json.dumps(files, separators=(',', ':')).encode()).hexdigest()


def watch_owner(root, status):
    """Inspect only the recorded owner; a live foreign/reused PID is refused."""
    from windows_process_owner import process_inventory, process_identity, OwnershipUnavailable
    from web_host_supervisor_owner import command_argv, normalized
    pid = status.get('pid')
    if type(pid) is not int or pid < 1:raise ValueError('watcher_owner_unavailable')
    if status.get('creation_filetime'):
        try:row = process_identity(pid)
        except OwnershipUnavailable:row = None
        if row is not None:
            if row['CreationFiletime'] != status['creation_filetime'] or row['ProcessName'] not in ('python.exe', 'pythonw.exe'):
                raise ValueError('watcher_owner_changed')
            return {'pid': pid, 'creation_filetime': row['CreationFiletime']}
    try:
        rows = process_inventory(target_names=('python.exe', 'pythonw.exe'),
                                 candidate_filter=lambda row: row['ProcessId'] == pid)
    except (OSError, RuntimeError):raise ValueError('watcher_owner_unavailable') from None
    row = next((row for row in rows if row['ProcessId'] == pid), None)
    if row is None:return None
    argv = command_argv(row.get('CommandLine'))
    arguments = argv[1:]
    if arguments[:2] != ['-X', 'utf8']:raise ValueError('watcher_owner_changed')
    arguments = arguments[2:]
    if arguments[:1] == ['-B']:arguments = arguments[1:]
    if len(arguments) not in (4, 6) or normalized(arguments[0]) != normalized(Path(root) / 'scripts/harness_goal_watch.py') or \
       arguments[1] != '--root' or normalized(arguments[2]) != normalized(root) or arguments[-1] != 'watch' or \
       len(arguments) == 6 and arguments[3] != '--expected-source-sha256':
        raise ValueError('watcher_owner_changed')
    owner = {'pid': pid, 'creation_filetime': row['CreationFiletime']}
    if status.get('creation_filetime') not in (None, owner['creation_filetime']):raise ValueError('watcher_owner_changed')
    return owner


def _spawn_watcher(root, version):
    import subprocess
    root = Path(root)
    child = subprocess.Popen([sys.executable, '-X', 'utf8', '-B', str(root / 'scripts/harness_goal_watch.py'),
                              '--root', str(root), '--expected-source-sha256', version, 'watch'],
                             cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    _STARTING[str(root)] = (child, version)
    return {'state': 'watcher_start_requested', 'pid': child.pid, 'source_sha256': version}


class Operator:
    def __init__(self, origin="http://127.0.0.1:18944", root=None):
        self.origin = origin
        self.root = Path(root).resolve() if root is not None else None

    def request(self, route, payload=None, intent=None):
        origin = self.origin
        if self.root is not None and (self.root/'.local/preview-installation.json').is_file():
            from harness_endpoint import resolve
            origin = resolve(self.root)
        headers = {"Origin": origin}
        if payload is not None:
            headers.update({"Content-Type": "application/json", "X-CLW-Intent": intent})
        data = None if payload is None else json.dumps(payload,ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(origin + "/api/harness/" + route, data, headers)
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=15) as reply:
            return json.load(reply)


class Goals:
    def __init__(self, root=ROOT, operator=None):
        self.root = Path(root).resolve()
        self.path = self.root / ".local/harness/harness.sqlite3"
        if not self.path.is_file():
            raise RuntimeError("existing_harness_required")
        self.operator = operator or Operator(root=self.root)
        with self.db() as db:
            from harness_goal_control import schema
            import harness_next_round
            schema(db);harness_next_round.schema(db)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def identity(db, page):
        binding = db.execute("SELECT spec FROM host_bindings WHERE thread_id=?", (page["thread_id"],)).fetchone()
        spec = json.loads(binding[0]) if binding else {}
        return json.dumps({"thread": page["thread_id"], "root": page["root"],
                           "account": json.loads(page["settings"]).get("account"),
                           "model": page["model"], "effort": page["effort"],
                           "session": spec.get("session_id"), "project": spec.get("project")}, sort_keys=True)

    def enable(self, page_id, objective):
        if not objective.strip() or len(objective) > 18000:
            raise ValueError("invalid_goal")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            page = db.execute("SELECT * FROM managed_pages WHERE page_id=?", (page_id,)).fetchone()
            if not page or page["parent_target"] or page["phase"] != "bound":
                raise ValueError("bound_controller_required")
            req = db.execute("SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (page["thread_id"],)).fetchone()
            if not req:
                raise ValueError("original_request_required")
            if db.execute("SELECT 1 FROM managed_goals WHERE page_id=?", (page_id,)).fetchone():
                raise ValueError("goal_already_exists_use_state")
            store = db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0]
            db.execute("INSERT INTO managed_goals(page_id,thread_id,store_id,identity,objective,state,request_id,updated) VALUES(?,?,?,?,?,'active',?,?)",
                       (page_id, page["thread_id"], store, self.identity(db, page), objective.strip(), req[0], time.time()))

    def state(self, page_id, state, reason, observed=False):
        if state not in ("active", "waiting", "paused", "needs_attention", "ready_for_review", "complete"):
            raise ValueError("invalid_goal_state")
        if state == "complete" and not reason.strip():
            raise ValueError("completion_evidence_required")
        with self.db() as db:
            goal=db.execute('SELECT control_mode FROM managed_goals WHERE page_id=?',(page_id,)).fetchone()
            if goal and goal['control_mode']=='manual' and state=='active':
                raise ValueError('manual_goal_requires_human_review_and_next_package')
            # A cached watcher observation cannot undo a later human stop.
            # Explicit CLI/operator state changes keep their existing behavior.
            db.execute("UPDATE managed_goals SET state=?,reason=?,updated=? WHERE page_id=?"+
                       (" AND state IN ('active','waiting')" if observed else ''),
                       (state, reason, time.time(), page_id))

    def update_objective(self, page_id, expected_request_id, objective, reason):
        """Apply human steering to the existing goal, without sending or resuming."""
        if not objective.strip() or len(objective) > 18000:
            raise ValueError('invalid_goal')
        if not reason.strip() or len(reason) > 2000:
            raise ValueError('goal_resumption_basis_required')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            goal = db.execute('SELECT * FROM managed_goals WHERE page_id=?', (page_id,)).fetchone()
            page = db.execute('SELECT * FROM managed_pages WHERE page_id=?', (page_id,)).fetchone()
            if not goal or not page or self.identity(db, page) != goal['identity']:
                raise ValueError('goal_identity_changed')
            if goal['control_mode']=='manual':
                raise ValueError('manual_goal_use_desktop_review')
            if goal['pending_id']:
                raise ValueError('goal_pending_original_send')
            if not expected_request_id or goal['request_id'] != expected_request_id:
                raise ValueError('goal_original_changed')
            db.execute('UPDATE managed_goals SET objective=?,reason=?,updated=? WHERE page_id=?',
                       (objective.strip(), reason, time.time(), page_id))

    def adopt_request(self, page_id, expected_request_id, request_id, reason, objective=None):
        """Explicit operator resumption after an audited failed batch, no send.

        Adopt an already accepted request on the same original identity. Never
        discard an unknown pending send or reinterpret the prior failure.
        """
        if not reason.strip() or len(reason) > 2000 or not request_id or not expected_request_id or request_id == expected_request_id:
            raise ValueError('goal_resumption_basis_required')
        if objective is not None and (not objective.strip() or len(objective) > 18000):
            raise ValueError('invalid_goal')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            goal = db.execute('SELECT * FROM managed_goals WHERE page_id=?', (page_id,)).fetchone()
            page = db.execute('SELECT * FROM managed_pages WHERE page_id=?', (page_id,)).fetchone()
            if not goal or not page or self.identity(db, page) != goal['identity']:
                raise ValueError('goal_identity_changed')
            if goal['control_mode']=='manual':
                raise ValueError('manual_goal_use_desktop_review')
            if goal['pending_id']:
                raise ValueError('goal_pending_original_send')
            # A replay reads the same accepted transition; it cannot reset cycles.
            if goal['request_id'] == request_id and goal['state'] == 'active':
                if objective is not None and goal['objective'] != objective.strip():
                    raise ValueError('goal_original_changed')
                return
            if goal['request_id'] != expected_request_id or goal['state'] not in ('paused', 'needs_attention'):
                raise ValueError('goal_original_changed')
            old = db.execute('SELECT phase FROM host_requests WHERE id=? AND thread_id=?',
                             (expected_request_id, goal['thread_id'])).fetchone()
            latest = db.execute('SELECT id,phase,cancel_requested FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
                                (goal['thread_id'],)).fetchone()
            run = db.execute('SELECT id,state FROM host_runs WHERE controller_request=? ORDER BY created DESC LIMIT 1',
                             (expected_request_id,)).fetchone()
            if not old or old['phase'] not in ('completed', 'blocked', 'cancelled', 'failed') or not run or run['state'] != 'closed':
                raise ValueError('goal_original_not_settled')
            if db.execute('SELECT 1 FROM host_team_leases WHERE run_id=?', (run['id'],)).fetchone():
                raise ValueError('goal_original_not_settled')
            if not latest or latest['id'] != request_id or latest['cancel_requested'] or latest['phase'] not in ('queued', 'processing', 'suspended'):
                raise ValueError('goal_new_request_not_current')
            # Resume the original page explicitly before enabling its next
            # goal. Otherwise the watcher can consume a retained login issue
            # between adoption and resume and leave the goal stopped forever.
            # This check never clears a stop, issue, or page pause itself.
            binding = db.execute('SELECT enabled FROM host_bindings WHERE thread_id=?', (goal['thread_id'],)).fetchone()
            if (page['phase'] != 'bound' or page['paused'] or not binding or not binding[0]
                    or db.execute('SELECT 1 FROM managed_page_issues WHERE page_id=?', (page_id,)).fetchone()
                    or db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0', (page_id,)).fetchone()
                    or db.execute('SELECT 1 FROM managed_attention WHERE request_id=?', (request_id,)).fetchone()):
                raise ValueError('goal_new_request_page_not_ready')
            db.execute("UPDATE managed_goals SET request_id=?,state='active',objective=?,reason=?,updated=? WHERE page_id=?",
                       (request_id, objective.strip() if objective is not None else goal['objective'], reason, time.time(), page_id))

    def status(self):
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT page_id,state,request_id,pending_id,cycles,reason,updated FROM managed_goals")]

    def health(self):
        try:
            h = json.loads((self.root / ".local/web-host/health.json").read_text(encoding="utf-8"))
            age = time.time() - datetime.fromisoformat(h["at"].replace("Z", "+00:00")).timestamp()
            return h.get("connected") is True and (h.get("networkReady") is True or h.get("network") == "VPN 已连接 · 直连已禁用") and 0 <= age <= 30
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def eligible(self, db, goal):
        """Return (reason, verified final artifact). Empty reason means eligible."""
        page = db.execute("SELECT * FROM managed_pages WHERE page_id=?", (goal["page_id"],)).fetchone()
        if not page or self.identity(db, page) != goal["identity"]:
            return "identity_changed", None
        latest = db.execute("SELECT * FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (goal["thread_id"],)).fetchone()
        if not latest or latest["id"] != goal["request_id"]:
            return "manual_request_changed", None
        # An ended fault is actionable, even when it also paused the page.
        # Do not present it as a healthy enabled goal merely waiting for resume.
        if latest["cancel_requested"] or latest["phase"] in ("blocked", "cancelled", "failed"):
            return "request_needs_attention", None
        if db.execute("SELECT 1 FROM managed_attention WHERE request_id=?", (goal["request_id"],)).fetchone():
            return "request_needs_attention", None
        if db.execute("SELECT 1 FROM managed_page_issues WHERE page_id=?", (page["page_id"],)).fetchone():
            return "page_needs_attention", None
        if page["paused"] or page["phase"] != "bound":
            return "page_paused", None
        binding = db.execute("SELECT enabled FROM host_bindings WHERE thread_id=?", (goal["thread_id"],)).fetchone()
        if not binding or not binding[0]:
            return "page_paused", None
        if latest["phase"] != "completed":
            return "working", None
        run = db.execute("SELECT * FROM host_runs WHERE controller_request=? ORDER BY created DESC LIMIT 1", (latest["id"],)).fetchone()
        direct=json.loads(page['settings']).get('conversation_mode')=='direct'
        if not run and direct:run={'id':None,'state':'closed','controller_thread':goal['thread_id'],'reason':'controller_summary'}
        if not run or run["state"] != "closed":
            return "waiting_for_run_close", None
        if run["controller_thread"] != goal["thread_id"] or run["reason"] != "controller_summary":
            return "final_evidence_invalid", None
        if db.execute("SELECT 1 FROM host_team_maintenance WHERE run_id=? AND state IN ('holding','settled')", (run["id"],)).fetchone():
            return "page_paused", None
        if db.execute("SELECT 1 FROM host_team_leases WHERE run_id=?", (run["id"],)).fetchone():
            return "waiting_for_run_close", None
        if db.execute("SELECT 1 FROM host_team_work w JOIN host_requests r ON r.id=w.request_id WHERE w.run_id=? AND r.phase NOT IN ('completed','cancelled','blocked','failed')", (run["id"],)).fetchone():
            return "waiting_for_run_close", None
        if db.execute("SELECT 1 FROM host_delegations d LEFT JOIN host_requests r ON r.id=d.child_request_id WHERE d.parent_request_id=? AND (r.id IS NULL OR r.phase NOT IN ('completed','cancelled','blocked','failed'))", (latest["id"],)).fetchone():
            return "waiting_for_run_close", None
        if db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')", (goal["thread_id"],)).fetchone():
            return "original_execution_unknown", None
        if db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')", (goal["thread_id"],)).fetchone():
            return "original_execution_unknown", None
        for sql, arg in [
            ("SELECT 1 FROM managed_attention WHERE request_id=?", latest["id"]),
            ("SELECT 1 FROM managed_page_issues WHERE page_id=?", page["page_id"]),
            ("SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0", page["page_id"]),
            ("SELECT 1 FROM host_unread_notes WHERE request_id=?", latest["id"]),
        ]:
            if db.execute(sql, (arg,)).fetchone():
                return "request_needs_attention", None
        from harness_goal_evidence import original_result
        reason, artifact = original_result(db,page,latest['id'])
        if reason:return reason,None
        if not artifact:
            return "final_evidence_missing", None
        artifact = dict(artifact)
        if artifact["request_id"] != goal["request_id"] or artifact["thread_id"] != goal["thread_id"]:
            return "final_evidence_invalid", None
        path = Path(artifact["path"]).resolve()
        stores = ((self.root / '.local/harness/managed-results').resolve(), (self.path.parent / 'managed-results').resolve())
        if not any(path.is_relative_to(store) for store in stores):
            return "final_evidence_invalid", None
        try:
            data = path.read_bytes()
        except OSError:
            return "final_evidence_missing", None
        if hashlib.sha256(data).hexdigest() != artifact["sha256"] or len(data) != artifact["bytes"]:
            return "final_evidence_invalid", None
        if any(line.strip() in ('CLW_GOAL_STATUS: delivered','CLW_GOAL_STATUS: complete') for line in data.decode('utf-8').splitlines()):
            return 'delivered',None
        if "CLW_GOAL_STATUS: ready_for_review" in data.decode("utf-8").splitlines():
            return "ready_for_review", None
        if 'CLW_GOAL_STATUS: waiting' in data.decode('utf-8').splitlines() and goal.get('result_status')!='resuming':
            from harness_goal_control import apply_result
            apply_result(db,page,goal['request_id'],data.decode('utf-8'))
            fresh=db.execute('SELECT state FROM managed_goals WHERE page_id=?',(page['page_id'],)).fetchone()
            return 'waiting_external_results' if fresh['state']=='waiting' else 'waiting_details_required',None
        if direct:
            from harness_managed_budget import direct_values
            budget=direct_values(db,page,time.time())
            if ((budget['available_sends'] is not None and budget['available_sends']<1) or
                    (budget['available_seconds'] is not None and budget['available_seconds']<=0)):
                return 'user_budget_exhausted',None
        return "", artifact

    @staticmethod
    def saved_summary(db, goal, page, request, run):
        """Only the original program-reconciled authenticated tool summary.

        The text's success/failure wording is never a goal-state decision.
        The closed request/run remains history; continuation has a new identity.
        """
        key = "closed-summary-" + request["id"]
        artifact = db.execute("SELECT * FROM managed_artifacts WHERE id=? AND source='authenticated_team_final_summary'", (key,)).fetchone()
        if not artifact:
            return "final_evidence_missing", None
        reconciled = db.execute("SELECT seq,data FROM events WHERE thread_id=? AND kind='managed_saved_final_reconciled' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1", (goal["thread_id"], request["id"])).fetchone()
        if not reconciled:
            return "final_evidence_invalid", None
        try:
            proof = json.loads(reconciled["data"])
            if not isinstance(proof, dict):
                return "final_evidence_invalid", None
            source_seq = proof.get("source_event_seq")
            summary = db.execute("SELECT seq,data FROM events WHERE seq=? AND thread_id=? AND kind='team_final_summary'", (source_seq, goal["thread_id"])).fetchone() if type(source_seq) is int else None
            saved = json.loads(summary["data"]) if summary else {}
            reply = db.execute("SELECT request_id,response FROM host_replies WHERE id=?", (key,)).fetchone()
            response = json.loads(reply["response"]) if reply else {}
            if not isinstance(saved, dict) or not isinstance(response, dict):
                return "final_evidence_invalid", None
            failure = db.execute("SELECT seq,data FROM events WHERE thread_id=? AND kind='control_browser_result_failed' AND json_extract(data,'$.request_id')=? AND seq>? AND seq<? ORDER BY seq DESC LIMIT 1", (goal["thread_id"], request["id"], source_seq or 0, reconciled["seq"])).fetchone()
            result = db.execute("SELECT seq FROM events WHERE thread_id=? AND kind='host_result' AND json_extract(data,'$.request_id')=? AND json_extract(data,'$.status')='completed' AND seq>? AND seq<? ORDER BY seq DESC LIMIT 1", (goal["thread_id"], request["id"], failure["seq"] if failure else 0, reconciled["seq"])).fetchone()
            spec = json.loads(db.execute("SELECT spec FROM host_bindings WHERE thread_id=?", (goal["thread_id"],)).fetchone()[0])
            if (not summary or saved.get("request_id") != request["id"] or saved.get("run_id") != run["id"]
                    or saved.get("project_acceptance") is not False or proof.get("project_acceptance") is not False
                    or type(proof.get("model_sends")) is not int or proof["model_sends"] != 0
                    or not isinstance(proof.get("path"), str)
                    or Path(proof["path"]).resolve() != Path(artifact["path"]).resolve() or not failure or not result
                    or not reply or reply["request_id"] != request["id"]
                    or response.get("request_id") != request["id"] or response.get("thread_id") != goal["thread_id"]
                    or response.get("reply_id") != key or response.get("phase") != "completed"
                    or response.get("source") != "project_host_receipt"
                    or not isinstance(spec.get("session_id"), str) or not spec["session_id"]):
                return "final_evidence_invalid", None
            body = "本轮已保存的工具总结（网页最终回答失败，由程序回收；不代表项目全部验收）：\n\n" + saved["text"]
            if saved.get("references"):
                body += "\n\n交接引用：\n" + "\n".join("- " + x for x in saved["references"])
            if hashlib.sha256(body.encode()).hexdigest() != artifact["sha256"]:
                return "final_evidence_invalid", None
            browser = Goals.saved_browser_identity(db, goal, request, failure, reconciled["seq"])
            if not browser:
                return "original_browser_identity_missing", None
        except (KeyError, TypeError, ValueError):
            return "final_evidence_invalid", None
        return "", {**dict(artifact), "saved_summary": {"run_id": run["id"], "source_seq": source_seq,
                    "reconciled_seq": reconciled["seq"], "session_id": spec["session_id"], "url": page["url"], **browser}}

    @staticmethod
    def saved_browser_identity(db, goal, request, failure, reconciled_seq):
        """The failed accepted attempt and its durable *sent* user identity.

        control_attempts.user_hash is the pre-Send baseline and must never be
        used as the sent message's hash. A failure may delete its receipt. The
        public marker identity is then independently derivable from the original
        accepted attempt: page-dom.cjs userIdentity (unique fallback-turn marker)
        and web-driver.cjs hash/userTurnHash use this exact UTF-8 SHA256 formula.
        Noncanonical DOM identities still need their durable receipt/event.
        """
        failed = json.loads(failure["data"])
        if not isinstance(failed, dict):
            return None
        attempt_id = failed.get("attempt_id")
        if (not isinstance(attempt_id, str) or len(attempt_id) != 40 or not attempt_id.startswith("control_")
                or any(c not in "0123456789abcdef" for c in attempt_id[8:])
                or failed.get("failure_kind") != "generation_failed"):
            return None
        attempt = db.execute("SELECT * FROM control_attempts WHERE id=? AND request_id=? AND thread_id=? AND generation=1 AND state='acknowledged' AND dispatched IS NOT NULL AND acknowledged IS NOT NULL", (attempt_id, request["id"], goal["thread_id"])).fetchone()
        latest = db.execute("SELECT id FROM control_attempts WHERE request_id=? AND acknowledged IS NOT NULL ORDER BY acknowledged DESC,rowid DESC LIMIT 1", (request["id"],)).fetchone()
        if not attempt or not latest or latest[0] != attempt_id:
            return None
        receipt = db.execute("SELECT sent_user_hash FROM control_browser_receipts WHERE attempt_id=? AND request_id=? AND thread_id=? AND claim_id=?", (attempt_id, request["id"], goal["thread_id"], request["claim_id"])).fetchone()
        event = db.execute("SELECT seq,kind,data FROM events WHERE thread_id=? AND kind IN ('managed_browser_identity_reconciled','managed_failed_turn_identity_reconciled') AND json_extract(data,'$.request_id')=? AND json_extract(data,'$.attempt_id')=? AND seq<? ORDER BY seq DESC LIMIT 1", (goal["thread_id"], request["id"], attempt_id, reconciled_seq)).fetchone()
        sent_hash = receipt[0] if receipt else None
        source = "original_browser_receipt" if receipt else "canonical_public_marker"
        if event:
            identity = json.loads(event["data"])
            proofs = ({"unique_public_marker_and_terminal_failure", "unique_public_marker_and_tool_outcome",
                       "original_authenticated_wait_receipt", "verified_text_v1_public_turn"}
                      if event["kind"] == "managed_browser_identity_reconciled"
                      else {"unique_public_marker_and_saved_generation_failure"})
            if (identity.get("proof") not in proofs or identity.get("request_replayed") is not False
                    or (receipt and sent_hash != identity.get("user_hash"))):
                return None
            sent_hash = identity.get("user_hash")
            source = "original_authenticated_identity_event"
        elif not receipt:
            sent_hash = hashlib.sha256(("managed-public:[CLW:" + attempt_id + "]:user").encode("utf-8")).hexdigest()
        if (not isinstance(sent_hash, str) or len(sent_hash) != 64
                or any(c not in "0123456789abcdef" for c in sent_hash) or sent_hash == attempt["user_hash"]):
            return None
        return {"attempt_id": attempt_id, "sent_user_hash": sent_hash,
                "identity_source": source, "identity_event_seq": event["seq"] if event else None}

    def original_page_ready(self, goal, artifact):
        """Fresh original browser metadata, without a browser/model action."""
        try:
            status = json.loads((self.root / ".local/web-host/task-status.json").read_text(encoding="utf-8"))
            if not isinstance(status, dict) or not isinstance(status.get("pages"), list):
                return "original_page_observation_unavailable"
            now = time.time()
            age = now - datetime.fromisoformat(status["at"].replace("Z", "+00:00")).timestamp()
            pages = [p for p in status["pages"] if isinstance(p, dict) and p.get("id") == goal["page_id"]]
            if status.get("connected") is not True or not 0 <= age <= 30 or len(pages) != 1:
                return "original_page_observation_unavailable"
            page = pages[0]; observed = page["observation"]
            if not isinstance(observed, dict):
                return "original_page_observation_unavailable"
            if (page.get("bound") is not True or page.get("paused") is not False
                    or observed.get("url") != artifact["saved_summary"]["url"]
                    or type(observed.get("at")) not in (int, float) or not 0 <= now - observed["at"] / 1000 <= 30
                    or observed.get("historyAtLatest") is not True
                    or observed.get("unknown") or observed.get("error")):
                return "original_page_observation_unavailable"
            if (not isinstance(observed.get("attemptId"), str) or not isinstance(observed.get("userTurnHash"), str)):
                return "original_page_identity_unavailable"
            if (observed["attemptId"] != artifact["saved_summary"]["attempt_id"]
                    or observed["userTurnHash"] != artifact["saved_summary"]["sent_user_hash"]):
                return "original_page_identity_changed"
            if any(observed.get(k) is not False for k in ("loginRequired", "approvalRequired")):
                return "original_page_needs_attention"
            if any(observed.get(k) is not False for k in ("generating", "draft", "composing")):
                return "original_page_busy"
        except (OSError, ValueError, KeyError, TypeError):
            return "original_page_observation_unavailable"
        return ""

    def original_jobs_ready(self, artifact):
        """Read current original-Session activity outside SQLite locks."""
        session = artifact["saved_summary"]["session_id"]
        try:
            reply = read_session_inventory(self.root, session, local_runtime_read)
            output = checked_inventory(reply, session); jobs = output['jobs']
            if any(j["status"] in ACTIVE for j in jobs):
                return "waiting_for_original_jobs"
            if output['truncated'] or any(not job_terminal(j) for j in jobs):
                return "original_jobs_unknown"
        except JobInventoryError:
            return "original_jobs_unknown"
        except (OSError, ValueError, KeyError, TypeError, AdmissionError):
            return "original_jobs_probe_unavailable"
        return ""

    @staticmethod
    def wait_state(reason):
        return ("active" if reason in ("working", "waiting_for_run_close", "page_paused",
                                      "waiting_for_original_jobs", "original_page_observation_unavailable", "original_page_busy",
                                      "original_browser_identity_missing", "original_page_identity_unavailable")
                else "complete" if reason == "delivered" else "waiting" if reason=='waiting_external_results'
                else "ready_for_review" if reason == "ready_for_review" else "needs_attention")

    def wait_ready(self,goal):
        """Observe only the submitted originals; a polling fault retains waiting."""
        context=json.loads(goal['wait_context']) if goal.get('wait_context') else None
        if not context:return 'waiting_details_required'
        jobs=context['job_ids'];session=context.get('session_id')
        try:
            for offset in range(0,len(jobs),8):
                batch=jobs[offset:offset+8]
                reply=local_runtime_read(self.root,'observe_jobs',{'items':[{'job_id':j} for j in batch],'tail_lines':1})
                data=reply.get('structuredContent',{}) if isinstance(reply,dict) else {}
                output=data.get('output',{}) if isinstance(data,dict) else {}
                rows=output.get('items') if isinstance(output,dict) else None
                if reply.get('isError') or data.get('success') is not True or not isinstance(rows,list) or len(rows)!=len(batch):return 'waiting_observation_unavailable'
                for index,row in enumerate(rows):
                    if not isinstance(row,dict) or row.get('index')!=index or row.get('job_id')!=batch[index] or row.get('success') is not True:return 'waiting_original_job_unavailable'
                    job=row.get('output',{})
                    if not isinstance(job,dict) or (session and job.get('session_id')!=session):return 'waiting_original_job_identity_changed'
                    if job.get('status') in ACTIVE:return 'waiting_external_results'
                    if not job_terminal(job) or job.get('terminal') is not True:return 'waiting_original_job_unknown'
            return ''
        except (OSError,ValueError,KeyError,TypeError,AdmissionError):return 'waiting_observation_unavailable'

    def flush_notes(self,info):
        """Queued human input also continues ordinary conversations without Goal."""
        import harness_next_round as next_round
        with self.db() as db:
            rows=[dict(r) for r in db.execute('''SELECT DISTINCT p.* FROM managed_pages p JOIN managed_next_round_notes n ON n.page_id=p.page_id
              LEFT JOIN managed_next_round_batches b ON b.id=n.batch_id WHERE b.id IS NULL OR b.state='prepared' ''')]
        for page in rows:
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                current=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page['page_id'],)).fetchone()
                existing=db.execute("SELECT * FROM managed_next_round_batches WHERE page_id=? AND state='prepared' ORDER BY created LIMIT 1",(page['page_id'],)).fetchone()
                prior=db.execute('SELECT * FROM operations WHERE id=?',(existing['id'],)).fetchone() if existing else None
                if prior:
                    batch=dict(existing);original=dict(prior)
                else:
                    if not current or not next_round.ready(db,current):continue
                    goal=db.execute("SELECT * FROM managed_goals WHERE page_id=? AND state IN ('active','waiting') AND control_mode='automatic'",(page['page_id'],)).fetchone()
                    followup=('继续未完成的完整目标：'+goal['objective']) if goal else ''
                    if goal and goal['wait_context']:
                        followup+='\n原等待与接续点：'+goal['wait_context']
                    batch=next_round.prepare(None,db,current,followup)
                    if not batch:continue
                    original=None
            if original:
                # Any existing accepted or unknown operation is queried only.
                try:self.operator.request('receipt?request_id='+batch['id'])
                except (OSError,ValueError):pass
                continue
            try:
                self.operator.request('command',{'request_id':batch['id'],'thread_id':batch['thread_id'],
                    'action':'message.send','data':{'text':batch['text']}},info['intent'])
            except (OSError,ValueError):pass

    def reconcile(self, goal):
        """Unknown delivery only queries the original operation; never reposts."""
        try:
            receipt = self.operator.request("receipt?request_id=" + goal["pending_id"])
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                self.state(goal["page_id"], "needs_attention", "submission_unknown_no_replay",observed=True)
            return
        result = receipt.get("result") or {}
        if receipt.get("state") == "completed" and result.get("request_id") == goal["pending_id"]:
            with self.db() as db:
                db.execute("UPDATE managed_goals SET request_id=pending_id,pending_id=NULL,cycles=cycles+1,reason='',updated=? WHERE page_id=? AND pending_id=? AND state IN ('active','waiting')",
                           (time.time(), goal["page_id"], goal["pending_id"]))
        elif receipt.get("state") in ("failed", "unknown"):
            self.state(goal["page_id"], "needs_attention", "submission_" + receipt["state"],observed=True)

    def tick(self):
        if not self.health():
            return
        info = self.operator.request("info")
        self.flush_notes(info)
        with self.db() as db:
            goals = [dict(r) for r in db.execute("SELECT * FROM managed_goals WHERE state IN ('active','waiting') AND control_mode='automatic'")]
        for goal in goals:
            if info.get("store_id") != goal["store_id"]:
                self.state(goal["page_id"], "needs_attention", "store_changed",observed=True)
                continue
            if goal["pending_id"]:
                self.reconcile(goal)
                continue
            if goal['state']=='waiting':
                reason=self.wait_ready(goal)
                with self.db() as db:
                    if reason:
                        # Read failures are observer status, not failed model work.
                        db.execute("UPDATE managed_goals SET reason=?,updated=? WHERE page_id=? AND state='waiting' AND request_id=?",
                                   (reason,time.time(),goal['page_id'],goal['request_id']))
                        continue
                    db.execute("UPDATE managed_goals SET state='active',result_status='resuming',reason='external_results_ready',updated=? WHERE page_id=? AND state='waiting' AND request_id=?",
                               (time.time(),goal['page_id'],goal['request_id']))
                goal={**goal,'state':'active','result_status':'resuming'}
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                current = db.execute("SELECT * FROM managed_goals WHERE page_id=?", (goal["page_id"],)).fetchone()
                if not current or current["state"] != "active" or current["pending_id"] or current["request_id"] != goal["request_id"]:
                    continue
                goal = dict(current)
                reason, artifact = self.eligible(db, goal)
                if reason:
                    db.execute("UPDATE managed_goals SET state=?,reason=?,updated=? WHERE page_id=?", (self.wait_state(reason), reason, time.time(), goal["page_id"]))
                    continue
                operation = "goal-" + hashlib.sha256((goal["page_id"] + goal["request_id"]).encode()).hexdigest()[:48]
                if not artifact.get("saved_summary"):
                    db.execute("UPDATE managed_goals SET pending_id=?,reason='submitting',updated=? WHERE page_id=?", (operation, time.time(), goal["page_id"]))
            if artifact.get("saved_summary"):
                reason = self.original_page_ready(goal, artifact)
                if not reason:
                    reason = self.original_jobs_ready(artifact)
                with self.db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    current = db.execute("SELECT * FROM managed_goals WHERE page_id=?", (goal["page_id"],)).fetchone()
                    if not current or dict(current) != goal:
                        continue
                    current_reason, current_artifact = self.eligible(db, goal)
                    if current_reason:
                        reason = current_reason
                    elif current_artifact != artifact:
                        reason = "final_evidence_changed_during_probe"
                    elif not reason:
                        reason = self.original_page_ready(goal, artifact)
                    if reason:
                        db.execute("UPDATE managed_goals SET state=?,reason=?,updated=? WHERE page_id=?", (self.wait_state(reason), reason, time.time(), goal["page_id"]))
                        continue
                    db.execute("UPDATE managed_goals SET pending_id=?,reason='submitting',updated=? WHERE page_id=?", (operation, time.time(), goal["page_id"]))
            ending = ("上一回合已结束并回收已保存总结，先读取完整引用结果并继续原完整目标。原保存总结："
                      if artifact.get("saved_summary") else "上一完整工作包已结清，原结果：")
            text = ((goal['objective']+'\n\n' if goal['cycles']==0 else '')+"继续未完成的完整目标。" + "\n\n" + ending + artifact["path"]
                    + "\nSHA256：" + artifact["sha256"]
                    + ("\n所等结果已到齐，沿保存接续点继续。" if goal.get('wait_context') else '')
)
            try:
                self.operator.request("command", {"request_id": operation, "thread_id": goal["thread_id"],
                                      "action": "message.send", "data": {"text": text}}, info["intent"])
            except (OSError, ValueError):
                # The intent was saved before POST. Next tick reconciles its one
                # existing operation, including crash-after-acceptance recovery.
                continue
            self.reconcile({**goal, "pending_id": operation})


@contextmanager
def singleton(path):
    with FileLease(path):
        yield


def start_if_enabled(root=ROOT):
    """Explicit startup/ensure: reuse the actual source or request idle reload."""
    root = Path(root).resolve()
    if not (root / ".local/harness/harness.sqlite3").is_file():
        return {'state': 'watcher_not_enabled'}
    goals = Goals(root)
    with goals.db() as db:
        pending=bool(db.execute('''SELECT 1 FROM managed_next_round_notes n LEFT JOIN managed_next_round_batches b ON b.id=n.batch_id
                                   WHERE b.id IS NULL OR b.state='prepared' LIMIT 1''').fetchone())
    if not pending and not any(g["state"] in ('active','waiting') for g in goals.status()):
        return {'state': 'watcher_not_enabled'}
    version = source_version(root)
    status_path = root / '.local/harness/goal-watch.json'
    status = read_json(status_path, 65536) if status_path.exists() else None
    if status:
        owner = watch_owner(root, status)
        if owner:
            loaded = status.get('source_sha256')
            if status.get('protocol') != 1 or status.get('root') != str(root) or not status.get('creation_filetime') or \
               not isinstance(loaded, str) or len(loaded) != 64 or any(c not in '0123456789abcdef' for c in loaded):
                return {'state': 'requires_original_idle_update', **owner, 'source_sha256': version}
            if status.get('source_sha256') == version:
                return {'state': 'watcher_reused', **owner, 'source_sha256': version}
            request = {'protocol': 1, 'root': str(root), **owner,
                       'previous_source_sha256': status['source_sha256'], 'source_sha256': version}
            atomic_json(root / '.local/harness/goal-watch-reload.json', request)
            return {'state': 'watcher_idle_reload_requested', **owner, 'source_sha256': version}
    starting = _STARTING.get(str(root))
    if starting and starting[0].poll() is None:
        return {'state': 'watcher_start_requested', 'pid': starting[0].pid, 'source_sha256': starting[1]}
    return _spawn_watcher(root, version)


def ensure_watcher(host):
    """Reuse the one existing watcher when new opt-in work is saved."""
    if host.state.path.resolve()!=(host.root/'.local/harness/harness.sqlite3').resolve():return
    try:
        result = start_if_enabled(host.root)
    except (OSError,ValueError,RuntimeError,sqlite3.Error):
        # Input and result receipts are already saved; observation cannot undo them.
        result = {'state': 'watcher_observation_unavailable'}
    host._personal_goal_watch_status = result
    return result


def watch(goals, *, expected_source=None, sleep=time.sleep):
    """One original ledger owner. Reload only at a requested tick boundary."""
    root = goals.root
    version = source_version(root)
    if expected_source is not None and expected_source != version:raise ValueError('watcher_source_changed')
    from windows_process_owner import process_identity
    owner = process_identity(os.getpid())
    identity = {'protocol': 1, 'root': str(root), 'pid': os.getpid(),
                'creation_filetime': owner['CreationFiletime'], 'source_sha256': version}
    status = root / '.local/harness/goal-watch.json'
    request_path = root / '.local/harness/goal-watch-reload.json'
    reload_version = None
    with singleton(root / '.local/harness/goal-watch.lock'):
        def publish(phase, error=None):
            atomic_json(status, {**identity, 'phase': phase, 'at': time.time(), 'error': error, 'goals': goals.status()})
        publish('idle')
        while True:
            request = read_json(request_path, 8192) if request_path.exists() else None
            # An old/foreign request never transfers the lock or starts a peer.
            if request and all(request.get(k) == identity[k] for k in ('protocol', 'root', 'pid', 'creation_filetime')) and \
               request.get('previous_source_sha256') == version and request.get('source_sha256') != version:
                if request['source_sha256'] != source_version(root):
                    publish('idle', 'watcher_reload_source_changed')
                    sleep(20);continue
                else:
                    reload_version = request['source_sha256'];publish('reloading');break
            publish('inflight')
            error = None
            try:goals.tick()
            except (OSError, ValueError, sqlite3.Error):error = 'local_service_unavailable'
            publish('idle', error)
            sleep(20)
    # The same existing startup path launches only after the kernel lock releases.
    return _spawn_watcher(root, reload_version)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("action", choices=("enable", "status", "pause", "resume", "update-objective", "adopt-request", "complete", "once", "watch"))
    parser.add_argument("--page")
    parser.add_argument("--objective-file", type=Path)
    parser.add_argument("--reason", default="")
    parser.add_argument("--expected-request")
    parser.add_argument("--request")
    parser.add_argument('--expected-source-sha256')
    args = parser.parse_args(); goals = Goals(args.root)
    if args.action == "enable":
        goals.enable(args.page, args.objective_file.read_text(encoding="utf-8"))
    elif args.action in ("pause", "resume", "complete"):
        goals.state(args.page, {"pause": "paused", "resume": "active", "complete": "complete"}[args.action], args.reason)
    elif args.action == 'update-objective':
        if not args.objective_file:
            parser.error('--objective-file is required')
        goals.update_objective(args.page, args.expected_request, args.objective_file.read_text(encoding='utf-8'), args.reason)
    elif args.action == 'adopt-request':
        objective = args.objective_file.read_text(encoding='utf-8') if args.objective_file else None
        goals.adopt_request(args.page, args.expected_request, args.request, args.reason, objective)
    elif args.action == "once":
        goals.tick()
    elif args.action == "watch":
        watch(goals, expected_source=args.expected_source_sha256)
        return
    print(json.dumps(goals.status(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
