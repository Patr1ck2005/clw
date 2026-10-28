"""Enrollment diagnostics are separate from execution/authorization receipts."""
import json,re
from harness_state import require,canonical,HarnessError
from harness_control_plane import digest
from harness_team_scopes import validate_access


def redact(value):
    return re.sub(r'(?:clwm_[A-Za-z0-9_-]+|wc_sess_[A-Za-z0-9_-]+|CLW-MANAGED:[A-Za-z0-9:_-]+)', '[接入凭据已隐藏]', value)


class IntakeDiagnostics:
    def __init__(self,host,db):
        self.host=host
        db.executescript('''
        CREATE TABLE IF NOT EXISTS managed_intake_reports(
          page_id TEXT PRIMARY KEY,source_hash TEXT NOT NULL,url TEXT NOT NULL,
          public_text TEXT NOT NULL,observed REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS managed_intake_rejections(
          fingerprint TEXT PRIMARY KEY,page_id TEXT NOT NULL,operation_id TEXT NOT NULL,
          code TEXT NOT NULL,status INTEGER NOT NULL,observed REAL NOT NULL);
        ''')

    def observe(self,db,p):
        require(set(p)=={'page_id','source_hash','url','public_text'},'managed_intake_report_fields')
        page=db.execute('SELECT phase,bootstrap_state FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
        require(page and page['phase']!='bound' and page['bootstrap_state']!='pending','managed_intake_report_not_applicable',409)
        require(isinstance(p['source_hash'],str) and re.fullmatch('[0-9a-f]{64}',p['source_hash']),'managed_intake_report_hash')
        require(isinstance(p['url'],str) and re.fullmatch(r'https://chatgpt\.com/c/[A-Za-z0-9-]{1,128}',p['url']),'managed_intake_report_url')
        require(isinstance(p['public_text'],str) and 0<len(p['public_text'])<=6000,'managed_intake_report_text')
        old=db.execute('SELECT source_hash FROM managed_intake_reports WHERE page_id=?',(p['page_id'],)).fetchone()
        if old and old[0]==p['source_hash']:return {'changed':False}
        db.execute('INSERT OR REPLACE INTO managed_intake_reports VALUES(?,?,?,?,?)',
                   (p['page_id'],p['source_hash'],p['url'],redact(p['public_text']),self.host.clock()))
        return {'changed':True,'source':'public_web_reply','execution_state_changed':False}

    def rejected(self,db,data,error):
        # Host authentication has already succeeded. A wrong ticket cannot
        # attach an audit entry to someone else's page. No raw payload is saved.
        p=data.get('payload',{});page=db.execute('SELECT ticket_hash FROM managed_pages WHERE target_id=?',(data.get('target_id'),)).fetchone()
        if not page or not isinstance(p,dict) or not isinstance(p.get('ticket'),str) or digest(p['ticket'])!=page[0]:return
        db.execute('INSERT OR IGNORE INTO managed_intake_rejections VALUES(?,?,?,?,?,?)',
                   (digest(canonical(data)),data['target_id'],data['operation_id'],error.code,error.status,self.host.clock()))

    @staticmethod
    def can_edit(page):
        return bool(page['phase']=='reserved' and not page['thread_id'] and not page['parent_target'] and page['paused'] and page['bootstrap_state']=='sent')

    def configure(self,db,p):
        require(set(p)=={'page_id','access','write_paths','expected_access','expected_write_paths'},'managed_intake_config_fields')
        page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
        require(page and self.can_edit(page),'managed_intake_scope_not_editable',409)
        settings=json.loads(page['settings'])
        require(settings['access']==p['expected_access'] and settings['write_paths']==p['expected_write_paths'],'managed_intake_settings_changed',409)
        paths,_=validate_access(p['access'],p['write_paths'],settings.get('resources',[]))
        settings['access']=p['access'];settings['write_paths']=paths
        db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),p['page_id']))
        return {'state':'scope_saved','paused':True,'send_replayed':False,'message':'访问范围已保存。原对话、错误和暂停保留，尚未重试接入；请先核对原工具拒绝原因。'}

    def view(self,db,page):
        report=db.execute('SELECT source_hash,url,public_text,observed FROM managed_intake_reports WHERE page_id=?',(page['page_id'],)).fetchone()
        rejection=db.execute('SELECT operation_id,code,status,observed FROM managed_intake_rejections WHERE page_id=? ORDER BY observed DESC,rowid DESC LIMIT 1',(page['page_id'],)).fetchone()
        settings=json.loads(page['settings']);configuration_error=None
        try:validate_access(settings.get('access','read'),settings.get('write_paths',[]),settings.get('resources',[]))
        except HarnessError as e:configuration_error=e.code
        return {'configuration_error':configuration_error,
                'can_edit_scope':self.can_edit(page),
                'latest_public_reply':dict(report) if report else None,
                'local_rejection':dict(rejection) if rejection else None,
                'tool_receipt':bool(page['thread_id']),
                'source_note':'网页回复是公开报告；本地拒绝来自实际到达 CLW 的调用。缺少记录不证明工具未执行。'}
