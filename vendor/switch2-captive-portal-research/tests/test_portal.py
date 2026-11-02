import importlib.util
import json
import re
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / 'serve-switch2-browser-probe.py'
spec = importlib.util.spec_from_file_location('portal_under_test', SOURCE)
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)
portal.REPORT_DIRECTORY = ROOT / 'host-test-reports'


class PortalTests(unittest.TestCase):
    def setUp(self):
        self.server = portal.ProbeHTTPServer(('127.0.0.1', 0), True, True)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01})
        self.thread.start()
        code, value = self.request('/live/hello', {'pageBuild': 4, 'browser': {'userAgent': 'host-test', 'platform': 'host'}})
        self.assertEqual(code, 201)
        self.key = value['session']

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None, token=None, extra=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Probe-Session'] = token
        if extra:
            headers.update(extra)
        connection = HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request('GET' if body is None else 'POST', path,
                               None if body is None else json.dumps(body), headers)
            response = connection.getresponse()
            raw = response.read()
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                value = raw
            return response.status, value
        finally:
            connection.close()

    def test_page4_starts_without_automatic_tests(self):
        self.assertEqual(self.request('/live/next', {}, self.key), (200, {'job': None}))

    def test_named_queue_and_full_queue_rejection(self):
        self.assertEqual(self.request('/live/queue', {'tests': ['boundaries']}, self.key)[0], 200)
        self.assertEqual(self.request('/live/queue', {'tests': ['runtime']}, self.key)[0], 409)
        code, value = self.request('/live/next', {}, self.key)
        self.assertEqual(code, 200)
        self.assertEqual(value['job']['test'], 'boundaries')
        self.assertEqual(value['job']['revision'], self.server.module_revision('boundaries'))

    def test_full_page_baseline_queues_and_completes_all_installed_modules(self):
        page = (ROOT.parent / 'switch2-browser-probe.html').read_text()
        match = re.search(r"getElementById\('baseline'\).*queue\((\[[^]]+\])\)", page)
        self.assertIsNotNone(match)
        tests = json.loads(match.group(1).replace("'", '"'))
        self.assertEqual(set(tests), portal.TEST_NAMES)
        self.assertEqual(len(tests), 7)
        code, queued = self.request('/live/queue', {'tests': tests}, self.key)
        self.assertEqual(code, 200)
        self.assertEqual([job['test'] for job in queued['queued']], tests)
        for test in tests:
            with self.subTest(test=test):
                code, value = self.request('/live/next', {}, self.key)
                self.assertEqual(code, 200)
                job = value['job']
                self.assertEqual(job['test'], test)
                route = portal.TEST_PATHS[test] + '?v=' + job['revision']
                code, source = self.request(route)
                self.assertEqual(code, 200)
                self.assertEqual(source, (ROOT.parent / portal.MODULE_FILES[portal.TEST_PATHS[test]]).read_bytes())
                result = {'jobId': job['jobId'], 'test': test, 'revision': job['revision'],
                          'result': {'checks': [{'id': 'host-queue-fixture', 'status': 'passed'}]}}
                self.assertEqual(self.request('/live/result', result, self.key)[0], 201)
        self.assertEqual(self.request('/live/next', {}, self.key), (200, {'job': None}))
        self.assertEqual(self.server.sessions[self.key]['pending'], [])
        self.assertIsNone(self.server.sessions[self.key]['running'])

    def test_oversized_queue_rejected_without_pending_jobs(self):
        tests = sorted(portal.TEST_NAMES) + ['runtime']
        self.assertEqual(self.request('/live/queue', {'tests': tests}, self.key)[0], 400)
        self.assertEqual(self.server.sessions[self.key]['pending'], [])

    def test_native_arbitrary_duplicate_and_malformed_queue_rejected(self):
        for tests in [['native'], ['GetInfo'], ['runtime', 'runtime'], [], [{}], ['runtime'] * 5]:
            with self.subTest(tests=tests):
                self.assertEqual(self.request('/live/queue', {'tests': tests}, self.key)[0], 400)
        self.assertEqual(self.request('/live/queue', {'tests': ['runtime'], 'code': 'x'}, self.key)[0], 400)

    def test_queue_requires_private_page_session(self):
        self.assertEqual(self.request('/live/queue', {'tests': ['runtime']})[0], 403)
        self.server.sessions[self.key]['peer'] = '192.0.2.9'
        self.assertEqual(self.request('/live/queue', {'tests': ['runtime']}, self.key)[0], 403)

    def test_cross_origin_and_control_unauthorized(self):
        self.assertEqual(self.request('/live/queue', {'tests': ['runtime']}, self.key,
                                      {'Origin': 'http://example.invalid'})[0], 403)
        self.assertEqual(self.request('/control', {'tests': ['runtime'], 'session': self.key})[0], 403)

    def test_stop_clears_queue_and_rejects_late_activity(self):
        self.request('/live/queue', {'tests': ['runtime', 'boundaries']}, self.key)
        self.request('/live/next', {}, self.key)
        self.assertEqual(self.request('/live/stop', {}, self.key), (200, {'stopped': True}))
        state = self.server.sessions[self.key]
        self.assertEqual(state['pending'], [])
        self.assertIsNone(state['running'])
        self.assertEqual(state['results'][-1]['state'], 'cancelled_by_page')
        self.assertEqual(self.request('/live/next', {}, self.key)[0], 403)
        self.assertEqual(self.request('/live/queue', {'tests': ['runtime']}, self.key)[0], 403)

    def test_bad_stop_does_not_consume_session(self):
        self.assertEqual(self.request('/live/stop', {'anything': True}, self.key)[0], 400)
        self.assertEqual(self.request('/live/next', {}, self.key)[0], 200)

    def test_revision_mismatch_rejected_and_valid_result_saved_once(self):
        self.request('/live/queue', {'tests': ['boundaries']}, self.key)
        job = self.request('/live/next', {}, self.key)[1]['job']
        result = {'jobId': job['jobId'], 'test': job['test'], 'revision': '0' * 64,
                  'result': {'checks': [{'id': 'host-fixture', 'status': 'passed'}]}}
        self.assertEqual(self.request('/live/result', result, self.key)[0], 409)
        result['revision'] = job['revision']
        code, receipt = self.request('/live/result', result, self.key)
        self.assertEqual(code, 201)
        saved = (portal.REPORT_DIRECTORY / receipt['file']).read_text()
        self.assertNotIn(self.server.control_token, saved)
        self.assertEqual(json.loads(saved)['browser']['userAgent'], 'host-test')
        self.assertEqual(self.request('/live/result', result, self.key)[0], 409)

    def test_revision_bound_module_and_read_only_catalog(self):
        rev = self.server.module_revision('boundaries')
        self.assertEqual(self.request('/switch2-probes-boundaries.js?v=' + rev)[0], 200)
        self.assertEqual(self.request('/switch2-probes-boundaries.js?v=' + '0' * 64)[0], 409)
        code, catalog = self.request('/research-catalog')
        self.assertEqual(code, 200)
        self.assertEqual(len(catalog['history']), 0)
        self.assertTrue(all(not r['runnableHere'] for r in catalog['history'] + catalog['unfinished']))
        self.assertNotIn('/Users/', json.dumps(catalog))

    def test_old_page_build_still_supported(self):
        code, hello = self.request('/live/hello', {'pageBuild': 3, 'browser': {'userAgent': 'legacy-host-test', 'platform': 'host'}})
        self.assertEqual(code, 201)
        self.assertEqual(len(self.server.sessions[hello['session']]['pending']), 3)

    def test_no_native_or_arbitrary_file_routes(self):
        self.assertEqual(self.request('/native/call', {'svc': 1}, self.key)[0], 404)
        self.assertEqual(self.request('/../../etc/passwd')[0], 404)

    def test_stopped_sessions_do_not_exhaust_reconnect_capacity(self):
        key = self.key
        for _ in range(10):
            self.assertEqual(self.request('/live/stop', {}, key)[0], 200)
            code, hello = self.request('/live/hello', {'pageBuild': 4, 'browser': {'userAgent': 'host-test', 'platform': 'host'}})
            self.assertEqual(code, 201)
            key = hello['session']


if __name__ == '__main__':
    unittest.main(verbosity=2)
