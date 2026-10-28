"""Observable worker timing for M's task sizing; never claims hidden thinking time."""
import json
def result_timing(db, request_id):
    tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {'control_attempts','control_browser_receipts','managed_artifacts'}<=tables:
        return {'state':'unavailable','reason':'browser_timing_not_recorded'}
    rows=db.execute('''SELECT a.id,a.acknowledged,a.epoch,b.completed,
      (SELECT MAX(m.created) FROM managed_artifacts m WHERE m.id=a.id||'-tool'
       AND m.source='local_mcp_public_result') AS tool_result_saved
      FROM control_attempts a LEFT JOIN control_browser_receipts b ON b.attempt_id=a.id
      WHERE a.request_id=? ORDER BY a.offered''',(request_id,)).fetchall()
    rounds=[]
    if 'managed_pages' in tables:
        first=db.execute("SELECT page_id,settings FROM managed_pages WHERE json_extract(settings,'$.first_task_request_id')=?",(request_id,)).fetchone()
        if first:
            settings=json.loads(first['settings']);start=settings.get('bootstrap_sent_at')
            artifact=db.execute('SELECT created FROM managed_artifacts WHERE id=? AND source=?',('first-task-'+first['page_id'],'local_mcp_public_result')).fetchone()
            end=artifact[0] if artifact else None
            rounds.append({'attempt_id':'bootstrap:'+first['page_id'],'sent_at':start,'result_saved_at':end,
                'observed_seconds':round(end-start,3) if start is not None and end is not None and end>=start else None,
                'timing_quality':'saved_tool_result' if end is not None else 'unfinished_or_unknown','recovery':False})
    for row in rows:
        start=row['acknowledged'];end=row['tool_result_saved'] if row['tool_result_saved'] is not None else row['completed']
        seconds=round(end-start,3) if start is not None and end is not None and end>=start else None
        rounds.append({'attempt_id':row['id'],'sent_at':start,'result_saved_at':end,
          'observed_seconds':seconds,'timing_quality':'saved_tool_result' if row['tool_result_saved'] is not None else 'collection_upper_bound' if end is not None else 'unfinished_or_unknown',
          'recovery':row['epoch']<0})
    measured=[r for r in rounds if r['observed_seconds'] is not None]
    return {'state':'observed' if measured else 'unfinished_or_unknown','rounds':rounds,
      'confirmed_sends':sum(r['sent_at'] is not None for r in rounds),
      'recovery_sends':sum(r['recovery'] and r['sent_at'] is not None for r in rounds),
      'saved_round_seconds':round(sum(r['observed_seconds'] for r in measured),3),
      'short_completed_rounds':[r['attempt_id'] for r in measured if r['timing_quality']=='saved_tool_result' and r['observed_seconds']<1800],
      'basis':'Confirmed send to saved result. Includes network, tools and any in-round pauses; excludes pre-send queue and gaps between rounds. DOM-only collection may be delayed and is an upper bound. Not hidden thinking or CPU time.',
      'planning_note':'按至少半小时、尽量更长的实质工作量组织下一包。短回合只作为调整任务量的线索；结合成果、结束原因和故障判断，不空等、不重做已完成工作，也不按时长判数学或开发质量。'}
