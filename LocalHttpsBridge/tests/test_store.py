"""Isolated stdlib-only storage tests; never read application config or keys.
Run: py -3.13 -B -m unittest discover -s LocalHttpsBridge/tests -p test_store.py -v
"""

import base64
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge_store
from bridge_store import UsageStore


DAY = 86400
BASE = 1700000000 // DAY * DAY
METRICS = {
    'requests', 'success', 'failed', 'in_bytes', 'out_bytes', 'duration_ms',
    'avg_ms', 'input_tokens', 'output_tokens', 'total_tokens',
    'usage_known', 'usage_unknown',
}
DETAILS = {
    'ts', 'ip', 'model', 'key_id', 'path', 'method', 'status', 'outcome',
    'in_bytes', 'out_bytes', 'duration_ms', 'input_tokens', 'output_tokens',
    'total_tokens',
}


class Clock:
    def __init__(self):
        self.now = float(BASE)

    def __call__(self):
        return self.now


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'usage.sqlite3'
        self.clock = Clock()
        self.store = UsageStore(self.path, clock=self.clock)
        self.addCleanup(lambda: self.store.close())

    def reopen(self):
        self.store.close()
        self.store = UsageStore(self.path, clock=self.clock)

    def query(self, sql, parameters=()):
        with closing(sqlite3.connect(str(self.path))) as db:
            return db.execute(sql, parameters).fetchall()

    def complete(self, at=None, ip='192.0.2.1', key_id=None, model='model-a',
                 path='/v1/chat/completions', method='POST', status=200,
                 in_bytes=10, out_bytes=20, duration_ms=40, usage=None, outcome='ok'):
        if at is not None:
            self.clock.now = at
        request_id = self.store.begin(ip, key_id, model, path, method)
        self.assertTrue(self.store.finish(request_id, status, in_bytes, out_bytes,
                                          duration_ms, usage=usage, outcome=outcome))
        return request_id

    def test_empty_snapshot_schema(self):
        snapshot = self.store.snapshot()
        self.assertEqual(set(snapshot), {'summary', 'models', 'ips', 'keys',
                                         'details', 'retention_days', 'active'})
        self.assertEqual(set(snapshot['summary']), METRICS)
        self.assertEqual(snapshot['summary']['requests'], 0)
        self.assertIsNone(snapshot['summary']['total_tokens'])
        self.assertEqual(snapshot['summary']['avg_ms'], 0)
        self.assertEqual(snapshot['details'], [])
        self.assertEqual(snapshot['retention_days'], 30)

    def test_wal_and_no_body_or_plaintext_schema(self):
        self.assertEqual(self.query('PRAGMA journal_mode')[0][0], 'wal')
        tables = self.query("SELECT name FROM sqlite_master WHERE type='table'")
        for (name,) in tables:
            columns = {row[1] for row in self.query('PRAGMA table_info(' + name + ')')}
            self.assertFalse(columns & {'body', 'image', 'images', 'key', 'raw_key'})

    def test_issue_entropy_and_public_fields(self):
        first = self.store.issue_key('tablet', '192.0.2.1')
        second = self.store.issue_key()
        self.assertEqual(set(first), {'id', 'key', 'label', 'prefix', 'created', 'revoked'})
        self.assertTrue(first['key'].startswith('lbp_'))
        entropy = base64.urlsafe_b64decode(first['key'][4:] + '=')
        self.assertGreaterEqual(len(entropy), 32)
        self.assertNotEqual(first['key'], second['key'])
        self.assertTrue(first['key'].startswith(first['prefix']))
        self.assertFalse(first['revoked'])
        self.assertEqual(first['created'], BASE)
        self.assertEqual(self.store.resolve_key(first['key']), {'id': first['id'], 'label': 'tablet'})
        self.assertEqual(self.store.devices()[0]['ip'], '192.0.2.1')
        for item in self.store.list_keys():
            self.assertEqual(set(item), {'id', 'label', 'prefix', 'created', 'revoked'})

    def test_only_sha256_is_persisted_even_in_wal(self):
        # Keep another connection open so committed writes remain in WAL too.
        with closing(sqlite3.connect(str(self.path))) as observer:
            observer.execute('SELECT COUNT(*) FROM api_keys').fetchone()
            issued = self.store.issue_key('synthetic test key')
            digest = hashlib.sha256(issued['key'].encode('ascii')).hexdigest()
            self.assertEqual(self.query('SELECT key_hash FROM api_keys'), [(digest,)])
            self.complete(usage={'input_tokens': 2})
            self.assertTrue(Path(str(self.path) + '-wal').exists())
            for file in Path(self.temp.name).iterdir():
                self.assertFalse(issued['key'].encode() in file.read_bytes(),
                                 'plaintext test key leaked into a database file')
        public = json.dumps([self.store.list_keys(), self.store.snapshot(), self.store.devices()])
        self.assertFalse(issued['key'] in public)
        self.assertFalse(digest in public)

    def test_keys_persist_and_revocation_is_idempotent(self):
        issued = self.store.issue_key('persistent')
        self.reopen()
        self.assertEqual(self.store.resolve_key(issued['key'])['id'], issued['id'])
        self.assertTrue(self.store.revoke_key(issued['id']))
        self.assertTrue(self.store.revoke_key(issued['id']))
        self.assertFalse(self.store.revoke_key(999999))
        self.assertIsNone(self.store.resolve_key(issued['key']))
        self.reopen()
        self.assertIsNone(self.store.resolve_key(issued['key']))
        self.assertTrue(self.store.list_keys()[0]['revoked'])

    def test_invalid_key_and_id_inputs(self):
        for raw in (None, '', 'bad', 'lbp_' + 'x' * 43, 'lbp_' + 'x' * 100000, {}, 42):
            self.assertIsNone(self.store.resolve_key(raw))
        for key_id in (None, 0, -1, True, '1', {}, 10 ** 100):
            self.assertFalse(self.store.revoke_key(key_id))

    def test_key_limit_and_revoke_frees_slot(self):
        first = self.store.issue_key()
        for _ in range(999):
            self.store.issue_key()
        self.assertEqual(len(self.store.list_keys()), 1000)
        with self.assertRaisesRegex(ValueError, 'limit'):
            self.store.issue_key()
        self.store.revoke_key(first['id'])
        newest = self.store.issue_key('replacement')
        listed = self.store.list_keys()
        self.assertEqual(len(listed), 1000)
        self.assertEqual(listed[0]['id'], newest['id'])

    def test_exactly_once_and_unknown_finish(self):
        request_id = self.complete()
        self.assertFalse(self.store.finish(request_id, 500, 1000, 2000, 900))
        self.assertFalse(self.store.finish('unknown', 200, 1, 2, 3))
        self.assertFalse(self.store.finish({}, 200, 1, 2, 3))
        summary = self.store.snapshot()['summary']
        self.assertEqual((summary['requests'], summary['success'], summary['failed']), (1, 1, 0))
        self.assertEqual((summary['in_bytes'], summary['out_bytes'], summary['duration_ms']), (10, 20, 40))
        self.reopen()
        self.assertFalse(self.store.finish(request_id, 200, 1, 2, 3))
        self.assertEqual(self.store.snapshot()['summary'], summary)

    def test_begin_time_not_finish_time(self):
        request_id = self.store.begin('192.0.2.1', None, 'a', '/v1/test', 'post')
        self.clock.now += 120
        self.assertTrue(self.store.finish(request_id, 200, 1, 2, 3))
        item = self.store.snapshot()['details'][0]
        self.assertEqual(item['ts'], BASE)
        self.assertEqual(item['method'], 'POST')
        self.assertEqual(self.store.devices()[0]['last_seen'], BASE + 120)
        self.assertEqual(set(item), DETAILS)

    def test_groups_and_averages(self):
        key = self.store.issue_key('one')
        self.complete(key_id=key['id'], usage={'input_tokens': 4, 'output_tokens': 3, 'total_tokens': 7})
        self.complete(ip='192.0.2.2', model='model-b', status=503, duration_ms=60)
        snapshot = self.store.snapshot()
        summary = snapshot['summary']
        self.assertEqual((summary['requests'], summary['success'], summary['failed']), (2, 1, 1))
        self.assertEqual(summary['avg_ms'], 50)
        self.assertEqual(summary['total_tokens'], 7)
        self.assertEqual((summary['usage_known'], summary['usage_unknown']), (1, 1))
        for kind in ('models', 'ips', 'keys'):
            self.assertEqual(sum(item['requests'] for item in snapshot[kind]), 2)
            for item in snapshot[kind]:
                self.assertEqual(set(item), METRICS | {'name'})
        self.assertEqual({item['name'] for item in snapshot['keys']}, {'', str(key['id'])})

    def test_http_and_outcome_success_rules(self):
        for status, outcome in ((200, 'ok'), (302, 'ok'), (400, 'ok'),
                                (503, 'ok'), (200, 'cancelled'), (0, 'error')):
            self.complete(status=status, outcome=outcome)
        summary = self.store.snapshot()['summary']
        self.assertEqual((summary['success'], summary['failed']), (2, 4))

    def test_json_usage_aliases(self):
        response = json.loads('{"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16}}')
        self.complete(usage=response['usage'])
        item = self.store.snapshot()['details'][0]
        self.assertEqual([item[k] for k in ('input_tokens', 'output_tokens', 'total_tokens')], [11, 5, 16])

    def test_sse_last_usage_and_unknown_chunks(self):
        lines = [
            'data: {"choices":[{"delta":{"content":"synthetic ignored body"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}',
            'data: [DONE]',
        ]
        usage = None
        for line in lines:
            if line != 'data: [DONE]':
                usage = json.loads(line[6:]).get('usage') or usage
        self.complete(usage=usage)
        self.complete(usage=None)
        self.complete(usage={})
        snapshot = self.store.snapshot()
        self.assertEqual(snapshot['summary']['total_tokens'], 5)
        self.assertEqual((snapshot['summary']['usage_known'], snapshot['summary']['usage_unknown']), (1, 2))
        self.assertIsNone(snapshot['details'][0]['total_tokens'])

    def test_partial_usage_never_estimates_missing_values(self):
        self.complete(usage={'input_tokens': 8, 'output_tokens': None})
        snapshot = self.store.snapshot()
        for item in (snapshot['summary'], snapshot['details'][0], snapshot['models'][0]):
            self.assertEqual(item['input_tokens'], 8)
            self.assertIsNone(item['output_tokens'])
            self.assertIsNone(item['total_tokens'])
        self.assertEqual(snapshot['summary']['usage_known'], 1)
        self.complete(usage={'total_tokens': 7})
        item = self.store.snapshot()['details'][0]
        self.assertIsNone(item['input_tokens'])
        self.assertIsNone(item['output_tokens'])
        self.assertEqual(item['total_tokens'], 7)

    def test_known_zero_usage_is_not_unknown(self):
        self.complete(usage={'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0})
        summary = self.store.snapshot()['summary']
        self.assertEqual(summary['total_tokens'], 0)
        self.assertEqual((summary['usage_known'], summary['usage_unknown']), (1, 0))

    def test_invalid_usage_and_payload_fields_are_not_stored(self):
        for usage in (None, {}, 'data: [DONE]', {'input_tokens': -1},
                      {'input_tokens': True, 'output_tokens': '8', 'total_tokens': 2.5},
                      {'body': 'DO_NOT_STORE_BODY', 'images': ['DO_NOT_STORE_IMAGE']}):
            self.complete(usage=usage)
        summary = self.store.snapshot()['summary']
        self.assertEqual(summary['usage_unknown'], 6)
        self.assertIsNone(summary['input_tokens'])
        with self.assertRaises(TypeError):
            self.store.begin('ip', None, 'm', '/', 'POST', body='not accepted')
        for file in Path(self.temp.name).iterdir():
            data = file.read_bytes()
            self.assertNotIn(b'DO_NOT_STORE_BODY', data)
            self.assertNotIn(b'DO_NOT_STORE_IMAGE', data)

    def test_exact_subhour_and_day_ranges(self):
        for offset in (0, 1, 100, 3599, 3600, DAY-1, DAY):
            self.complete(at=BASE+offset)
        snapshot = self.store.snapshot(since=BASE+1, until=BASE+3599)
        self.assertEqual(snapshot['summary']['requests'], 2)
        self.assertEqual([item['ts'] for item in snapshot['details']], [BASE+100, BASE+1])
        self.assertEqual(self.store.snapshot(since=BASE, until=BASE+DAY)['summary']['requests'], 6)
        self.assertEqual(self.store.snapshot(since=BASE+DAY)['summary']['requests'], 1)
        self.assertEqual(self.store.snapshot(until=BASE+1)['summary']['requests'], 1)
        self.assertEqual(self.store.snapshot(since=BASE+1, until=BASE+1)['summary']['requests'], 0)

    def test_bad_ranges_rejected(self):
        for args in ({'since': float('nan')}, {'until': float('inf')}, {'since': True},
                     {'since': BASE+2, 'until': BASE+1}):
            with self.assertRaises(ValueError):
                self.store.snapshot(**args)

    def test_retention_keeps_all_lifetime_metrics_and_devices(self):
        self.complete(at=BASE, usage={'input_tokens': 2, 'total_tokens': 5})
        self.complete(at=BASE+DAY, ip='192.0.2.2', model='b', status=500)
        before = self.store.snapshot()
        self.clock.now = BASE + 32*DAY
        self.assertEqual(self.store.prune(), 2)
        self.assertEqual(self.store.prune(), 0)
        after = self.store.snapshot()
        for kind in ('summary', 'models', 'ips', 'keys'):
            self.assertEqual(before[kind], after[kind])
        self.assertEqual(after['details'], [])
        self.assertEqual(sum(d['requests'] for d in self.store.devices()), 2)
        self.assertEqual(self.query('SELECT COUNT(*) FROM hourly')[0][0], 2)
        self.reopen()
        self.assertEqual(self.store.snapshot()['summary'], before['summary'])
        old_day = self.store.snapshot(since=BASE, until=BASE+DAY)
        self.assertEqual(old_day['summary']['requests'], 1)
        self.assertEqual(old_day['summary']['total_tokens'], 5)

    def test_partial_purge_hour_has_no_overlap_or_token_fabrication(self):
        self.complete(at=BASE+100, usage={'input_tokens': 7})
        self.complete(at=BASE+1900, usage={'total_tokens': 9})
        self.complete(at=BASE+2000)
        self.clock.now = BASE + 30*DAY + 1800
        self.assertEqual(self.store.prune(), 1)
        all_time = self.store.snapshot(since=BASE, until=BASE+3600)
        self.assertEqual(all_time['summary']['requests'], 3)
        self.assertEqual(all_time['summary']['input_tokens'], 7)
        retained = self.store.snapshot(since=BASE+1800, until=BASE+1950)
        self.assertEqual(retained['summary']['requests'], 1)
        self.assertIsNone(retained['summary']['input_tokens'])
        self.assertEqual(retained['summary']['total_tokens'], 9)
        old = self.store.snapshot(since=BASE, until=BASE+1800)
        self.assertEqual(old['summary']['requests'], 1)
        self.assertEqual(old['summary']['input_tokens'], 7)
        self.assertIsNone(old['summary']['total_tokens'])
        mixed = self.store.snapshot(since=BASE, until=BASE+1950)
        self.assertEqual(mixed['summary']['requests'], 2)
        self.assertEqual(mixed['summary']['total_tokens'], 9)

    def test_pruned_filters_document_hour_granularity(self):
        self.complete(at=BASE+100)
        self.complete(at=BASE+3500)
        self.clock.now = BASE + 31*DAY
        self.store.prune()
        self.assertEqual(self.store.snapshot(since=BASE+1500, until=BASE+1600)['summary']['requests'], 2)
        self.assertEqual(self.store.snapshot(since=BASE+3600, until=BASE+7200)['summary']['requests'], 0)

    def test_retention_strict_boundary_and_auto_prune(self):
        self.complete(at=BASE)
        self.complete(at=BASE+1)
        self.clock.now = BASE+30*DAY
        self.assertEqual(self.store.prune(), 0)
        self.assertEqual(self.store.prune(now=BASE+30*DAY+1), 1)
        self.complete(at=BASE+32*DAY)
        self.assertEqual(self.store.snapshot()['summary']['requests'], 3)
        self.assertEqual(len(self.store.snapshot()['details']), 1)

    def test_hourly_rows_bounded_by_dimensions_not_request_count(self):
        for i in range(120):
            self.complete(at=BASE+i, path='/route/' + str(i), method='GET' if i % 2 else 'POST')
        self.assertEqual(self.query('SELECT COUNT(*) FROM hourly')[0][0], 1)
        self.assertEqual(self.store.snapshot()['summary']['requests'], 120)

    def test_details_limits_and_newest_order(self):
        for i in range(210):
            self.complete(at=BASE+i)
        self.assertEqual(len(self.store.snapshot()['details']), 100)
        details = self.store.snapshot(limit=999999)['details']
        self.assertEqual(len(details), 200)
        self.assertEqual([d['ts'] for d in details], list(range(BASE+209, BASE+9, -1)))
        self.assertEqual(self.store.snapshot(limit=0)['details'], [])
        self.assertEqual(self.store.snapshot(limit=-1)['details'], [])
        self.assertEqual(self.store.snapshot(limit=1)['summary']['requests'], 210)

    def test_independent_ip_online_and_heartbeat(self):
        self.store.touch('192.0.2.1')
        self.clock.now += 200
        self.store.touch('192.0.2.2')
        self.clock.now += 100
        devices = {d['ip']: d for d in self.store.devices()}
        self.assertFalse(devices['192.0.2.1']['online'])
        self.assertTrue(devices['192.0.2.2']['online'])
        self.assertEqual(devices['192.0.2.1']['requests'], 0)
        self.store.touch('192.0.2.1')
        self.assertTrue(all(d['online'] for d in self.store.devices()))

    def test_active_stays_online_after_five_minutes_and_restart_resets(self):
        request_id = self.store.begin('192.0.2.1', None, 'm', '/', 'POST')
        self.store.touch('192.0.2.2')
        self.clock.now += 1000
        devices = {d['ip']: d for d in self.store.devices()}
        self.assertEqual(devices['192.0.2.1']['active'], 1)
        self.assertTrue(devices['192.0.2.1']['online'])
        self.assertFalse(devices['192.0.2.2']['online'])
        self.assertEqual(self.store.snapshot()['active'], 1)
        self.reopen()
        self.assertEqual(self.store.snapshot()['active'], 0)
        self.assertTrue(all(d['active'] == 0 and not d['online'] for d in self.store.devices()))
        self.assertFalse(self.store.finish(request_id, 200, 1, 2, 3))
        self.assertEqual(self.store.devices()[0]['last_seen'], BASE)

    def test_finishing_decrements_only_its_ip(self):
        a = self.store.begin('192.0.2.1', None, 'm', '/', 'POST')
        b = self.store.begin('192.0.2.2', None, 'm', '/', 'POST')
        self.store.finish(a, 200, 3, 4, 5)
        devices = {d['ip']: d for d in self.store.devices()}
        self.assertEqual((devices['192.0.2.1']['active'], devices['192.0.2.2']['active']), (0, 1))
        self.assertEqual((devices['192.0.2.1']['requests'], devices['192.0.2.1']['in_bytes']), (1, 3))
        self.store.finish(b, 500, 7, 8, 9)
        self.assertEqual(self.store.snapshot()['active'], 0)

    def test_active_admission_limit_fails_without_side_effect(self):
        with patch.object(bridge_store, '_MAX_ACTIVE', 2):
            a = self.store.begin('a', None, 'm', '/', 'GET')
            self.store.begin('b', None, 'm', '/', 'GET')
            with self.assertRaisesRegex(ValueError, 'limit'):
                self.store.begin('not-admitted', None, 'm', '/', 'GET')
            self.assertEqual({d['ip'] for d in self.store.devices()}, {'a', 'b'})
            self.store.finish(a, 200, 0, 0, 0)
            self.store.begin('c', None, 'm', '/', 'GET')
        self.assertEqual(self.store.snapshot()['active'], 2)

    def test_concurrent_duplicate_finishes_count_once(self):
        ids = [self.store.begin('ip-' + str(i % 2), None, 'm', '/', 'POST') for i in range(80)]
        def finish(request_id):
            return self.store.finish(request_id, 200, 3, 5, 7, usage={'total_tokens': 11})
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(finish, ids * 3))
        self.assertEqual(sum(results), 80)
        summary = self.store.snapshot()['summary']
        self.assertEqual((summary['requests'], summary['in_bytes'], summary['out_bytes']), (80, 240, 400))
        self.assertEqual((summary['duration_ms'], summary['total_tokens']), (560, 880))
        self.assertTrue(all(d['active'] == 0 and d['requests'] == 40 for d in self.store.devices()))

    def test_concurrent_begin_finish_and_snapshot(self):
        def worker(i):
            request_id = self.store.begin('ip-' + str(i % 3), None, 'm', '/', 'POST')
            self.store.touch('ip-' + str(i % 3))
            self.store.snapshot(limit=1)
            self.assertTrue(self.store.finish(request_id, 200, 1, 2, 3))
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(worker, range(60)))
        self.assertEqual(self.store.snapshot()['summary']['requests'], 60)
        self.assertEqual(self.store.snapshot()['active'], 0)

    def test_independent_connections_can_finish_same_database(self):
        other = UsageStore(self.path, clock=self.clock)
        try:
            def worker(i):
                store = self.store if i % 2 else other
                request_id = store.begin('ip', None, 'm', '/', 'POST')
                return store.finish(request_id, 200, 1, 2, 3)
            with ThreadPoolExecutor(max_workers=8) as pool:
                self.assertTrue(all(pool.map(worker, range(60))))
            self.assertEqual(self.store.snapshot()['summary']['requests'], 60)
            self.assertEqual(other.snapshot()['summary']['requests'], 60)
        finally:
            other.close()

    def test_metadata_sanitized_and_query_credentials_dropped(self):
        raw = self.store.issue_key()['key']
        self.store.issue_key('label\x00\n' + 'x' * 500)
        self.store.issue_key(raw)
        self.store.issue_key(raw[:20] + '\n' + raw[20:])
        self.complete(ip='i' * 500, model='m' * 500, path='/v1/chat?key=' + raw + '#secret', method='post\n')
        self.complete(model=raw, path='/v1/' + raw, outcome=raw)
        snapshot = self.store.snapshot()
        self.assertEqual(snapshot['details'][1]['path'], '/v1/chat')
        self.assertEqual(len(snapshot['details'][1]['ip']), 64)
        self.assertEqual(len(snapshot['details'][1]['model']), 128)
        self.assertEqual(snapshot['details'][1]['method'], 'POST')
        self.assertTrue(all(len(k['label']) <= 128 and '\n' not in k['label'] for k in self.store.list_keys()))
        self.assertFalse(raw in json.dumps([snapshot, self.store.list_keys()]))
        for file in Path(self.temp.name).iterdir():
            self.assertFalse(raw.encode() in file.read_bytes())

    def test_invalid_numeric_values_stay_finite_and_nonnegative(self):
        self.complete(status=None, in_bytes=-1, out_bytes=float('inf'), duration_ms=float('nan'))
        item = self.store.snapshot()['details'][0]
        self.assertEqual((item['status'], item['in_bytes'], item['out_bytes'], item['duration_ms']), (0, 0, 0, 0))
        json.dumps(self.store.snapshot(), allow_nan=False)

    def test_failed_transaction_can_be_retried_without_losing_active(self):
        request_id = self.store.begin('ip', None, 'm', '/', 'POST')
        with closing(sqlite3.connect(str(self.path))) as db:
            db.execute("CREATE TRIGGER reject_detail BEFORE INSERT ON details BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
            db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.finish(request_id, 200, 1, 2, 3)
        self.assertEqual(self.store.snapshot()['active'], 1)
        self.assertEqual(self.store.snapshot()['summary']['requests'], 0)
        with closing(sqlite3.connect(str(self.path))) as db:
            db.execute('DROP TRIGGER reject_detail')
            db.commit()
        self.assertTrue(self.store.finish(request_id, 200, 1, 2, 3))
        self.assertEqual(self.store.snapshot()['summary']['requests'], 1)

    def test_close_is_idempotent_and_releases_windows_files(self):
        self.complete()
        self.store.close()
        self.store.close()
        for call in (self.store.snapshot, self.store.devices, self.store.list_keys,
                     lambda: self.store.touch('ip'), lambda: self.store.issue_key(),
                     lambda: self.store.resolve_key('bad'), lambda: self.store.prune(),
                     lambda: self.store.begin('ip', None, 'm', '/', 'POST'),
                     lambda: self.store.finish('unknown', 200, 0, 0, 0)):
            with self.assertRaisesRegex(RuntimeError, 'closed'):
                call()
        renamed = self.path.with_suffix('.moved')
        self.path.rename(renamed)
        renamed.unlink()
        self.assertFalse(self.path.exists())

    def test_short_connections_release_files_even_without_close(self):
        self.store.issue_key()
        self.complete()
        self.store.list_keys()
        self.store.snapshot(since=BASE)
        self.store.devices()
        self.store.prune()
        self.assertIsNone(self.store._db)
        moved = self.path.with_suffix('.moved')
        self.path.rename(moved)
        moved.rename(self.path)
        self.assertEqual(self.store.snapshot()['summary']['requests'], 1)

    def test_filesystem_path_required(self):
        with self.assertRaisesRegex(ValueError, 'filesystem'):
            UsageStore(':memory:', clock=self.clock)


if __name__ == '__main__':
    unittest.main()
