import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_codex_web_overlay as builder
import prepare_codex_web_vendor as vendor


class ReviewedOverlayTests(unittest.TestCase):
    def test_pinned_base_patch_recreates_exact_reviewed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / 'base'
            target = root / 'target'
            (base / 'src').mkdir(parents=True)
            (target / 'src').mkdir(parents=True)
            (base / 'src' / 'x.ts').write_bytes(b'one\n')
            (target / 'src' / 'x.ts').write_bytes(b'two\n')
            (target / 'src' / 'new.ts').write_bytes(b'new\n')
            overlay = root / 'overlay'
            builder.build(base, target, overlay)
            raw = (base / 'src' / 'x.ts').read_bytes()
            prepared = [('src/x.ts', raw)]
            entries = [{'path': 'src/x.ts', 'source_commit': vendor.COMMIT,
                        'source_sha256': hashlib.sha256(raw).hexdigest(),
                        'sha256': hashlib.sha256(raw).hexdigest(), 'adaptations': []}]
            with patch.object(vendor, 'OVERLAY_ROOT', overlay):
                files, manifest = vendor.apply_reviewed_overlay(prepared, entries)
                with self.assertRaisesRegex(ValueError, 'vendor_overlay_base_changed'):
                    vendor.apply_reviewed_overlay([('src/x.ts', b'changed\n')], entries)
            self.assertEqual(dict(files), {'src/x.ts': b'two\n', 'src/new.ts': b'new\n'})
            by_name = {item['path']: item for item in manifest}
            self.assertEqual(by_name['src/x.ts']['sha256'], hashlib.sha256(b'two\n').hexdigest())
            self.assertIsNone(by_name['src/new.ts']['source_commit'])

    def test_rejects_manifest_path_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            overlay = Path(directory)
            (overlay / 'manifest.json').write_text(json.dumps({'version': 1,
                'baseline_commit': vendor.COMMIT, 'patch': 'clw.patch', 'files': [
                    {'path': 'src/../outside.ts', 'base_sha256': None, 'sha256': '0' * 64}]}), encoding='utf8')
            with patch.object(vendor, 'OVERLAY_ROOT', overlay):
                with self.assertRaisesRegex(ValueError, 'vendor_overlay_path_invalid'):
                    vendor.apply_reviewed_overlay([], [])


if __name__ == '__main__':
    unittest.main()
