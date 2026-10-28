"""Isolated loopback contract/durability tests. Never contacts production ports."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, ProxyHandler, build_opener
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import web_companion_control as control

ORIGIN = 'chrome-extension://' + 'a' * 32
OTHER_ORIGIN = 'chrome-extension://' + 'b' * 32
CHAT = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111'
OTHER_CHAT = 'https://chatgpt.com/g/g-example/c/22222222-2222-4222-8222-222222222222'


def uid():
    return str(uuid.uuid4())


def page(url=CHAT, tab=7, doc='document-fixture', enabled=True):
    return {'tabId': tab, 'url': url, 'documentId': doc, 'enabled': enabled}


class ControlHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='clw-companion-test-')
        self.root = Path(self.temp.name) / 'runtime'
        self.profiles = {}
        self.start()

    def start(self):
        self.server = control.create_server(0, self.root, poll_seconds=0.03)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.base = f'http://127.0.0.1:{self.port}'
        self.secret = json.loads((self.root / 'operator-secret.json').read_text())['token']

    def stop(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def request(self, route, body=None, origin=None, operator=False, token=None, method=None, headers=None):
        hdr = {}
        if body is not None:
            hdr['Content-Type'] = 'application/json'
        if origin is not None:
            hdr['Origin'] = origin
        if operator:
            hdr['X-CLW-Operator'] = self.secret
        if token is not None:
            hdr['X-CLW-Peer'] = token
        hdr.update(headers or {})
        request = Request(self.base + route, data=None if body is None else control.encoded(body), headers=hdr, method=method)
        opener = build_opener(ProxyHandler({}))
        try:
            response = opener.open(request, timeout=4)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read(400001)
            self.assertLess(len(raw), 400001)
            return response.code, json.loads(raw) if raw else None, response.headers

    def ok(self, *args, **kwargs):
        code, value, _ = self.request(*args, **kwargs)
        self.assertEqual(code, 200, value)
        return value

    def register(self, origin=ORIGIN, nonce=None, pages=None, profile=None):
        profile = profile or self.profiles.setdefault(origin, uid())
        body = {'extension_version': '0.7.0', 'profile_id': profile, 'instance_nonce': nonce or uid(), 'pages': [page()] if pages is None else pages}
        return self.ok('/extension/register', body, origin=origin), body

    def pair(self, origin=ORIGIN, pages=None, allow=None, profile=None):
        first, body = self.register(origin, pages=pages, profile=profile)
        self.ok('/operator/approve', {'peer_id': first['peer_id'], 'pairing_nonce': first['pairing_nonce'],
                                    'allow_chat': allow or CHAT}, operator=True)
        approved = self.ok('/extension/register', body, origin=origin)
        self.assertTrue(approved['approved'])
        return approved, body

    def command(self, kind='inspect', url=CHAT, cid=None, payload=None, **extra):
        body = {'id': cid or uid(), 'type': kind, 'chatUrl': url, 'payload': payload or {}, **extra}
        return self.ok('/operator/command', body, operator=True), body

    def poll(self, approved, pages=None, origin=ORIGIN):
        return self.ok('/extension/poll', {'peer_id': approved['peer_id'], 'pages': [page()] if pages is None else pages},
                       origin=origin, token=approved['peer_token'])

    def result(self, approved, cid, state='completed', result=None, origin=ORIGIN):
        return self.request('/extension/result', {'peer_id': approved['peer_id'], 'command_id': cid,
                            'state': state, 'result': result or {'observed': True}}, origin=origin, token=approved['peer_token'])

    def receipt(self, cid):
        return self.ok('/operator/receipt?id=' + cid, operator=True)['receipt']

    def test_registration_approval_origin_trust_and_durable_instance_token(self):
        first, body = self.register()
        self.assertFalse(first['approved'])
        self.assertNotIn('peer_token', first)
        pending = self.ok('/operator/pending', operator=True)['peers']
        self.assertEqual(pending[0]['pairing_nonce'], first['pairing_nonce'])
        self.assertEqual(pending[0]['pages'], [page()])
        self.assertEqual(pending[0]['origin'], ORIGIN)
        wrong = {'peer_id': first['peer_id'], 'pairing_nonce': uid(), 'allow_chat': CHAT}
        self.assertEqual(self.request('/operator/approve', wrong, operator=True)[0], 409)
        self.ok('/operator/approve', {**wrong, 'pairing_nonce': first['pairing_nonce']}, operator=True)
        approved = self.ok('/extension/register', body, origin=ORIGIN)
        repeated = self.ok('/extension/register', body, origin=ORIGIN)
        self.assertEqual(approved, repeated)
        self.stop()
        self.start()
        self.assertEqual(approved, self.ok('/extension/register', body, origin=ORIGIN))
        foreign, _ = self.register(OTHER_ORIGIN)
        self.assertFalse(foreign['approved'])
        self.assertNotEqual(foreign['peer_id'], approved['peer_id'])

    def test_operator_auth_browser_origin_and_exact_host(self):
        for route in ('/operator/status', '/operator/pending', '/operator/receipt?id=' + uid()):
            self.assertEqual(self.request(route)[0], 403)
            self.assertEqual(self.request(route, headers={'X-CLW-Operator': 'wrong'})[0], 403)
            for origin in (ORIGIN, 'https://chatgpt.com', 'null', ''):
                self.assertEqual(self.request(route, operator=True, origin=origin)[0], 403)
        self.assertEqual(self.request('/operator/status', operator=True, headers={'Host': 'evil.test'})[0], 403)
        self.assertEqual(self.request('/operator/status', operator=True, headers={'Host': f'127.0.0.1:{self.port}.evil.test'})[0], 403)
        self.assertEqual(self.request('/operator/status', operator=True, headers={'Host': f'localhost:{self.port}'})[0], 200)

    def test_extension_origin_cors_methods_and_endpoint_isolation(self):
        body = {'extension_version': '0.7.0', 'profile_id': uid(), 'instance_nonce': uid(), 'pages': []}
        for origin in (None, 'https://chatgpt.com', 'null', ORIGIN + '/', 'chrome-extension://' + 'q' * 32):
            code, _, headers = self.request('/extension/register', body, origin=origin)
            self.assertEqual(code, 403)
            self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(self.request('/extension/register', body, origin=ORIGIN, headers={'Host': 'evil.test'})[0], 403)
        code, _, headers = self.request('/extension/register', body, origin=ORIGIN)
        self.assertEqual(code, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], ORIGIN)
        self.assertEqual(self.request('/extension/poll', origin=ORIGIN)[0], 405)
        preflight = {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-clw-peer'}
        code, _, headers = self.request('/extension/poll', origin=ORIGIN, method='OPTIONS', headers=preflight)
        self.assertEqual(code, 204)
        self.assertEqual(headers['Access-Control-Allow-Methods'], 'POST')
        self.assertEqual(headers['Access-Control-Allow-Origin'], ORIGIN)
        self.assertEqual(self.request('/extension/poll', origin=ORIGIN, method='OPTIONS', headers={**preflight, 'Access-Control-Request-Headers': 'x-clw-operator'})[0], 403)
        self.assertEqual(self.request('/extension/poll', origin=ORIGIN, method='OPTIONS', headers={**preflight, 'Access-Control-Request-Method': 'GET'})[0], 403)
        self.assertEqual(self.request('/operator/status', operator=True, origin=ORIGIN)[0], 403)

    def test_peer_token_origin_binding_and_pending_peer_cannot_poll(self):
        pending, _ = self.register()
        body = {'peer_id': pending['peer_id'], 'pages': [page()]}
        self.assertEqual(self.request('/extension/poll', body, origin=ORIGIN, token='wrong')[0], 403)
        peer, _ = self.pair()
        for token, origin in ((None, ORIGIN), ('wrong', ORIGIN), (peer['peer_token'], OTHER_ORIGIN)):
            self.assertEqual(self.request('/extension/poll', {'peer_id': peer['peer_id'], 'pages': [page()]}, origin=origin, token=token)[0], 403)

    def test_operator_can_control_any_registered_chat_without_per_chat_approval(self):
        peer, body = self.pair(pages=[page(), page(OTHER_CHAT, 8)])
        command = {'id': uid(), 'type': 'inspect', 'chatUrl': OTHER_CHAT, 'payload': {}}
        self.assertEqual(self.ok('/operator/command', command, operator=True)['receipt']['tabId'], 8)
        delivered = self.poll(peer, pages=[page(), page(OTHER_CHAT, 8)])['command']
        self.assertEqual(delivered['id'], command['id'])
        self.assertEqual(delivered['chatUrl'], OTHER_CHAT)
        self.assertEqual(self.server.broker.state['peers'][peer['peer_id']]['allow_chats'], [CHAT])
        self.ok('/extension/register', {**body, 'pages': [page(enabled=False)]}, origin=ORIGIN)
        start = {**command, 'id': uid(), 'chatUrl': CHAT, 'type': 'watch'}
        self.ok('/operator/command', start, operator=True)
        self.assertEqual(self.poll(peer, pages=[page(enabled=False)])['command']['id'], start['id'])

    def test_public_ready_requires_approved_peer_and_active_instance_token(self):
        pending, registration = self.register()
        public = self.ok('/operator/pending', operator=True)['peers'][0]
        self.assertFalse(public['approved'])
        self.assertFalse(public['ready'])
        approval = self.ok('/operator/approve', {'peer_id': pending['peer_id'], 'pairing_nonce': pending['pairing_nonce'],
                                               'allow_chat': CHAT}, operator=True)
        self.assertTrue(approval['peer']['approved'])
        self.assertFalse(approval['peer']['ready'])
        public = self.ok('/operator/status', operator=True)['peers'][0]
        self.assertTrue(public['approved'])
        self.assertFalse(public['ready'])
        command = {'id': uid(), 'type': 'inspect', 'chatUrl': CHAT, 'payload': {}}
        self.assertEqual(self.request('/operator/command', command, operator=True)[0], 409)
        peer = self.ok('/extension/register', registration, origin=ORIGIN)
        public = self.ok('/operator/status', operator=True)['peers'][0]
        self.assertTrue(public['ready'])
        self.assertNotIn('peer_token', public)
        self.ok('/operator/command', command, operator=True)
        self.assertEqual(self.poll(peer)['command']['id'], command['id'])

    def test_registered_scope_does_not_allow_unregistered_chat_or_extension_enqueue(self):
        peer, _ = self.pair()
        body = {'id': uid(), 'type': 'inspect', 'chatUrl': OTHER_CHAT, 'payload': {}}
        self.assertEqual(self.request('/operator/command', body, operator=True)[0], 409)
        self.assertEqual(self.request('/operator/command', {**body, 'chatUrl': CHAT}, origin=ORIGIN,
                                      token=peer['peer_token'])[0], 403)
        self.assertEqual(self.request('/extension/command', {**body, 'chatUrl': CHAT}, origin=ORIGIN,
                                      token=peer['peer_token'])[0], 403)

    def test_ambiguous_tabs_and_origins_require_unique_selection(self):
        peer, _ = self.pair(pages=[page(), page(tab=8)])
        body = {'id': uid(), 'type': 'inspect', 'chatUrl': CHAT, 'payload': {}}
        self.assertEqual(self.request('/operator/command', body, operator=True)[0], 409)
        self.assertEqual(self.ok('/operator/command', {**body, 'tabId': 8}, operator=True)['receipt']['tabId'], 8)
        second, _ = self.pair(OTHER_ORIGIN)
        body.update(id=uid(), tabId=7)
        self.assertEqual(self.request('/operator/command', body, operator=True)[0], 409)
        receipt = self.ok('/operator/command', {**body, 'peer_id': second['peer_id']}, operator=True)['receipt']
        self.assertEqual(receipt['peer_id'], second['peer_id'])

    def test_literal_text_and_envelope_preserved_without_execution_or_console_echo(self):
        peer, _ = self.pair()
        sentinel = self.root / 'never-created'
        literal = f"$(New-Item '{sentinel}'); `whoami`\n<script>alert('literal')</script>\n中文"
        queued, body = self.command('send', payload={'text': literal})
        self.assertNotIn(literal, json.dumps(queued))
        delivered = self.poll(peer)['command']
        self.assertEqual(delivered, {'id': body['id'], 'type': 'send', 'tabId': 7, 'chatUrl': CHAT, 'documentId': 'document-fixture', 'payload': {'text': literal}})
        self.assertFalse(sentinel.exists())
        disk = json.loads((self.root / 'receipts' / (body['id'] + '.json')).read_text(encoding='utf-8'))
        self.assertEqual(disk['request']['payload']['text'], literal)
        self.assertEqual(disk['state'], 'claimed')

    def test_concurrent_polls_claim_once_and_claim_is_already_on_disk(self):
        peer, _ = self.pair()
        _, body = self.command()
        barrier = threading.Barrier(8)
        def poll():
            barrier.wait()
            return self.poll(peer)['command']
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: poll(), range(8)))
        claimed = [item for item in responses if item]
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0]['id'], body['id'])
        raw = json.loads((self.root / 'receipts' / (body['id'] + '.json')).read_text())
        self.assertEqual(raw['state'], 'claimed')
        self.assertIn('claimed_at', raw)

    def test_lost_claim_never_replayed_after_server_restart(self):
        peer, body = self.pair()
        _, command = self.command('continue')
        self.assertEqual(self.poll(peer)['command']['id'], command['id'])
        self.stop()
        self.start()
        peer = self.ok('/extension/register', body, origin=ORIGIN)
        self.assertIsNone(self.poll(peer)['command'])
        self.assertEqual(self.receipt(command['id'])['state'], 'claimed')
        code, response, _ = self.result(peer, command['id'], state='unknown', result={'reason': 'delivery_unknown'})
        self.assertEqual(code, 200, response)
        self.assertEqual(self.receipt(command['id'])['state'], 'unknown')

    def test_duplicate_operation_and_duplicate_result_are_idempotent_conflicts_fail(self):
        peer, _ = self.pair()
        queued, body = self.command('send', payload={'text': 'literal'})
        self.assertEqual(queued, self.ok('/operator/command', body, operator=True))
        changed = {**body, 'payload': {'text': 'different'}}
        self.assertEqual(self.request('/operator/command', changed, operator=True)[0], 409)
        self.assertEqual(self.result(peer, body['id'])[0], 409)
        self.poll(peer)
        result = {'visible': {'busy': False}, 'text': 'explicit inspect output'}
        first = self.result(peer, body['id'], result=result)
        self.assertEqual(first[0], 200)
        self.assertEqual(first[1], self.result(peer, body['id'], result=result)[1])
        self.assertEqual(self.result(peer, body['id'], state='unknown', result=result)[0], 409)
        self.assertEqual(self.result(peer, body['id'], result={'different': True})[0], 409)
        self.assertEqual(self.receipt(body['id'])['result'], result)
        self.assertIsNone(self.poll(peer)['command'])

    def test_document_navigation_or_absent_page_fails_before_claim(self):
        peer, _ = self.pair()
        for pages in ([page(doc='new-document')], [], [page(OTHER_CHAT)]):
            self.poll(peer)  # Restore original binding.
            _, body = self.command()
            self.assertIsNone(self.poll(peer, pages=pages)['command'])
            receipt = self.receipt(body['id'])
            self.assertEqual(receipt['state'], 'failed')
            self.assertEqual(receipt['error'], 'page_binding_changed_before_claim')
        self.poll(peer, pages=[page(doc=None)])
        _, body = self.command()
        self.assertIsNone(self.receipt(body['id'])['documentId'])
        self.assertIsNone(self.poll(peer, pages=[page(doc='now-known')])['command'])

    def test_expired_queued_commands_fail_and_claimed_commands_are_not_expired_or_retried(self):
        peer, _ = self.pair()
        _, claimed = self.command()
        self.poll(peer)
        _, queued = self.command()
        future = time.time() + control.TTL_SECONDS + 1
        with patch.object(control.time, 'time', return_value=future):
            self.assertIsNone(self.poll(peer)['command'])
            self.assertEqual(self.receipt(queued['id'])['state'], 'failed')
            self.assertEqual(self.receipt(queued['id'])['error'], 'expired_before_claim')
            self.assertEqual(self.receipt(claimed['id'])['state'], 'claimed')
            replay = self.ok('/operator/command', queued, operator=True)
            self.assertEqual(replay['receipt']['state'], 'failed')

    def test_metadata_endpoints_and_errors_do_not_expose_auth_or_content(self):
        peer, _ = self.pair()
        private_text = 'not-in-status-or-pending-or-command-receipt'
        _, command = self.command('send', payload={'text': private_text})
        self.poll(peer)
        self.result(peer, command['id'], result={'text': peer['peer_token'] + self.secret, 'peer_token': 'should-hide', self.secret: 'secret key'})
        for route in ('/operator/status', '/operator/pending', '/operator/receipt?id=' + command['id']):
            response = self.ok(route, operator=True)
            raw = json.dumps(response)
            for secret in (self.secret, peer['peer_token'], private_text):
                self.assertNotIn(secret, raw)
        status = self.ok('/operator/status', operator=True)
        self.assertNotIn('result', status)
        self.assertNotIn('payload', json.dumps(status))
        self.assertEqual(status['commands']['completed'], 1)

    def test_instance_change_revokes_old_token_and_never_reassigns_original_command(self):
        peer, _ = self.pair()
        _, queued = self.command()
        replacement, _ = self.register(nonce=uid())
        self.assertTrue(replacement['approved'])
        self.assertNotEqual(replacement['peer_token'], peer['peer_token'])
        self.assertIsNone(self.poll(replacement)['command'])
        self.assertEqual(self.request('/extension/poll', {'peer_id': peer['peer_id'], 'pages': [page()]}, origin=ORIGIN, token=peer['peer_token'])[0], 403)
        self.assertEqual(self.receipt(queued['id'])['state'], 'enqueued')

    def test_same_origin_parallel_profiles_have_independent_tokens_and_page_bindings(self):
        first, first_body = self.pair(profile=uid(), allow=[CHAT, OTHER_CHAT])
        second, second_body = self.register(profile=uid(), pages=[page(OTHER_CHAT, tab=7, doc='profile-b-document')])
        self.assertTrue(second['approved'])
        self.assertNotEqual(first['peer_id'], second['peer_id'])
        self.assertNotEqual(first['peer_token'], second['peer_token'])
        for _ in range(3):
            self.assertEqual(self.ok('/extension/register', first_body, origin=ORIGIN), first)
            self.assertEqual(self.ok('/extension/register', second_body, origin=ORIGIN), second)
        _, first_command = self.command(url=CHAT)
        _, second_command = self.command(url=OTHER_CHAT)
        with ThreadPoolExecutor(max_workers=2) as pool:
            left = pool.submit(self.poll, first)
            right = pool.submit(self.poll, second, [page(OTHER_CHAT, tab=7, doc='profile-b-document')])
            self.assertEqual(left.result()['command']['id'], first_command['id'])
            self.assertEqual(right.result()['command']['id'], second_command['id'])
        self.assertEqual(self.result(first, first_command['id'])[0], 200)
        self.assertEqual(self.result(second, second_command['id'])[0], 200)
        profiles = {peer['profile_id'] for peer in self.ok('/operator/status', operator=True)['peers']}
        self.assertEqual(profiles, {first_body['profile_id'], second_body['profile_id']})

    def test_same_profile_restart_revokes_only_that_profile_and_never_replays_old_claims(self):
        first, first_body = self.pair(profile=uid(), allow=[CHAT, OTHER_CHAT])
        second_pages = [page(OTHER_CHAT, doc='profile-b-document')]
        second, _ = self.register(profile=uid(), pages=second_pages)
        _, old_claim = self.command(url=CHAT)
        self.assertEqual(self.poll(first)['command']['id'], old_claim['id'])
        _, second_command = self.command(url=OTHER_CHAT)
        new_body = {**first_body, 'instance_nonce': uid()}
        replacement = self.ok('/extension/register', new_body, origin=ORIGIN)
        self.assertEqual(replacement['peer_id'], first['peer_id'])
        self.assertNotEqual(replacement['peer_token'], first['peer_token'])
        self.assertEqual(self.request('/extension/poll', {'peer_id': first['peer_id'], 'pages': [page()]}, origin=ORIGIN, token=first['peer_token'])[0], 403)
        self.assertEqual(self.poll(second, pages=second_pages)['command']['id'], second_command['id'])
        self.assertEqual(self.result(second, second_command['id'])[0], 200)
        self.assertIsNone(self.poll(replacement)['command'])
        self.assertEqual(self.receipt(old_claim['id'])['state'], 'claimed')

    def test_pending_profile_inherits_approved_origin_and_new_profile_gets_union_allowlist(self):
        first, first_body = self.register(profile=uid())
        second, second_body = self.register(profile=uid(), pages=[page(OTHER_CHAT)])
        self.assertFalse(first['approved'])
        self.assertFalse(second['approved'])
        self.ok('/operator/approve', {'peer_id': first['peer_id'], 'pairing_nonce': first['pairing_nonce'], 'allow_chat': CHAT}, operator=True)
        second = self.ok('/extension/register', second_body, origin=ORIGIN)
        self.assertTrue(second['approved'])
        second_nonce = self.server.broker.state['peers'][second['peer_id']]['pairing_nonce']
        self.ok('/operator/approve', {'peer_id': second['peer_id'], 'pairing_nonce': second_nonce, 'allow_chat': OTHER_CHAT}, operator=True)
        third, _ = self.register(profile=uid(), pages=[])
        self.assertTrue(third['approved'])
        peer = next(peer for peer in self.ok('/operator/status', operator=True)['peers'] if peer['peer_id'] == third['peer_id'])
        self.assertEqual(set(peer['allow_chats']), {CHAT, OTHER_CHAT})
        foreign, _ = self.register(origin=OTHER_ORIGIN, profile=first_body['profile_id'])
        self.assertFalse(foreign['approved'])

    def test_legacy_peer_profile_migration_preserves_tokens_and_original_receipts(self):
        peer, registration = self.pair()
        _, command = self.command()
        self.poll(peer)
        receipt_path = self.root / 'receipts' / (command['id'] + '.json')
        original_receipt = receipt_path.read_bytes()
        self.stop()
        state_path = self.root / 'peers.json'
        state = json.loads(state_path.read_text(encoding='utf-8'))
        del state['peers'][peer['peer_id']]['profile_id']
        control.atomic_write(state_path, state)
        self.start()
        migrated = self.server.broker.state['peers'][peer['peer_id']]
        self.assertEqual(migrated['profile_id'], registration['instance_nonce'])
        self.assertEqual(migrated['instances'][registration['instance_nonce']], peer['peer_token'])
        self.assertEqual(receipt_path.read_bytes(), original_receipt)
        self.assertEqual(self.receipt(command['id'])['state'], 'claimed')
        self.assertIsNone(self.poll(peer)['command'])
        persisted = json.loads(state_path.read_text(encoding='utf-8'))
        self.assertEqual(persisted['peers'][peer['peer_id']]['profile_id'], registration['instance_nonce'])

    def test_owner_file_lease_prevents_second_server_even_on_different_port(self):
        with self.assertRaises(ValueError):
            control.create_server(0, self.root)
        self.assertEqual(self.ok('/operator/status', operator=True)['commands']['claimed'], 0)

    def test_schema_size_bounds_reject_extra_fields_bad_urls_and_oversize_results(self):
        peer, _ = self.pair()
        registration = {'extension_version': 'x', 'profile_id': uid(), 'instance_nonce': uid(), 'pages': [page()]}
        invalid = [
            {**registration, 'pages': [page()] * 33},
            {**registration, 'pages': [page(), page()]},
            {**registration, 'pages': [page('https://chatgpt.com/c/' + uid() + '?query=secret')]},
            {**registration, 'pages': [{**page(), 'text': 'private chat content'}]},
            {**registration, 'pages': [page(tab=True)]},
            {**registration, 'extension_version': 'x' * 33},
            {**registration, 'instance_nonce': '../../escape'},
            {**registration, 'profile_id': '../../escape'},
            {key: value for key, value in registration.items() if key != 'profile_id'},
        ]
        for body in invalid:
            self.assertEqual(self.request('/extension/register', body, origin=ORIGIN)[0], 400, body)
        for url in ('https://evil.test/c/' + uid(), 'https://chatgpt.com/', CHAT + '/', CHAT + '#fragment', 'http://chatgpt.com/c/' + uid()):
            command = {'id': uid(), 'type': 'inspect', 'chatUrl': url, 'payload': {}}
            self.assertEqual(self.request('/operator/command', command, operator=True)[0], 400)
        self.assertEqual(self.request('/operator/command', {'id': uid(), 'type': 'shell', 'chatUrl': CHAT, 'payload': {}}, operator=True)[0], 400)
        self.assertEqual(self.request('/operator/command', {'id': uid(), 'type': 'send', 'chatUrl': CHAT, 'payload': {'text': 'x' * 65537}}, operator=True)[0], 400)
        _, command = self.command()
        self.poll(peer)
        self.assertEqual(self.result(peer, command['id'], result={'text': 'x' * 65536})[0], 400)
        nested = 'leaf'
        for _ in range(18):
            nested = [nested]
        self.assertEqual(self.result(peer, command['id'], result=nested)[0], 400)
        self.assertEqual(self.receipt(command['id'])['state'], 'claimed')

    def test_atomic_write_failure_does_not_publish_or_claim_in_memory(self):
        peer, _ = self.pair()
        with patch.object(control, 'atomic_write', side_effect=OSError('fixture disk error')):
            body = {'id': uid(), 'type': 'inspect', 'chatUrl': CHAT, 'payload': {}}
            code, result, _ = self.request('/operator/command', body, operator=True)
            self.assertEqual(code, 500)
            self.assertNotIn('fixture disk error', json.dumps(result))
            self.assertNotIn(body['id'], self.server.broker.commands)
        _, command = self.command()
        with patch.object(self.server.broker, '_save_record', side_effect=OSError('claim write failed')):
            self.assertEqual(self.request('/extension/poll', {'peer_id': peer['peer_id'], 'pages': [page()]}, origin=ORIGIN, token=peer['peer_token'])[0], 500)
        self.assertEqual(self.receipt(command['id'])['state'], 'enqueued')
        self.assertEqual(self.poll(peer)['command']['id'], command['id'])

    def test_write_succeeded_but_return_failed_reconciles_disk_and_never_replays(self):
        peer, _ = self.pair()
        _, command = self.command('continue')
        original_write = control.atomic_write
        def uncertain_write(path, value):
            original_write(path, value)
            if path.parent.name == 'receipts':
                raise OSError('fixture uncertainty after replace')
        with patch.object(control, 'atomic_write', side_effect=uncertain_write):
            code, _, _ = self.request('/extension/poll', {'peer_id': peer['peer_id'], 'pages': [page()]}, origin=ORIGIN, token=peer['peer_token'])
            self.assertEqual(code, 500)
        self.assertEqual(self.receipt(command['id'])['state'], 'claimed')
        self.assertIsNone(self.poll(peer)['command'])

    def test_maximum_unicode_or_control_text_survives_disk_reload(self):
        peer, registration = self.pair()
        for literal in ('😀' * 65536, '\x01' * 65536, '中' * 65536):
            queued, command = self.command('send', payload={'text': literal})
            self.assertEqual(queued['receipt']['state'], 'enqueued')
            self.stop()
            self.start()
            peer = self.ok('/extension/register', registration, origin=ORIGIN)
            self.assertEqual(self.poll(peer)['command']['payload']['text'], literal)
            self.assertEqual(self.receipt(command['id'])['state'], 'claimed')

    def test_stop_generation_is_an_explicit_single_claim_command(self):
        peer, _ = self.pair()
        _, command = self.command('stop_generation')
        self.assertEqual(self.poll(peer)['command']['type'], 'stop_generation')
        self.assertIsNone(self.poll(peer)['command'])
        code, result, _ = self.result(peer, command['id'], result={'clicked': True})
        self.assertEqual(code, 200, result)

    def test_reload_extension_requires_operator_and_unknown_outcome_never_replays(self):
        peer, _ = self.pair()
        command = {'id': uid(), 'type': 'reload_extension', 'chatUrl': CHAT, 'payload': {}}
        self.assertEqual(self.request('/operator/command', command)[0], 403)
        self.assertEqual(self.request('/operator/command', command, origin=ORIGIN, token=peer['peer_token'])[0], 403)
        self.assertEqual(self.ok('/operator/command', command, operator=True)['receipt']['state'], 'enqueued')
        self.assertEqual(self.poll(peer)['command']['type'], 'reload_extension')
        self.assertIsNone(self.poll(peer)['command'])
        code, result, _ = self.result(peer, command['id'], state='unknown', result={'reload_requested': True, 'new_version_verified': False})
        self.assertEqual(code, 200, result)
        self.assertEqual(self.ok('/operator/command', command, operator=True)['receipt']['state'], 'unknown')
        self.assertIsNone(self.poll(peer)['command'])

    def test_new_instance_reconciles_only_same_peer_original_reload_extension(self):
        peer, registration = self.pair()
        _, claimed_reload = self.command('reload_extension')
        self.poll(peer)
        _, other_command = self.command('inspect')
        self.poll(peer)
        _, unknown_reload = self.command('reload_extension')
        self.poll(peer)
        self.assertEqual(self.result(peer, unknown_reload['id'], state='unknown', result={'reload_requested': True})[0], 200)
        _, queued_reload = self.command('reload_extension')
        before = {cid: deepcopy(self.server.broker.commands[cid]) for cid in (claimed_reload['id'], unknown_reload['id'])}

        # A version change alone, or registration of a different profile, proves
        # nothing about the original peer's worker restart.
        same_instance = {**registration, 'extension_version': '0.6.3'}
        self.ok('/extension/register', same_instance, origin=ORIGIN)
        other_peer, other_registration = self.register(profile=uid(), pages=[page(OTHER_CHAT)])
        _, other_peer_reload = self.command('reload_extension', url=OTHER_CHAT, peer_id=other_peer['peer_id'])
        self.poll(other_peer, pages=[page(OTHER_CHAT)])
        self.assertEqual(self.receipt(claimed_reload['id'])['state'], 'claimed')
        self.assertEqual(self.receipt(unknown_reload['id'])['state'], 'unknown')

        restarted = self.ok('/extension/register', {**same_instance, 'instance_nonce': uid()}, origin=ORIGIN)
        expected = {'extension_restart_verified': True, 'extension_version': '0.6.3', 'evidence_source': 'extension_registration'}
        for cid in before:
            receipt = self.receipt(cid)
            self.assertEqual(receipt['state'], 'completed')
            self.assertEqual(receipt['result'], expected)
            after = self.server.broker.commands[cid]
            for key in ('request', 'command', 'peer_id', 'instance_nonce', 'created_at', 'expires_at', 'claimed_at'):
                self.assertEqual(after[key], before[cid][key])
            self.assertEqual(self.result(restarted, cid, state='unknown', result={'late': True})[0], 409)
            self.assertEqual(self.receipt(cid)['result'], expected)
        self.assertEqual(self.receipt(other_command['id'])['state'], 'claimed')
        self.assertEqual(self.receipt(queued_reload['id'])['state'], 'enqueued')
        self.assertEqual(self.receipt(other_peer_reload['id'])['state'], 'claimed')
        self.assertIsNone(self.poll(restarted)['command'])
        self.assertEqual(self.ok('/extension/register', other_registration, origin=ORIGIN), other_peer)
        self.stop()
        self.start()
        self.assertEqual(self.receipt(claimed_reload['id'])['result'], expected)
        self.assertEqual(self.receipt(unknown_reload['id'])['state'], 'completed')

    def test_restart_receipt_write_failure_keeps_original_generation_for_reconciliation(self):
        peer, registration = self.pair()
        _, command = self.command('reload_extension')
        self.poll(peer)
        new_instance = {**registration, 'instance_nonce': uid(), 'extension_version': '0.6.3'}
        with patch.object(self.server.broker, '_save_record', side_effect=OSError('fixture receipt write failure')):
            self.assertEqual(self.request('/extension/register', new_instance, origin=ORIGIN)[0], 500)
        self.assertEqual(self.server.broker.state['peers'][peer['peer_id']]['active_instance'], registration['instance_nonce'])
        self.assertEqual(self.receipt(command['id'])['state'], 'claimed')
        self.ok('/extension/register', new_instance, origin=ORIGIN)
        self.assertEqual(self.receipt(command['id'])['state'], 'completed')

    def test_reused_older_instance_nonce_is_not_extension_restart_proof(self):
        _, registration = self.pair()
        current = self.ok('/extension/register', {**registration, 'instance_nonce': uid()}, origin=ORIGIN)
        _, command = self.command('reload_extension')
        self.poll(current)
        self.ok('/extension/register', registration, origin=ORIGIN)
        self.assertEqual(self.receipt(command['id'])['state'], 'claimed')

    def test_operator_enqueue_wakes_waiting_poll(self):
        peer, _ = self.pair()
        self.server.broker.poll_seconds = 2
        started = threading.Event()
        def wait_poll():
            started.set()
            return self.poll(peer)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(wait_poll)
            self.assertTrue(started.wait(1))
            _, command = self.command()
            self.assertEqual(future.result(timeout=1)['command']['id'], command['id'])

    def test_terminal_duplicate_result_preserves_json_boolean_identity(self):
        peer, _ = self.pair()
        _, command = self.command()
        self.poll(peer)
        self.assertEqual(self.result(peer, command['id'], result={'clicked': True})[0], 200)
        self.assertEqual(self.result(peer, command['id'], result={'clicked': 1})[0], 409)

    def test_runtime_corruption_fails_closed_and_preserves_original_file(self):
        with tempfile.TemporaryDirectory(prefix='clw-bad-runtime-') as temporary:
            root = Path(temporary) / 'runtime'
            server = control.create_server(0, root)
            server.server_close()
            state = root / 'peers.json'
            state.write_bytes(b'{invalid original file')
            for _ in range(2):
                with self.assertRaises(ValueError):
                    control.create_server(0, root)
            self.assertEqual(state.read_bytes(), b'{invalid original file')

    def test_cli_uses_private_token_and_returns_bounded_receipt_without_payload(self):
        self.pair()
        output = io.StringIO()
        with redirect_stdout(output):
            status = control.main(['--runtime-dir', str(self.root), '--port', str(self.port), 'status'])
        self.assertEqual(status, 0)
        self.assertNotIn(self.secret, output.getvalue())
        cid = uid()
        text = self.root / 'literal.txt'
        text.write_text('$(literal)\n中文', encoding='utf-8')
        output = io.StringIO()
        with redirect_stdout(output):
            status = control.main(['--runtime-dir', str(self.root), '--port', str(self.port), 'command', '--url', CHAT,
                                   '--type', 'send', '--id', cid, '--text-file', str(text), '--wait-seconds', '0.01'])
        self.assertEqual(status, 0)
        receipt = json.loads(output.getvalue())['receipt']
        self.assertEqual(receipt['id'], cid)
        self.assertEqual(receipt['state'], 'enqueued')
        self.assertNotIn('literal', output.getvalue())
        output = io.StringIO()
        with redirect_stdout(output):
            status = control.main(['--runtime-dir', str(self.root), '--port', str(self.port), 'receipt', '--id', cid])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())['receipt']['id'], cid)


if __name__ == '__main__':
    unittest.main()
