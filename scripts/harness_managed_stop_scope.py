"""Read-only ownership for one current request, never an execution grant."""

def stop_scope(db, page, request):
    if not request or not page['thread_id']:
        return None
    owned = db.execute('SELECT thread_id FROM host_requests WHERE id=?', (request['id'],)).fetchone()
    if not owned or owned['thread_id'] != page['thread_id']:
        return None
    run = db.execute('SELECT * FROM host_runs WHERE controller_request=? AND controller_thread=?',
                     (request['id'], page['thread_id'])).fetchone()
    delegation = None
    if not run:
        run = db.execute('SELECT r.* FROM host_team_work w JOIN host_runs r ON r.id=w.run_id WHERE w.request_id=?',
                         (request['id'],)).fetchone()
        delegation = db.execute('SELECT * FROM host_delegations WHERE child_request_id=? AND child_thread_id=? AND child_target_id=?',
                                (request['id'], page['thread_id'], page['target_id'])).fetchone()
        if not run or not delegation:
            return None
    controller = db.execute('SELECT target_id FROM host_bindings WHERE thread_id=?', (run['controller_thread'],)).fetchone()
    if not controller:
        return None
    parent_request = delegation['parent_request_id'] if delegation else None
    original_parent_request = parent_request
    parent_target = page['parent_target']
    if delegation:
        binding = db.execute('SELECT target_id FROM host_bindings WHERE thread_id=?', (delegation['parent_thread_id'],)).fetchone()
        if not binding or binding['target_id'] != parent_target:
            return None
        # A worker may have been assigned before its controller handed over.
        # Only an activated handoff in this exact run transfers the owner.
        seen = set()
        while parent_request:
            if parent_request in seen:
                return None
            seen.add(parent_request)
            handoff = db.execute("SELECT successor_page,successor_request FROM managed_handoffs WHERE source_request=? AND run_id=? AND state='active'",
                                 (parent_request, run['id'])).fetchone()
            if not handoff:
                break
            successor = db.execute('SELECT target_id,thread_id FROM managed_pages WHERE page_id=?', (handoff['successor_page'],)).fetchone()
            successor_request = db.execute('SELECT thread_id FROM host_requests WHERE id=?', (handoff['successor_request'],)).fetchone()
            if not successor or not successor_request or successor_request['thread_id'] != successor['thread_id']:
                return None
            parent_target, parent_request = successor['target_id'], handoff['successor_request']
    return {'request_id':request['id'],'run_id':run['id'],'controller_target':controller['target_id'],
            'controller_request':run['controller_request'],'parent_target':parent_target,
            'parent_request_id':parent_request,'original_parent_request_id':original_parent_request}
