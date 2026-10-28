"""Draft a reviewable CLW patch against an isolated pinned vendor generation.

This writes only the chosen overlay directory. Review its diff before using it
with prepare_codex_web_vendor.py; it never updates the active vendor tree.
"""

from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile

from prepare_codex_web_vendor import COMMIT


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_files(root,folders=('src','tests')):
    return {path.relative_to(root).as_posix(): path for folder in folders
            for path in (root / folder).rglob('*') if path.is_file()}


def normalize_patch(raw):
    lines = []
    for line in raw.splitlines(keepends=True):
        if line.startswith((b'diff --git ', b'--- ', b'+++ ')):
            line = line.replace(b'a/base/', b'a/').replace(b'a/target/', b'a/')
            line = line.replace(b'b/target/', b'b/').replace(b'b/base/', b'b/')
        lines.append(line)
    return b''.join(lines)


def build(baseline, current, output,*,folders=('src','tests')):
    baseline = baseline.resolve()
    current = current.resolve()
    output = output.resolve()
    if not folders or any(folder not in ('src','tests','launcher') for folder in folders):
        raise ValueError('vendor_overlay_folder_invalid')
    before = source_files(baseline,folders)
    after = source_files(current,folders)
    removed = set(before) - set(after)
    if removed:
        raise ValueError('vendor_overlay_source_removed: ' + ', '.join(sorted(removed)))
    changed = [name for name in sorted(after)
               if name not in before or before[name].read_bytes() != after[name].read_bytes()]
    if not changed:
        raise ValueError('vendor_overlay_no_changes')
    if output.exists() and any(output.iterdir()):
        raise ValueError('vendor_overlay_output_not_empty')
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'version': 1, 'baseline_commit': COMMIT, 'patch': 'clw.patch', 'files': []}
    with tempfile.TemporaryDirectory(prefix='clw-overlay-diff-') as directory:
        stage = Path(directory)
        for name in changed:
            target = stage / 'target' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(after[name], target)
            if name in before:
                base = stage / 'base' / name
                base.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(before[name], base)
            manifest['files'].append({'path': name,
                'base_sha256': digest(before[name].read_bytes()) if name in before else None,
                'sha256': digest(after[name].read_bytes()),
                'reason': 'CLW adaptation preserved from the active checkout and verified by hash'})
        result = subprocess.run(['git', '-C', str(stage), '-c', 'core.autocrlf=false',
                                 'diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/',
                                 'base', 'target'], capture_output=True)
        if result.returncode != 1 or not result.stdout:
            raise RuntimeError('vendor_overlay_diff_failed: ' + result.stderr.decode('utf8', 'replace'))
        patch = normalize_patch(result.stdout)
    (output / 'clw.patch').write_bytes(patch)
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'changed': len(changed), 'output': str(output), 'paths': changed}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--current', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--include-launcher',action='store_true')
    args = parser.parse_args()
    build(args.baseline, args.current, args.output,folders=('src','tests','launcher') if args.include_launcher else ('src','tests'))
