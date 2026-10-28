"""Optional useful work in the existing enrollment turn, with distinct provenance."""
import hashlib,json,re
from harness_state import require


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS managed_preparation_results(
        page_id TEXT PRIMARY KEY,source_hash TEXT NOT NULL,url TEXT NOT NULL,
        path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,created REAL NOT NULL)''')


def instructions(payload):
    value=payload.get('first_turn_instructions','')
    require(isinstance(value,str) and len(value)<=24000,'managed_preparation_instructions')
    return value.strip()


def result_delivery(managed, binding, request, operation_id):
    """Self-contained existing CLI contract, returned with the real claim.

    No extra file read, context call or authority is needed to discover how
    to hand back a result. The usual turn-end validation still applies.
    """
    return {
        'argv': ['python', '-X', 'utf8', '-B',
                 str(managed.host.root/'scripts/harness_managed_client.py'), 'turn-end',
                 '--store-id', managed.state.id, '--target', binding['target_id'],
                 '--session-id', binding['spec']['session_id'],
                 '--operation-id', 'result-'+hashlib.sha256(
                     (request['id']+':'+str(request['claim_id'])+':'+operation_id).encode()).hexdigest()],
        'payload': {'request_id': request['id'], 'claim_id': request['claim_id'],
                    'outcome': 'yielded' if request['phase']=='suspended' else 'completed',
                    'markdown': '<本轮完整结果>'},
        'usage': '将 payload 的 markdown 替换成完整结果；将 payload 序列化为 JSON，作为单一参数追加 --payload-json。'
                 '结果已有范围内文件时可用 markdown_path 替代 markdown，填写相对于执行工程的路径，不用绝对路径，不必另建文件。'
                 'completed 表示本包完成，needs_attention 仅用于已无必要工作可继续且需外部处理，yielded 仅用于已让出等待。'
                 '工作期间收到的用户补充由程序保留到下一轮，本轮正常交付。'
                 '回包未知先核对原操作，不重复执行。无须为收尾读取管理手册。',
    }


def prompt(value,first_turn_mode=None):
    if not value:return '\n完成后单独原样输出返回的 browser_marker，等待工作目标。'
    if first_turn_mode=='task_v1':
        return ('\nenroll 自动登记原首任务并尝试资源准入；仅在返回 first_task_ready 后按 execution_context 开始工作，无需再次授权或派发同一目标。'
                '若返回 waiting_local_slot，登记已保存；使用返回的原 first_task_operation_id 重核原请求。'
                '保留原回执，不重复 enroll 或已受理操作。'
                '在本轮完成读取、研究或实现、验证、修复与交接；需要分工时再调用同一 CLI 的 context。'
                '\n--- 首个完整任务 ---\n'+value+'\n--- 任务结束 ---\n'
                '返回的 result_delivery 已含原任务的收尾命令与参数；结束前按它保存完整结果，不必为收尾读取管理手册。'
                'outcome：本包完成 completed、确需外部处理且无必要工作可继续 needs_attention、已让出等待 yielded。最后公开回复成果；程序自动核对回执，不为补标记另发消息。')
    return ('\n工具接入成功后，在当前同一轮继续完成下列首次准备要求，不另发一轮。'
            '可读取交接、核对证据、分析问题、制定开发计划与并发角色/目录/依赖方案；'
            '本轮准备只做读取和分析，不运行项目写入、创建 worker 或正式分派。正式执行随后通过受管任务的资源调度进行。'
            '不要使用尚不存在的 request/claim/run，也不要调用 turn-end。'
            '已有资料沿用，不重复读取；资料缺失或某项准备失败时如实列出未完成项，保留已取得的接入回执。'
            '\n--- 用户的首次准备要求 ---\n'+value+
            '\n--- 首次准备要求结束 ---\n在最终回复中给出完整准备成果、文件引用和未决事项，'
            '最后单独原样输出返回的 browser_marker；准备不完整不代表工具接入失败。')


def summary(db,page_id):
    row=db.execute('SELECT * FROM managed_preparation_results WHERE page_id=?',(page_id,)).fetchone()
    if not row:return None
    settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(page_id,)).fetchone()[0])
    return {**dict(row),'source':'enrollment_public_dom_markdown','state':'reply_saved',
            'first_task_request_id':settings.get('first_task_request_id'),'task_outcome':settings.get('first_task_outcome')}


def save(managed,db,page,payload,*,verified_first_turn=False):
    if not json.loads(page['settings']).get('first_turn_instructions'):return
    content=payload.get('preparation_markdown')
    source=payload.get('source_hash','')
    require(isinstance(content,str) and content.strip() and len(content.encode())<=8*1024*1024,
            'managed_preparation_reply_required',409)
    require(re.fullmatch('[0-9a-f]{64}',source or '') and (verified_first_turn or page['marker'] in content),
            'managed_preparation_source_required',409)
    raw=content.encode();sha=hashlib.sha256(raw).hexdigest()
    old=summary(db,page['page_id'])
    if old:
        require(old['source_hash']==source and old['sha256']==sha and old['url']==payload['url'],
                'managed_preparation_result_conflict',409)
        return
    dest=managed.state.path.parent/'managed-results'/(sha+'.md');dest.parent.mkdir(exist_ok=True)
    if not dest.exists():dest.write_bytes(raw)
    db.execute('INSERT INTO managed_preparation_results VALUES(?,?,?,?,?,?,?)',
               (page['page_id'],source,payload['url'],str(dest),sha,len(raw),managed.host.clock()))
    body=content if len(content)<=46000 else content[:1000]+'\n\n完整首次准备回复：'+str(dest)+'\nSHA256: '+sha
    task=json.loads(page['settings']).get('first_turn_mode')=='task_v1'
    managed.host.emit(db,page['thread_id'],'managed_first_task_public_reply' if task else 'managed_preparation_reply',
                      {'text':body,'path':str(dest),'sha256':sha,'source_hash':source,
                       'source':'enrollment_public_dom_markdown','url':payload['url'],
                       'task_completed':False})
