"""Project write declarations, distinct from exportable artifact references.

Canonicalization does not grant access: caller/root inheritance and executor
authorization remain at their existing boundaries. Directory separators are
syntax; internal project directories are not forbidden export references here.
"""
import re
from harness_state import require


def relative_write_path(raw):
    require(isinstance(raw,str) and 0<len(raw)<=513,'team_write_path_invalid')
    # Windows-style relative names and one conventional directory suffix are
    # unambiguous. Reject duplicate separators/traversal before normalization.
    value=raw.replace('\\','/')
    if value.endswith('/'):value=value[:-1]
    require(value and len(value)<=512 and not value.startswith('/') and ':' not in value,'team_write_path_invalid')
    parts=value.split('/')
    for part in parts:
        require(part not in ('','.','..') and not part.endswith((' ','.')) and
                not re.search(r'[<>"|?*\x00-\x1f]',part) and
                not re.fullmatch(r'(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?',part),
                'team_write_path_invalid')
    return '/'.join(parts)


def write_paths(access,paths):
    require(access in ('read','write'),'team_workspace_access')
    require(isinstance(paths,list) and len(paths)<=64,'team_write_paths_bounds')
    result=['.'] if access=='write' and paths==['.'] else [relative_write_path(p) for p in paths]
    require(len({p.casefold() for p in result})==len(result),'team_duplicate_write_path')
    require(access=='read' and not result or access=='write' and bool(result),'team_write_paths_required')
    return result


def normalize_scope_payload(payload):
    """Normalize only explicit scope fields, without inventing missing settings.

    The fresh CLI sends canonical directory names even to a running older host.
    Omitted fields stay omitted, so the host's default inheritance still works.
    """
    if 'write_paths' not in payload:return payload
    return {**payload,'write_paths':write_paths(payload.get('access','read'),payload['write_paths'])}
