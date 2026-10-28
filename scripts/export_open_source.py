"""Manually export a reviewed Git snapshot; never reads ignored files or publishes.

Usage: python -B scripts/export_open_source.py --ref <commit> --out <absolute-empty-directory>
The source repository and its index/worktree are read-only. Review the resulting
SOURCE_EXPORT.json and tree before copying them to a public repository.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TREES = {'apps', 'scripts', 'tests', 'ops', 'packaging', 'vendor', 'config', 'prompts'}
ROOT_FILES = {'.gitattributes', '.gitignore', 'README.md', 'LICENSE', 'NOTICE.md',
              'SOURCE.md', 'CONTRIBUTING.md', 'package.json', 'pyproject.toml'}
DOCS = {
    'docs/SOURCE.md', 'docs/ARCHITECTURE.md', 'docs/ARCHITECTURE_REVIEW.md', 'docs/OPEN_SOURCE_RELEASE.md',
    'docs/architecture/README.md', 'docs/architecture/pressure-observation-20261024.json',
    'docs/WEB_WORKSPACE_START.md', 'docs/WEB_WORKSPACE_CANDIDATE.md',
    'docs/FREE_PREVIEW_TERMS.md', 'docs/PRIVACY.md', 'docs/PREVIEW_LIMITATIONS.md',
    'docs/PREVIEW_FEEDBACK.md', 'docs/FIRST_RUN.md',
    'docs/harness/API.md', 'docs/harness/APP_CONTROL.md',
    'docs/harness/MANUAL.md', 'docs/harness/LESSONS.md',
    'docs/harness/MVP-INTERFACES.md', 'docs/harness/PROJECT_INTAKE.md',
    'docs/harness/CONTROL_RECEIVER.md', 'docs/harness/RECOVERY_RECEIVER.md',
    'docs/harness/WEB_CONNECTION.md', 'docs/harness/WEB_RECOVERY.md',
    'docs/harness/control-test-matrix.json', 'docs/harness/control-test-record.example.json',
}
RECEIVERS = {'docs/harness/' + name: 'docs/product-receivers/' + name
             for name in ('MANAGED_WEB.md', 'HOST_RECEIVER.md', 'WEB_RECEIVER.md')}
OBSERVED = 'apps/control-center/data/observed.json'
OBSERVATION_BUILDER = 'scripts/build_observation_sample.py'
LEGACY_SOURCE = 'scripts/harness_managed_send_preparation.py'
OBSERVATION_REFERENCES = {'apps/control-center/model.mjs', 'tests/control-center.test.mjs',
                          'tests/test_control_center.py'}
CONTRIBUTOR_RULES = b'''# Contributing\n\nKeep changes scoped and preserve other contributors' work. Read README.md and\ndocs/SOURCE.md before changing build or export behavior. Run the tests relevant\nto your change. Never commit credentials, browser profiles, personal permissions,\nconversation contents, or live runtime receipts. Keep third-party licenses and\nvendor provenance intact. Report source tests and real runtime acceptance separately.\n'''
PUBLIC_CURRENT = b'''# Public source navigation\n\nThis generated page contains no personal instance state or runtime acceptance claims.\nSee [source and build notes](docs/SOURCE.md) and the\n[architecture review](docs/ARCHITECTURE_REVIEW.md).\n'''


class ExportError(ValueError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + '\n').encode('utf-8')


def git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ExportError('Git read failed: ' + result.stderr.decode('utf-8', 'replace').strip())
    return result.stdout


def exclusion(path: str) -> str | None:
    """An explicit documentation allowlist, not a privacy keyword scanner."""
    parts = PurePosixPath(path).parts
    if not parts or path.startswith('/') or '\\' in path or ':' in path or any(p in ('.', '..') for p in parts):
        raise ExportError('Unsafe tracked path')
    if parts[0] in {'evidence', 'checkpoints', 'legacy-reference'}:
        return parts[0]
    if path in {'CURRENT.md', 'PLAN.json'}:
        return 'private_current_state'
    if path == 'docs/harness/MATH_CONTEXT_HANDOFF.md':
        return 'private_context_handoff'
    for prefix, category in [('docs/handoffs/', 'private_handoffs'), ('docs/parallel/', 'private_parallel'),
                             ('docs/harness/history/', 'private_harness_history'),
                             ('docs/requirements/', 'original_requirements')]:
        if path.startswith(prefix):
            return category
    if path == 'AGENTS.md' or path in RECEIVERS:
        return None
    if parts[0] == 'docs':
        return None if (path in DOCS or path in RECEIVERS.values() or
                        path.startswith('docs/licenses/')) else 'documentation_not_allowlisted'
    if parts[0] in TREES:
        return None
    if len(parts) == 1 and (path in ROOT_FILES or path.lower().endswith('.cmd') or
                            path.endswith(('.lock', '.lockb', '-lock.json')) or path == 'pnpm-lock.yaml'):
        return None
    return 'outside_public_source_scope'


def protected(path: str) -> bool:
    """Vendor manifests, patch files and source archives must remain byte-exact."""
    return any(p in {'upstream', 'vendor', 'overlay', 'overlays'} or p.startswith('vendor-')
               for p in PurePosixPath(path).parts)


@contextmanager
def blobs(repo: Path):
    process = subprocess.Popen(['git', '-C', str(repo), 'cat-file', '--batch'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    def read(oid):
        process.stdin.write(oid.encode('ascii') + b'\n')
        process.stdin.flush()
        header = process.stdout.readline().split()
        if len(header) != 3 or header[1] != b'blob':
            raise ExportError('Expected a Git blob')
        size = int(header[2])
        data = process.stdout.read(size)
        if len(data) != size or process.stdout.read(1) != b'\n':
            raise ExportError('Incomplete Git blob')
        return data
    try:
        yield read
    finally:
        process.stdin.close()
        process.stdout.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stderr.close()


def literal_assignments(source: str) -> dict:
    result = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in {'LEGACY', 'LEGACY_FILES', 'LEGACY_INCIDENT'}:
                result[node.targets[0].id] = ast.literal_eval(node.value)
    return result


def replace_assignments(source: str, replacements: dict) -> str:
    lines = source.splitlines(keepends=True)
    for node in reversed(ast.parse(source).body):
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in replacements:
                lines[node.lineno - 1:node.end_lineno] = [name + ' = ' + repr(replacements[name]) + '\n']
    return ''.join(lines)


def apply_known_strings(source: str, mapping: dict[str, str]) -> str:
    # Only identities obtained from the three named fixtures enter this mapping.
    # Never match arbitrary UUIDs, machine paths, hashes, or vendor contents.
    variants = {}
    for old, new in mapping.items():
        if old != new and len(old) >= 8:
            variants[old] = new
            variants[json.dumps(old)[1:-1]] = json.dumps(new)[1:-1]
    if not variants:
        return source
    pattern = re.compile('|'.join(re.escape(x) for x in sorted(variants, key=len, reverse=True)))
    return pattern.sub(lambda match: variants[match.group()], source)


def observation_fixture(raw: dict) -> tuple[dict, dict]:
    sample = deepcopy(raw)
    mapping = {raw['runtime']['runner_id']: 'example-runner', raw['runtime']['id']: 'example-runtime'}
    projects = raw['projects']
    for index, project in enumerate(projects, 1):
        alias = f'example-project-{index:02}'
        # Preserve the fixture's two navigation groups and the tests exercising them.
        if len(projects) == 13:
            alias = {4: 'example-game-beta', 5: 'example-game-alpha',
                     6: 'example-game-alpha-parallel', 13: 'example-assets'}.get(index, alias)
        path = f'C:/CLW-Examples/{alias}'
        if len(projects) == 13 and index in {1, 2, 3, 8, 10}:
            path = f'C:/CLW-Examples/example-game-alpha/{alias}'
        mapping.update({project['id']: f'agent:example-runner:{alias}',
                        project['id'].rsplit(':', 1)[-1]: alias,
                        project['name']: alias, project['path']: path})
    for index, session in enumerate(raw['sessions'], 1):
        mapping[session['id']] = f'wc_sess_example_{index:02}'
        mapping[session['title']] = f'Synthetic example session {index}'
        for event_index, event in enumerate(session['events'], 1):
            for key, prefix in [('id', 'evt_'), ('logical_id', 'wc_inv_')]:
                value = event.get(key)
                if value and value not in mapping:
                    mapping[value] = prefix + digest(f'example-{index}-{key}-{event_index}'.encode())[:32]
    def project(value):
        if isinstance(value, dict):
            return {k: project(v) for k, v in value.items()}
        if isinstance(value, list):
            return [project(v) for v in value]
        return mapping.get(value, value) if isinstance(value, str) else value
    sample = project(sample)
    sample['source'] = {'kind': 'demo', 'observed_at': '2026-01-01T00:00:00Z',
                        'scope': 'Synthetic offline fixture: invented projects, sessions and event identities; not a live observation.',
                        'live': False}
    for index, session in enumerate(sample['sessions']):
        for event_index, event in enumerate(session['events']):
            event['timestamp'] = 1767225600 + index * 100 + event_index
    return sample, mapping


def observation_builder(sample: dict) -> bytes:
    return ('''"""Reproduce the synthetic offline control-center fixture. No live data is read."""\n'''
            'import json\nfrom pathlib import Path\n\nROOT = Path(__file__).resolve().parents[1]\n'
            'SAMPLE = ' + repr(sample) + '\n\n'
            "if __name__ == '__main__':\n"
            "    target = ROOT / 'apps/control-center/data/observed.json'\n"
            "    data = json.dumps(SAMPLE, ensure_ascii=False, indent=2) + '\\n'\n"
            "    if target.exists() and target.read_text(encoding='utf-8') != data:\n"
            "        raise SystemExit('Existing fixture differs; review rather than overwrite')\n"
            "    target.parent.mkdir(parents=True, exist_ok=True)\n"
            "    target.write_text(data, encoding='utf-8', newline='\\n')\n"
            "    print('Synthetic offline fixture reproduced; not a live observation.')\n").encode('utf-8')


def synthetic_pilots(raw: dict) -> dict:
    result = deepcopy(raw)
    result['source_baseline'] = '0' * 40
    result['rollout_document'] = 'docs/SOURCE.md'
    result['source'] = 'Synthetic metadata for schema tests only; no real project, authorization or observed source.'
    for index, pilot in enumerate(result['pilots'], 1):
        pilot.update(id=f'example-pilot-{index}', root=f'C:/CLW-Examples/pilot-{index}',
                     project_id=f'agent:example-runner:pilot-{index}')
        pilot['handover'] = {'required': True, 'completed': False, 'incumbent_role': 'M',
                             'entry': 'docs/SOURCE.md', 'note': 'Synthetic example; explicit handover required.'}
        pilot['sources'] = [{'path': 'docs/SOURCE.md', 'sha256': digest(f'synthetic-source-{index}'.encode())}]
        for resource in pilot['resources']:
            resource['scope'] = 'Synthetic resource declaration for metadata validation only'
    return result


def synthetic_legacy(assignments: dict) -> tuple[dict, dict]:
    legacy = assignments['LEGACY']
    replacement = {}
    values = {}
    for key, value in legacy.items():
        hashed = digest(('synthetic-send-preparation-' + key).encode())
        if key == 'account': new = value
        elif key == 'error_at': new = 1767225600000
        elif key == 'root': new = r'c:\clw-examples\send-preparation'
        elif key == 'url': new = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000003'
        elif key == 'page_id': new = 'web-00000000-0000-4000-8000-000000000001'
        elif key == 'request_id': new = '00000000-0000-4000-8000-000000000002'
        elif key == 'session_id': new = 'wc_sess_example_legacy'
        else:
            prefix = next((p for p in ('hthr_', 'control_', 'clw-run-') if isinstance(value, str) and value.startswith(p)), '')
            new = prefix + hashed[:32] if prefix or not key.endswith('sha256') else hashed
        values[key] = new
        if isinstance(value, str) and len(value) >= 8:
            replacement[value] = new
    files = {name: digest(('synthetic-evidence-' + name).encode()) for name in assignments['LEGACY_FILES']}
    replacement.update({old: files[name] for name, old in assignments['LEGACY_FILES'].items()})
    replacement[assignments['LEGACY_INCIDENT']] = 'example-send-preparation'
    return {'LEGACY': values, 'LEGACY_FILES': files, 'LEGACY_INCIDENT': 'example-send-preparation'}, replacement


def export_source(repo: Path, ref: str, out: Path) -> dict:
    repo = Path(repo).resolve()
    actual_root = Path(os.fsdecode(git(repo, 'rev-parse', '--show-toplevel')).strip()).resolve()
    if actual_root != repo:
        raise ExportError('--repo must name the repository root')
    if not Path(out).is_absolute():
        raise ExportError('--out must be an explicit absolute directory')
    destination = Path(out).resolve()
    if destination == repo or destination.is_relative_to(repo) or repo.is_relative_to(destination):
        raise ExportError('Output must be outside the source repository')
    if Path(out).is_symlink() or (destination.exists() and
                                (not destination.is_dir() or any(destination.iterdir()))):
        raise ExportError('Output directory must be empty and must not be a symlink')
    commit = git(repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode('ascii').strip()
    entries = {}
    excluded = Counter()
    for record in git(repo, 'ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not record:
            continue
        meta, raw_name = record.split(b'\t', 1)
        mode, kind, oid = meta.decode('ascii').split()
        name = raw_name.decode('utf-8')
        reason = exclusion(name)
        if reason:
            excluded[reason] += 1
            continue
        if mode not in {'100644', '100755'} or kind != 'blob':
            raise ExportError('Public source contains a symlink or unsupported Git entry')
        entries[name] = (mode, oid)
    folded = [name.casefold() for name in entries]
    if len(folded) != len(set(folded)):
        raise ExportError('Public paths collide on a case-insensitive filesystem')
    for target, source in RECEIVERS.items():
        if target in entries and source not in entries:
            raise ExportError('Missing reviewed public receiver projection: ' + source)
    manifest = {'schema_version': 1, 'source_commit': commit,
                'policy': 'tracked_git_snapshot_explicit_docs_allowlist_v1',
                'excluded_categories': dict(sorted(excluded.items())), 'transformed_files': [],
                'files': {}, 'manifest_hash_scope': 'All exported files except SOURCE_EXPORT.json itself'}
    with blobs(repo) as read:
        def source(name):
            return read(entries[name][1])
        sample, observation_map = observation_fixture(json.loads(source(OBSERVED))) if OBSERVED in entries else (None, {})
        legacy_values, legacy_map = synthetic_legacy(literal_assignments(source(LEGACY_SOURCE).decode('utf-8-sig'))) if LEGACY_SOURCE in entries else ({}, {})
        # Resolve the reviewed projections and fixture inputs before creating files.
        destination.mkdir(parents=True, exist_ok=True)
        for name, (mode, oid) in sorted(entries.items()):
            source_name = RECEIVERS.get(name, name)
            original = source(source_name)
            data = original
            transformations = []
            if source_name != name:
                transformations.append('reviewed_public_receiver_projection')
            if name == 'AGENTS.md':
                data = CONTRIBUTOR_RULES
                transformations.append('public_contributor_rules')
            elif name == 'config/harness-web-targets.json':
                data = json_bytes({'schema_version': 1, 'targets': []})
                transformations.append('remove_personal_targets')
            elif name == 'config/web-user-authorization.json':
                data = json_bytes({'version': 1, 'enabled': False, 'auto_approve_tools': False,
                                   'auto_approve_returned_files': False, 'recover_ended_turns': False,
                                   'text': '', 'source': 'Public default: configure consent for your own tasks.'})
                transformations.append('disable_personal_preauthorization')
            elif name == 'config/pilots.json':
                data = json_bytes(synthetic_pilots(json.loads(original)))
                transformations.append('synthetic_pilot_metadata')
            elif name == OBSERVED:
                data = json_bytes(sample)
                transformations.append('synthetic_observation_fixture')
            elif name == OBSERVATION_BUILDER and sample is not None:
                data = observation_builder(sample)
                transformations.append('synthetic_observation_builder')
            elif not protected(name) and (name.startswith(('scripts/', 'tests/', 'apps/')) and
                                         PurePosixPath(name).suffix in {'.py', '.js', '.cjs', '.mjs', '.ts', '.json', '.md'}):
                text = original.decode('utf-8-sig')
                if name == LEGACY_SOURCE:
                    text = replace_assignments(text, legacy_values)
                    transformations.append('synthetic_legacy_recovery_fixture')
                text = apply_known_strings(text, legacy_map)
                if name in OBSERVATION_REFERENCES:
                    text = apply_known_strings(text, observation_map)
                if text != original.decode('utf-8-sig'):
                    data = text.encode('utf-8')
                    if not transformations:
                        transformations.append('known_fixture_reference_consistency')
            if protected(name) and data != original:
                raise ExportError('Protected vendor bytes changed')
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as handle:
                handle.write(data)
            if mode == '100755':
                target.chmod(target.stat().st_mode | 0o111)
            manifest['files'][name] = {'sha256': digest(data), 'bytes': len(data),
                                       'source_path': source_name, 'source_sha256': digest(original),
                                       'git_mode': mode, 'transformations': transformations}
            if transformations:
                manifest['transformed_files'].append(name)
    # Source CURRENT.md is excluded above and its blob is never requested.
    with (destination / 'CURRENT.md').open('xb') as handle:
        handle.write(PUBLIC_CURRENT)
    manifest['files']['CURRENT.md'] = {'sha256': digest(PUBLIC_CURRENT), 'bytes': len(PUBLIC_CURRENT),
                                      'source_path': None, 'source_sha256': None, 'git_mode': '100644',
                                      'transformations': ['generated_public_navigation_no_instance_state']}
    manifest['transformed_files'].append('CURRENT.md')
    (destination / 'SOURCE_EXPORT.json').write_bytes(json_bytes(manifest))
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--ref', required=True, help='Reviewed source commit or Git ref')
    parser.add_argument('--out', required=True, type=Path, help='Absolute empty directory outside the source repository')
    args = parser.parse_args()
    try:
        manifest = export_source(args.repo, args.ref, args.out)
    except (ExportError, OSError, ValueError, SyntaxError, KeyError) as error:
        parser.exit(1, f'Export refused: {error}\n')
    print(json.dumps({'source_commit': manifest['source_commit'], 'files': len(manifest['files']),
                      'transformed_files': len(manifest['transformed_files']),
                      'published': False}, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
