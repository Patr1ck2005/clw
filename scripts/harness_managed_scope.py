"""Narrow an idle task's declared writes through the existing scope registry.

The real Project/Session and its access permissions are retained. This is a
local scheduling change, never authorization for a new native workspace.
"""
import json
from pathlib import Path
from harness_state import require, canonical
from harness_team_common import object_fields, hash_value
from harness_team_scopes import plain_root, validate_access


def narrow(managed, db, payload):
    object_fields(payload, {'page_id', 'operation_id', 'expected_fingerprint',
                            'root', 'write_paths', 'confirm'})
    require(payload['confirm'] is True, 'managed_scope_confirmation_required', 403)
    managed.host.identifier(payload['operation_id'])
    page = db.execute('SELECT * FROM managed_pages WHERE page_id=?', (payload['page_id'],)).fetchone()
    require(page and page['phase'] == 'bound' and not page['parent_target'],
            'managed_scope_bound_controller_required', 409)
    binding = managed.host.binding(db, thread=page['thread_id'])
    actor = binding['spec']['session_id']
    fingerprint = hash_value({'op': 'narrow-workspace', 'payload': payload})
    prior = db.execute('SELECT * FROM host_team_receipts WHERE operation_id=?',
                       (payload['operation_id'],)).fetchone()
    if prior:
        require(prior['operation'] == 'narrow-workspace' and prior['actor'] == actor
                and prior['fingerprint'] == fingerprint, 'team_operation_conflict', 409)
        return json.loads(prior['response'])
    require(page['paused'], 'managed_scope_pause_required', 409)
    require(not db.execute("SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0",
                           (page['page_id'],)).fetchone(), 'attention_explicit_stop_preserved', 409)
    require(not db.execute('SELECT 1 FROM managed_page_issues WHERE page_id=?',
                           (page['page_id'],)).fetchone(), 'managed_scope_issue_preserved', 409)
    require(not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",
                           (page['thread_id'],)).fetchone(), 'team_active_original_scope_cannot_change', 409)
    require(not db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')",
                           (page['thread_id'],)).fetchone(), 'attention_local_execution_unknown', 409)
    require(not db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')",
                           (page['thread_id'],)).fetchone(), 'attention_dispatch_unknown', 409)
    old = managed.host.team.scopes.scope(db, page['thread_id'])
    managed.host.team.scopes.verify(old)
    require(old['access'] == 'write' and old['root'] == page['root']
            and old['fingerprint'] == payload['expected_fingerprint'],
            'managed_scope_source_changed', 409)
    root = plain_root(payload['root'])
    require(Path(root).is_relative_to(Path(old['root'])), 'managed_scope_must_narrow', 403)
    paths, _ = validate_access('write', payload['write_paths'], [])
    allowed = [Path(old['root']) / p for p in json.loads(old['write_paths'])]
    require(all(any((Path(root) / p).is_relative_to(a) for a in allowed) for p in paths),
            'managed_scope_must_narrow', 403)
    grant = {'target': page['target_id'], 'project': old['project'], 'root': root,
             'access': 'write', 'write_paths': paths, 'resources': json.loads(old['resources']),
             'confirm': True}
    if old.get('git'):
        grant['expected_git_head'] = old['git']['head']
    result = managed.host.team.scopes.grant(db, binding, grant)
    settings = json.loads(page['settings'])
    settings.update(access='write', write_paths=paths,
                    resources=json.loads(managed.host.team.scopes.scope(db, page['thread_id'])['resources']))
    db.execute('UPDATE managed_pages SET root=?,settings=? WHERE page_id=?',
               (root, canonical(settings), page['page_id']))
    db.execute('UPDATE threads SET cwd=? WHERE id=?', (root, page['thread_id']))
    result = {**result, 'state': 'write_scope_narrowed', 'page_id': page['page_id'],
              'write_paths': paths, 'original_project_session_preserved': True, 'model_sends': 0}
    db.execute('INSERT INTO host_team_receipts VALUES(?,?,?,?,?)',
               (payload['operation_id'], actor, 'narrow-workspace', fingerprint, canonical(result)))
    return result
