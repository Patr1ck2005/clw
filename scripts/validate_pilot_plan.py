"""Check rollout metadata only. Does not contact backends, inspect pilot trees, or start work."""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / 'config' / 'pilots.json'
HASH = re.compile(r'[0-9a-f]{64}\Z')
PROJECT = re.compile(r'agent:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}\Z')


class PlanError(ValueError):
    """A metadata error, never a backend authorization or execution decision."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PlanError(message)


def mapping(value: Any, label: str) -> dict:
    require(isinstance(value, dict), label + ' must be an object')
    return value


def sequence(value: Any, label: str, maximum: int) -> list:
    require(isinstance(value, list) and 0 < len(value) <= maximum, label + ' has invalid length')
    return value


def text(value: Any, label: str, maximum: int = 2048) -> str:
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= maximum,
            label + ' must be nonempty bounded text')
    require(not any(ord(c) < 32 for c in value), label + ' contains control characters')
    return value


def relative(value: Any, label: str) -> str:
    v = text(value, label)
    p = PurePosixPath(v)
    require('\\' not in v and ':' not in v and not p.is_absolute()
            and all(x not in ('', '.', '..') for x in v.split('/')), label + ' must be a canonical relative path')
    return v


def no_credentials(value: Any, depth: int = 0) -> None:
    require(depth <= 20, 'metadata nesting is too deep')
    if isinstance(value, dict):
        require(all(isinstance(k, str) for k in value), 'object keys must be strings')
        forbidden = {'api_key', 'access_token', 'refresh_token', 'cookie', 'password', 'authorization'}
        require(not forbidden.intersection(k.casefold() for k in value), 'credential field is not allowed')
        for v in value.values():
            no_credentials(v, depth + 1)
    elif isinstance(value, list):
        for v in value:
            no_credentials(v, depth + 1)


def validate_plan(raw: Any) -> dict:
    data = mapping(raw, 'registry')
    no_credentials(data)
    require(data.get('schema_version') == 2 and type(data.get('schema_version')) is int, 'unsupported schema')
    require(data.get('purpose') == 'rollout_readiness_only_not_execution_authority', 'not a rollout registry')
    require(data.get('dispatch_enabled') is False, 'rollout metadata cannot enable execution')
    require(re.fullmatch(r'[0-9a-f]{40}', str(data.get('source_baseline', ''))) is not None, 'invalid baseline')
    relative(data.get('rollout_document'), 'rollout document')
    common = mapping(data.get('common'), 'common')
    for k in ('task_time_splitting', 'model_fallback_allowed', 'paid_api_calls_enabled',
              'host_acceptance_is_resume_proof', 'ordinary_idle_is_failure', 'snapshots_prove_live_readiness'):
        require(common.get(k) is False, k + ' must remain false in this preparation')
    require(common.get('human_stop_precedes_autoresume') is True, 'human stop must win')
    require(common.get('unknown_outcome_policy') == 'reconcile_original_identity_never_blind_replay', 'unsafe retry policy')
    gates = sequence(data.get('gates'), 'gates', 32)
    by_id = {}
    for item in gates:
        g = mapping(item, 'gate')
        gid = text(g.get('id'), 'gate id', 40)
        require(gid not in by_id, 'duplicate gate')
        require(g.get('status') in ('planned', 'in_progress', 'blocked_external', 'done'), 'invalid gate status')
        deps = g.get('depends_on')
        require(isinstance(deps, list) and all(isinstance(x, str) for x in deps)
                and len(deps) == len(set(deps)), 'invalid dependencies')
        for c in sequence(g.get('acceptance'), 'acceptance', 32):
            text(c, 'acceptance criterion')
        evidence = g.get('evidence')
        require(isinstance(evidence, list), 'gate evidence must be a list')
        for ref in evidence:
            relative(ref, 'evidence reference')
        require(g['status'] != 'done' or bool(evidence), 'done gate requires evidence references; references are not independently verified here')
        by_id[gid] = g
    visiting, visited = set(), set()

    def visit(gid: str) -> None:
        require(gid in by_id, 'unknown gate dependency')
        require(gid not in visiting, 'cyclic gate dependency')
        if gid in visited:
            return
        visiting.add(gid)
        for dep in by_id[gid]['depends_on']:
            visit(dep)
            require(by_id[gid]['status'] != 'done' or by_id[dep]['status'] == 'done', 'done gate has unmet dependencies')
        visiting.remove(gid)
        visited.add(gid)

    for gid in by_id:
        visit(gid)
    ids, roots, projects = set(), set(), set()
    summaries = []
    for item in sequence(data.get('pilots'), 'pilots', 16):
        p = mapping(item, 'pilot')
        pid = text(p.get('id'), 'pilot id', 64)
        root = text(p.get('root'), 'pilot root')
        wp = PureWindowsPath(root)
        require(wp.is_absolute() and len(wp.drive) == 2 and wp.drive[1] == ':'
                and '..' not in wp.parts and len(wp.parts) >= 3, 'pilot requires a specific absolute Windows directory')
        root_key = str(wp).casefold()
        project = text(p.get('project_id'), 'project id', 512)
        require(PROJECT.fullmatch(project) is not None, 'invalid native project id')
        require(pid not in ids and root_key not in roots and project not in projects, 'duplicate pilot identity')
        ids.add(pid); roots.add(root_key); projects.add(project)
        require(p.get('desired_mode') in ('goal_autopilot', 'supervised_parallel'), 'invalid target mode')
        require(p.get('initial_mode') == 'observe_only' and p.get('activation_state') == 'not_activated', 'preparation must not claim activation')
        handover = mapping(p.get('handover'), 'handover')
        require(handover.get('required') is True and type(handover.get('completed')) is bool, 'explicit handover required')
        relative(handover.get('entry'), 'handover entry')
        resources = p.get('resources')
        require(isinstance(resources, list) and len(resources) <= 32, 'resources must be bounded declarations')
        resource_ids = set()
        for resource in resources:
            resource = mapping(resource, 'resource')
            allowed = {'id', 'capacity', 'available_capacity', 'owner', 'availability', 'scope', 'requires_frozen_inputs', 'unknown_occupancy'}
            require(set(resource) == allowed, 'unknown or missing resource fields')
            rid = text(resource.get('id'), 'resource id', 80)
            require(rid not in resource_ids, 'duplicate resource')
            resource_ids.add(rid)
            capacity, available = resource.get('capacity'), resource.get('available_capacity')
            require(type(capacity) is int and 0 <= capacity <= 1024, 'invalid resource capacity')
            require(type(available) is int and 0 <= available <= capacity, 'available capacity exceeds declared ceiling')
            require(resource.get('availability') in ('available', 'blocked', 'unknown'), 'invalid availability')
            require(resource['availability'] == 'available' or available == 0, 'unavailable resource cannot advertise capacity')
            text(resource.get('owner'), 'resource owner', 100)
            text(resource.get('scope'), 'resource scope', 500)
            require(type(resource.get('requires_frozen_inputs')) is bool, 'input freeze declaration required')
            require(resource.get('unknown_occupancy') == 'retain_and_reconcile_original_execution', 'unknown execution must not release resource')
        required = sequence(p.get('required_gates'), 'required gates', 32)
        require(all(isinstance(g, str) and g in by_id for g in required) and len(set(required)) == len(required), 'unknown/duplicate pilot gate')
        for source in sequence(p.get('sources'), 'sources', 16):
            source = mapping(source, 'source')
            relative(source.get('path'), 'source path')
            require(isinstance(source.get('sha256'), str) and HASH.fullmatch(source['sha256']) is not None, 'invalid observed source hash')
        require(bool(p.get('external_actions_require_separate_authorization')), 'external-action boundary missing')
        summaries.append({'id': pid, 'desired_mode': p['desired_mode'], 'activation_state': 'not_activated',
                          'handover_pending': not handover['completed'],
                          'planned_unmet_gates': [g for g in required if by_id[g]['status'] != 'done']})
    return {'schema_version': 2, 'plan_consistent': True, 'validation_scope': 'metadata_only',
            'runtime_queried': False, 'pilot_files_read': False, 'dispatch_performed': False,
            'live_autonomy_verified': False, 'pilot_count': len(summaries), 'gate_count': len(gates),
            'pilots': summaries}


def main() -> int:
    try:
        payload = REGISTRY.read_bytes()
        require(len(payload) <= 1024 * 1024, 'registry exceeds 1 MiB')
        report = validate_plan(json.loads(payload))
    except (OSError, ValueError, TypeError, RecursionError):
        # Do not echo arbitrary imported payloads or local exception paths.
        print(json.dumps({'plan_consistent': False, 'validation_scope': 'metadata_only', 'dispatch_performed': False}))
        return 1
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
