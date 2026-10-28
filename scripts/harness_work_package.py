"""Shared user-selected workload guidance for real development prompts."""
import json
from pathlib import Path


POLICY_PATH = Path(__file__).resolve().parents[1] / 'config' / 'work-package-policy.json'
ROOT = POLICY_PATH.parent.parent
_policy = json.loads(POLICY_PATH.read_text(encoding='utf-8-sig'))
if _policy.get('version') != 1 or not isinstance(_policy.get('text'), str) or not _policy['text'].strip():
    raise ValueError('work_package_policy_invalid')
WORK_PACKAGE_GUIDANCE = _policy['text'].strip()

GLOBAL_POINTERS = ('D:/Dev/README.md', 'D:/Dev/AGENTS.md', 'D:/Dev/WorkFlow/README.md')


def context_pointers(project=None, *, first=False, pointers=()):
    """Navigation once, changed relevant pointers thereafter; never a reread gate."""
    preview = (ROOT / '.local/preview-installation.json').is_file()
    values = list(GLOBAL_POINTERS if first and not preview else ())
    if project and first:
        rules=Path(project) / 'AGENTS.md'
        if not preview or rules.is_file():values.append(rules.as_posix())
    values.extend(str(value) for value in pointers if value)
    values = list(dict.fromkeys(values))
    return ('指导入口（按需读取已知内容）：\n' + '\n'.join(values)) if values else ''


def work_message(value, *, project=None, first=False, pointers=()):
    """Compose one actual work send, retaining the user's original text."""
    return '\n\n'.join(part for part in (
        context_pointers(project, first=first, pointers=pointers), value,
        WORK_PACKAGE_GUIDANCE) if part)


def goal_result_guidance(db, thread_id, request_id):
    """Completion belongs to the normal result, never a separate review turn."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_goals'").fetchone():
        return ''
    goal=db.execute('SELECT state FROM managed_goals WHERE thread_id=? AND request_id=?',
                    (thread_id,request_id)).fetchone()
    if not goal or goal['state'] not in ('active','waiting'):
        return ''
    return ('本轮结果正文附一行 CLW_GOAL_STATUS: delivered、waiting 或 in_progress，按实际完整目标状态填写。'
            '目标完成用 delivered。waiting 仅限原 Job 已提交且独立工作已完成，另附一行 '
            'CLW_GOAL_WAIT: {"job_ids":["原Job ID"],"result":"所等结果","resume":"接续点","independent_work_complete":true}，'
            '需要时附原 session_id；不编造身份。')
