"""User-approved task consent; never changes executor permissions or retries."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / 'config/web-user-authorization.json'  # legacy development path
DEFAULT_POLICY = {
    'version': 1, 'enabled': True,
    'text': '按用户当前任务直接使用工具，工具与文件确认自动允许。',
    'auto_approve_tools': True, 'auto_approve_returned_files': True,
    'recover_ended_turns': False,
}

def authorization_path(root=None):
    root=Path(root) if root is not None else ROOT
    current=root/'.local/web-user-authorization.json';legacy=root/'config/web-user-authorization.json'
    for path in (current,legacy):
        try:path.lstat();return path
        except FileNotFoundError:pass
    return current

def read_policy(root=None):
    path=authorization_path(root)
    try:raw=path.read_text(encoding='utf-8-sig')
    except FileNotFoundError:
        # CLW confirms ordinary tools/files by default. Only a truly absent
        # owner file uses that default; damaged policy is never ignored.
        try:path.lstat()
        except FileNotFoundError:return dict(DEFAULT_POLICY)
        raise
    policy=json.loads(raw)
    if not isinstance(policy,dict) or type(policy.get('version')) is not int or policy['version']!=1 or type(policy.get('enabled')) is not bool:
        raise ValueError('web_user_authorization_invalid')
    for field in ('recover_ended_turns','auto_approve_returned_files','auto_approve_tools'):
        if field in policy and type(policy[field]) is not bool:raise ValueError('web_user_authorization_invalid')
    if policy['enabled'] and (not isinstance(policy.get('text'),str) or not policy['text'].strip() or len(policy['text'])>4096):
        raise ValueError('web_user_authorization_invalid')
    return {**DEFAULT_POLICY, **policy}


def user_authorization(root=None):
    policy = read_policy(root)
    if not policy or not policy['enabled']:
        return ''
    value = policy.get('text')
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError('web_user_authorization_invalid')
    return value.strip() + '\n'


def ended_turn_recovery_authorized(root=None):
    """Explicit owner preference for verified recovery, never a tool grant."""
    policy=read_policy(root)
    return bool(policy and policy['enabled'] is True and policy.get('recover_ended_turns') is True)


def confirmation_authorized(kind, root=None):
    """Ordinary confirmations default on; explicit owner choices take priority."""
    policy=read_policy(root)
    field={'tool':'auto_approve_tools','returned_file':'auto_approve_returned_files'}.get(kind)
    return bool(field and policy and policy['enabled'] is True and policy.get(field) is True)


if __name__ == '__main__':
    print(user_authorization(), end='')
