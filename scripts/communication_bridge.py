"""Pinned, optional native Conversation adapter. No new Job/model executor.
Writes are one bounded request, never Transport.post's read-retry loop. The
shared key/user credential remains inside the explicitly configured transport.
"""
from __future__ import annotations
import json
import re
import time
from urllib.error import HTTPError
from urllib.request import Request
from live_transport import MAX_BODY, NATIVE_JOB_READ_COMMITS, ObservationError
from task_domain import TaskError, bounded, fail, now, txt

NATIVE_COMMIT = '9ae45a2a0ad7e0de170d35075cc7ff12c4b64d98'
TOOLS = {'list_agent_identities', 'read_conversation', 'post_conversation_message'}


def opaque(value, label):
    value = txt(value, label, 160)
    if not re.fullmatch(r'[A-Za-z0-9_-]{3,160}', value):
        fail('communication_identity', label+'不是有界原生身份')
    return value


class CommunicationBridge:
    def __init__(self, transport=None, *, enabled=False):
        self.transport = transport
        self.enabled = enabled is True

    @property
    def namespace(self):
        return self.transport.namespace if self.transport else None

    def capability(self):
        return {'configured': self.transport is not None, 'dispatch_enabled': self.enabled,
                'expected_native_commit': NATIVE_COMMIT, 'source': 'explicit_local_configuration',
                'host_auto_resume_verified': False, 'model_execution_interface': False}

    def check_runtime(self):
        if not self.transport:
            fail('not_configured', '未提供明确的原生通信连接', 409)
        try:
            status = self.transport.post('status', {'compact': True}, time.monotonic()+12)
        except ObservationError:
            fail('communication_unavailable', '无法核对原通信后端；不改用其他入口或凭据', 503)
        # The pinned native compact status publishes server identity in build,
        # not the older deployment's nested server.build projection.
        build = status.get('build')
        if (not isinstance(build, dict) or status.get('version') != '0.4.1' or build.get('git_commit') not in NATIVE_JOB_READ_COMMITS or
                build.get('git_dirty') is not False):
            fail('communication_version', '未运行已固定的通信实现；同名0.4.1不代表具有新宿主协议', 409)
        return status

    def call(self, tool, params):
        if tool not in TOOLS or not self.transport:
            fail('communication_tool', '通信接口未配置或动作不在固定范围', 409)
        if tool == 'post_conversation_message' and not self.enabled:
            fail('communication_disabled', '原生投递未由本机操作者明确启用', 403)
        bounded(params)
        encoded = json.dumps({'tool': tool, 'params': params}, ensure_ascii=False).encode('utf-8')
        if len(encoded) > 20000:
            fail('communication_size', '通信只传递短任务定位，不嵌入日志或全部工程')
        request = Request(self.transport.origin+'/api/tools/call', data=encoded, headers={
            'Authorization': 'Bearer '+self.transport._token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            try:
                response = self.transport.opener.open(request, timeout=8)
            except HTTPError as exc:
                if exc.code != 400:
                    status = exc.code
                    sample = exc.read(16385) if status in (401, 403) else b''
                    exc.close()
                    scopes = sorted(set(re.findall(r'\b[a-z][a-z_]{1,30}:[a-z_*]{1,30}\b', sample[:16384].decode('utf-8', errors='replace'))))
                    code = ('communication_auth_required' if status == 401 else
                            'communication_scope_denied' if status == 403 and scopes else
                            'communication_access_denied' if status == 403 else 'communication_unknown')
                    error = TaskError(code, '原生请求被拒或未确认；核对原连接授权，不更换主体或盲目重发', 503)
                    error.native_http_status = status
                    error.required_scopes = scopes
                    raise error
                response = exc
            with response:
                if response.headers.get_content_type() != 'application/json' or response.headers.get('Content-Encoding','identity') != 'identity':
                    fail('communication_response', '原生响应格式不符；保留原投递身份', 503)
                chunks=[]; size=0; deadline=time.monotonic()+8
                while True:
                    if time.monotonic()>deadline:fail('communication_unknown','原生响应超时；保留原投递身份',503)
                    part=response.read1(min(65536,MAX_BODY+1-size))
                    if not part:break
                    size+=len(part)
                    if size>MAX_BODY:fail('communication_response','原生响应过大',503)
                    chunks.append(part)
                value=json.loads(b''.join(chunks))
            if not isinstance(value,dict) or value.get('success') is not True or not isinstance(value.get('output'),dict):
                fail('communication_rejected', '原生动作没有成功回执，不推断旧请求未发生', 503)
            return value['output']
        except (OSError, ValueError) as exc:
            if isinstance(exc, TaskError):raise
            fail('communication_unknown', '通信结果未知；只保留和核对原身份，不自动重发', 503)

    def check_target(self, agent_id, conversation_id, generation):
        opaque(agent_id,'Agent'); opaque(conversation_id,'Conversation')
        if type(generation) is not int or generation < 0:
            fail('communication_generation', '控制代次需要明确非负整数')
        self.check_runtime()
        result=self.call('list_agent_identities', {'agent_id':agent_id,'offset':0,'limit':2})
        agents=result.get('agents')
        if not isinstance(agents,list) or len(agents)!=1:
            fail('communication_identity', '没有唯一的可见原生Agent', 409)
        agent=agents[0]
        if agent.get('agent_id')!=agent_id or agent.get('current_controller_generation')!=generation:
            fail('communication_generation', '原生控制者已变化；明确核对并重新绑定，不自动改投', 409)
        conversation=self.call('read_conversation', {'conversation_id':conversation_id,'after_seq':0,'limit':1})
        if (conversation.get('conversation',{}).get('conversation_id') != conversation_id or
                not any(p.get('agent_id')==agent_id for p in conversation.get('participants',[]))):
            fail('communication_identity', 'Agent不是此确切会话的已观测参与者', 409)
        return {'agent_id':agent_id,'conversation_id':conversation_id,'controller_generation':generation,
                'namespace':self.namespace,'checked_at':now(), 'native_host_available':agent.get('production_auto_resume_available') is True,
                'source':'native_principal_scoped_observation_not_openai_account_authentication', 'host_auto_resume_verified':False}

    def post(self, item):
        route=item['route']
        try:
            self.check_target(route['agent_id'],route['conversation_id'],route['controller_generation'])
            if route['namespace'] != self.namespace:fail('communication_identity','封包属于另一凭据/后端，不改投',409)
        except TaskError as exc:
            exc.notification_post_not_attempted=True
            raise
        result=self.call('post_conversation_message',item['native_request'])
        return self.project_message(result.get('message'),item)

    @staticmethod
    def project_message(message,item):
        if (not isinstance(message,dict) or message.get('conversation_id') != item['route']['conversation_id'] or
                message.get('body') != item['native_request']['body'] or type(message.get('seq')) is not int or message['seq']<1):
            fail('communication_receipt', '消息回执不对应原封包，保留未知状态', 503)
        deliveries=message.get('deliveries')
        if not isinstance(deliveries,list) or len(deliveries)!=1 or deliveries[0].get('recipient_agent_id')!=item['route']['agent_id']:
            fail('communication_receipt', '原收件人回执不匹配，不按成功处理', 503)
        entry=deliveries[0]
        if entry.get('state') not in {'queued','consumed'}:
            fail('communication_receipt', '未知的原生收件状态', 503)
        return {'message_id':opaque(message.get('message_id'),'Message'),'seq':message['seq'],
                'delivery_id':opaque(entry.get('delivery_id'),'Delivery'),'delivery_state':entry['state'],
                'observed_at':now(),'source':'native_message_receipt_not_model_execution_or_task_acceptance'}

    def observe(self,item):
        route=item['route']; receipt=item['native_receipt']
        if route['namespace']!=self.namespace:
            fail('communication_identity','原消息属于另一后端/凭据，不改投',409)
        self.check_runtime()
        result=self.call('read_conversation',{'conversation_id':route['conversation_id'],'after_seq':receipt['seq']-1,'limit':2})
        message=next((m for m in result.get('messages',[]) if m.get('message_id')==receipt['message_id'] and m.get('seq')==receipt['seq']),None)
        projected=self.project_message(message,item)
        if projected['delivery_id']!=receipt['delivery_id']:
            fail('communication_receipt','不是同一原生Delivery',503)
        return projected
