"""Run with python3 -m unittest discover -s examples/player-clients/python -v."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import struct
import unittest
from unittest.mock import patch
from client import Client, Store, ProtocolError, RemoteError, canonical, strict_json, counter, digest

ROOT = Path(__file__).resolve().parents[3]
SCOPE = dict(serverId='server', roomId='room', roomEpoch='epoch', playerId='player-73235ea6-3a6a-4420-8ecd-1a789fcf4556')
IDENTITY = {**SCOPE, 'gamePlayer': 0, 'lobbySeat': 1, 'chatPlayer': 1, 'chatCount': 2,
            'roster': [{'gamePlayer': 0, 'chatPlayer': 1}, {'gamePlayer': 1, 'chatPlayer': 0}]}
EXPECTED = {k: v for k, v in IDENTITY.items() if k != 'roomEpoch'}


class Fake:
    def __init__(self):
        self.calls = []
        self.handlers = {}
    def call(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        return self.handlers[path](body)


def hello(sc=None):
    sc = sc or SCOPE
    return {'scope': sc, 'identity': {**IDENTITY, **sc}, 'sessionId': 'session', 'version': {'major': 2, 'minor': 0},
            'capabilities': ['core/2', 'actions.order/1', 'actions.schedule/1'], 'authorizationVersion': '9007199254740993', 'rulesetId': 'rule'}


def document(extra=None):
    return {'observation': {'revision': 'a'*64, 'view': {'player': 0, 'unknown': None, **(extra or {})}},
            'instructionsVersion': '9007199254740993', 'coverage': {'observation': 'complete', 'chat': 'not-supported'}}


def snapshot_pages(doc=None, split=False):
    text = canonical(doc or document()).decode()
    pieces = [text[:30], text[30:]] if split else [text]
    return [{'scope': SCOPE, 'snapshotId': 'snap', 'bootstrapExpiresAt': '2099-01-01T00:00:00Z',
             'streamEpoch': 'stream', 'highWatermark': '9007199254740993', 'cursor': 'cursor', 'decisionInputVersion': 'input',
             'snapshotDigest': hashlib.sha256(text.encode()).hexdigest(),
             'page': {'index': i, 'count': len(pieces), 'encoding': 'json-text/1', 'text': piece, 'nextPageToken': 'next' if i+1<len(pieces) else None}}
            for i, piece in enumerate(pieces)]


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)/'state.sqlite'
        self.store = Store(self.path)
        self.fake = Fake()
        self.fake.handlers['/protocol'] = lambda _: {'versions':[{'major':2,'minor':0}], 'capabilities':['core/2'], 'rulesetId':'rule', 'actionAvailability':{'actions':['set-shields','check-in']}}
        self.fake.handlers['/sessions/hello'] = lambda _: hello()
        self.client = Client(self.fake, self.store, EXPECTED, True, lambda: 10.0)
        self.client.hello()
        self.pages(snapshot_pages())
        self.client.snapshot()

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def pages(self, pages):
        self.fake.handlers['/snapshot'] = lambda _: copy.deepcopy(pages[0])
        if len(pages)>1:
            self.fake.handlers['/snapshot?snapshotId=snap&pageToken=next'] = lambda _: copy.deepcopy(pages[1])
        self.fake.handlers['/snapshot/snap/complete'] = lambda _: {'scope': SCOPE, 'completed': True}

    def acquire(self):
        lease = {'scope': SCOPE, 'generation': '9007199254740993', 'mode': 'agent', 'sessionId': 'session', 'ttlMs': 30000, 'remainingTtlMs': 10000}
        self.fake.handlers['/control/acquire'] = lambda _: {'current': lease, 'operationResult': lease}
        self.client.control('acquire')
        return lease

    def intent(self):
        self.acquire()
        return self.client.prepare('order', {'action': {'kind': 'set-shields', 'outpostId': '蓝方工厂', 'enabled': False}})

    def receipt(self, key, state='applied', version='3'):
        r = self.store.data['outbox'][key]
        return {'scope': SCOPE, 'commandId': 'command', 'idempotencyKey': key, 'clientCommandId': r['request']['clientCommandId'],
                'intentDigest': r['digest'], 'receiptVersion': version, 'state': state, 'effectCommitted': state in ('applied','scheduled','cancelled')}

    def lookup(self, key, status='history_unavailable', receipt=None):
        item = {'status': status, 'coverage': {'roomEpoch': 'epoch', 'authoritative': status!='history_unavailable',
                'retained': 'unavailable' if status=='history_unavailable' else 'complete', 'queryUntil': None}}
        if receipt: item['receipt'] = receipt
        else: item['idempotencyKey'] = key
        self.fake.handlers['/commands/lookup'] = lambda _: {'scope': SCOPE, 'results': [copy.deepcopy(item)]}

    def event_page(self, events):
        seq = self.store.data['seq']; cursor = self.store.data['cursor']
        return {'scope': SCOPE, 'streamEpoch': 'stream', 'inputCursor': cursor, 'nextCursor': events[-1]['cursor'] if events else cursor,
                'hasMore': False, 'coverage': {'fromExclusive': seq, 'toInclusive': events[-1]['seq'] if events else seq}, 'events': events}

    def event(self, kind='observation.changed', **kw):
        return {'scope': SCOPE, 'streamEpoch': 'stream', 'seq': str(counter(self.store.data['seq'])+1), 'cursor': 'next-cursor',
                'type': kind, 'schemaVersion': 1, 'required': True, 'payload': {}, **kw}

    def test_V01_V03_V04_normative_fixtures(self):
        fixtures = ROOT/'protocol/player/v2/fixtures'
        for vector in json.loads((fixtures/'canonical.json').read_text()):
            encoded = canonical(strict_json(vector['raw']))
            self.assertEqual(encoded.decode(), vector['canonical'], vector['name'])
            self.assertEqual(hashlib.sha256(encoded).hexdigest(), vector['sha256'])
        for value in json.loads((fixtures/'invalid-json.json').read_text()):
            with self.assertRaises(ProtocolError): strict_json(value)
        cases = json.loads((fixtures/'counters.json').read_text())
        for value in cases['valid']: self.assertEqual(str(counter(value)), value)
        for value in cases['invalid']:
            with self.assertRaises(ProtocolError): counter(value)
        for a,b in zip(cases['ordered'], cases['ordered'][1:]): self.assertLess(counter(a),counter(b))
        for raw in [b'"\xff"', '['*33+'0'+']'*33, b'\xef\xbb\xbf{}']:
            with self.assertRaises(ProtocolError): strict_json(raw)

    def test_V04_binary64_edge_and_deterministic_vectors(self):
        vectors=json.loads((ROOT/'examples/player-clients/interop/number-vectors.json').read_text())
        for v in vectors:
            number=struct.unpack('>d',bytes.fromhex(v['hex']))[0]
            self.assertEqual(canonical(number).decode(),v['canonical'],v['hex'])

    def test_valid_max_depth_document_persists_without_reducing_wire_limit(self):
        doc=document()
        nested=0
        for _ in range(29): nested=[nested]
        doc['observation']['view']['nested']=nested
        self.pages(snapshot_pages(doc))
        self.client.snapshot()
        self.store.close();self.store=Store(self.path)
        self.assertEqual(self.store.data['snapshot'],doc)

    def test_V02_distinguishes_missing_null_zero_empty(self):
        value = strict_json('{"null":null,"zero":0,"empty":[],"unknown":{"known":false}}')
        self.assertNotIn('missing',value)
        self.assertIsNone(value['null'])
        self.assertEqual(value['zero'],0)
        self.assertEqual(value['empty'],[])
        self.assertEqual(value['unknown'],{'known':False})

    def test_V05_pinned_identity_and_capability_fail_closed(self):
        for change in [{'version':{'major':3,'minor':0}}, {'capabilities':[]}, {'identity':{**IDENTITY,'lobbySeat':0}}]:
            self.fake.handlers['/sessions/hello'] = lambda _, change=change: {**hello(), **change}
            with self.assertRaises(ProtocolError): self.client.hello()
            self.assertFalse(self.client.writable())

    def test_S04_fixed_pages_and_atomic_install(self):
        self.pages(snapshot_pages(document({'new':True}),True))
        self.client.snapshot()
        self.assertTrue(self.store.data['snapshot']['observation']['view']['new'])
        old = copy.deepcopy(self.store.data)
        for mutate in [lambda p:p['page'].update(index=0),lambda p:p.update(highWatermark='1'),lambda p:p['page'].update(text='tampered')]:
            pages=snapshot_pages(document({'bad':True}),True);mutate(pages[1]);self.pages(pages)
            with self.assertRaises(ProtocolError):self.client.snapshot()
            self.assertEqual(self.store.data,old)

    def test_S02_expired_bootstrap_never_installs_partial(self):
        self.pages(snapshot_pages(document({'bad':True}),True))
        def expired(_):raise RemoteError(409,{'code':'SNAPSHOT_EXPIRED','category':'resync'})
        self.fake.handlers['/snapshot?snapshotId=snap&pageToken=next']=expired
        old=copy.deepcopy(self.store.data)
        with self.assertRaises(RemoteError):self.client.snapshot()
        self.assertEqual(self.store.data,old)

    def test_S05_event_commit_failure_replays_once(self):
        event=self.event();page=self.event_page([event]);route='/events?after=cursor&limit=200'
        self.fake.handlers[route]=lambda _:page
        with patch.object(self.store,'save',side_effect=OSError('simulated disk fault')):
            with self.assertRaises(OSError):self.client.events()
        self.assertEqual(self.store.data['cursor'],'cursor')
        self.client.events()
        self.assertEqual(self.store.data['cursor'],'next-cursor')
        self.assertEqual(len(self.store.data['events']),1)

    def test_S06_L06_restart_keeps_cursor_not_lease(self):
        self.acquire();page=self.event_page([self.event()]);self.fake.handlers['/events?after=cursor&limit=200']=lambda _:page
        self.client.events();self.store.close();self.store=Store(self.path)
        resumed=Client(self.fake,self.store,EXPECTED,True)
        self.assertEqual(self.store.data['cursor'],'next-cursor')
        self.assertFalse(resumed.writable())
        self.assertEqual(len(self.store.data['events']),1)

    def test_S07_gap_does_not_advance(self):
        self.fake.handlers['/events?after=cursor&limit=200']=lambda _:self.event_page([self.event(seq='9007199254740995')])
        with self.assertRaises(ProtocolError):self.client.events()
        self.assertEqual(self.store.data['cursor'],'cursor')

    def test_S11_required_unknown_stops_and_redaction_replaces(self):
        self.acquire();self.fake.handlers['/events?after=cursor&limit=200']=lambda _:self.event_page([self.event('future.required')])
        with self.assertRaises(ProtocolError):self.client.events()
        self.assertFalse(self.client.writable())
        self.pages(snapshot_pages(document({'secretPreviouslyVisible':3})));self.client.snapshot()
        self.pages(snapshot_pages());self.client.snapshot()
        self.assertNotIn('secretPreviouslyVisible',self.store.data['snapshot']['observation']['view'])

    def test_optional_unknown_is_covered_without_interpreting(self):
        self.fake.handlers['/events?after=cursor&limit=200']=lambda _:self.event_page([self.event('future.optional',required=False)])
        self.client.events();self.assertEqual(self.store.data['cursor'],'next-cursor')

    def test_C04_outbox_before_transport_and_lost_response_lookup(self):
        key=self.intent()
        def lost(body):
            row=self.store.db.execute('SELECT document FROM state').fetchone()[0]
            durable=strict_json(row,32*8388608)['outbox'][key]
            self.assertEqual(durable['request'],body)
            self.assertTrue(durable['sent'])
            raise ProtocolError('lost response')
        self.fake.handlers['/commands']=lost
        with self.assertRaises(ProtocolError):self.client.submit(key)
        self.assertEqual(self.store.data['outbox'][key]['outcome'],'unknown')
        self.lookup(key,'found',self.receipt(key));self.client.reconcile(key)
        self.assertEqual(self.store.data['outbox'][key]['outcome'],'applied')
        self.assertEqual(sum(p=='/commands' for _,p,_ in self.fake.calls),1)

    def test_C06_unavailable_history_preserves_unknown_and_blocks_new_key(self):
        key=self.intent();self.lookup(key);self.client.reconcile(key,retry_absent=True)
        self.assertEqual(self.store.data['outbox'][key]['outcome'],'unknown')
        with self.assertRaises(ProtocolError):self.client.prepare('order',{'action':{'kind':'check-in'}})
        self.assertEqual(len(self.store.data['outbox']),1)

    def test_C05_absent_retry_preserves_every_original_field(self):
        key=self.intent();original=copy.deepcopy(self.store.data['outbox'][key]['request'])
        self.lookup(key,'absent_within_retained_scope')
        self.fake.handlers['/commands']=lambda body:self.receipt(key)
        self.client.reconcile(key,retry_absent=True)
        self.assertEqual(self.fake.calls[-1][2],original)
        self.assertEqual(len(self.store.data['outbox']),1)

    def test_C05_paused_absence_never_retires_unknown(self):
        key=self.intent();original=canonical(self.store.data['outbox'][key]['request'])
        self.client.pause();self.lookup(key,'absent_within_retained_scope')
        self.assertEqual(self.client.reconcile(key)['status'],'absent_within_retained_scope')
        with self.assertRaises(ProtocolError):self.client.reconcile(key,retry_absent=True)
        self.assertEqual(self.store.data['outbox'][key]['outcome'],'unknown')
        self.assertEqual(canonical(self.store.data['outbox'][key]['request']),original)
        self.assertFalse(any(path=='/commands' for _,path,_ in self.fake.calls))
        self.acquire()
        with self.assertRaises(ProtocolError):self.client.prepare('order',{'action':{'kind':'check-in'}})

    def test_C06_authentication_or_lease_loss_never_erases_unknown(self):
        key=self.intent();original=canonical(self.store.data['outbox'][key])
        for code,category in [('UNAUTHORIZED','authorization'),('SCOPE_DENIED','authorization'),('LEASE_LOST','ownership'),('FENCE_STALE','ownership')]:
            with self.subTest(code=code):
                self.acquire()
                def denied(_):raise RemoteError(403,{'code':code,'category':category,'outcome':'rejected'})
                self.fake.handlers['/commands/lookup']=denied
                with self.assertRaises(RemoteError):self.client.reconcile(key,retry_absent=True)
                self.assertFalse(self.client.writable())
                self.assertEqual(canonical(self.store.data['outbox'][key]),original)
        self.assertFalse(any(path=='/commands' for _,path,_ in self.fake.calls))

    def test_C05_expired_local_lease_does_not_prove_absence_final(self):
        key=self.intent();self.client.clock=lambda:1000.0
        self.lookup(key,'absent_within_retained_scope')
        with self.assertRaises(ProtocolError):self.client.reconcile(key,retry_absent=True)
        self.assertFalse(self.client.writable())
        self.assertEqual(self.store.data['outbox'][key]['outcome'],'unknown')
        self.assertFalse(any(path=='/commands' for _,path,_ in self.fake.calls))

    def test_C09_receipt_monotonic_and_same_version_conflict(self):
        key=self.intent();data=copy.deepcopy(self.store.data)
        self.client._receipt(data,self.receipt(key,'applied','3'))
        self.client._receipt(data,self.receipt(key,'accepted','1'))
        self.assertEqual(data['outbox'][key]['receipt']['state'],'applied')
        with self.assertRaises(ProtocolError):self.client._receipt(data,self.receipt(key,'accepted','3'))

    def test_E04_C10_epoch_change_blocks_old_intent(self):
        key=self.intent();newscope={**SCOPE,'roomEpoch':'new-epoch'}
        self.fake.handlers['/sessions/hello']=lambda _:hello(newscope);self.client.hello()
        self.assertEqual(self.store.data['outbox'][key]['request']['roomEpoch'],'epoch')
        self.assertEqual(self.store.data['outbox'][key]['blocked'],'epoch-or-identity-changed')
        with self.assertRaises(ProtocolError):self.client.submit(key)
        self.pages(snapshot_pages())
        with self.assertRaises(ProtocolError):self.client.snapshot()
        self.assertIsNone(self.store.data['snapshot'])

    def test_L04_late_renew_does_not_revive(self):
        lease=self.acquire()
        def late(_):
            self.client.pause()
            return {'current':lease,'operationResult':lease}
        self.fake.handlers['/control/renew']=late
        with self.assertRaises(ProtocolError):self.client.control('renew')
        self.assertFalse(self.client.writable())

    def test_L05_lease_uses_remaining_ttl_and_roundtrip_not_wallclock(self):
        times=iter([10.0,11.0]);self.client.clock=lambda:next(times)
        lease={'scope':SCOPE,'generation':'1','sessionId':'session','mode':'agent','ttlMs':120000,'remainingTtlMs':5000}
        self.fake.handlers['/control/acquire']=lambda _:{'operationResult':lease,'current':lease}
        self.client.control('acquire')
        self.assertEqual(self.client.deadline,15.0)

    def test_S09_cursor_expiry_retains_pending(self):
        key=self.intent()
        def expired(_):raise RemoteError(409,{'code':'RESYNC_REQUIRED','category':'resync'})
        self.fake.handlers['/events?after=cursor&limit=200']=expired
        with self.assertRaises(RemoteError):self.client.events()
        self.assertEqual(self.store.data['outbox'][key]['outcome'],'unknown')
        self.lookup(key,'found',self.receipt(key));self.client.reconcile(key)
        self.client.snapshot();self.assertEqual(self.store.data['outbox'][key]['outcome'],'applied')

    def test_control_invalidation_reads_current_without_reviving_or_extending(self):
        lease=self.acquire()
        self.fake.handlers['/control?sessionId=session']=lambda _:{**lease,'remainingTtlMs':30000}
        self.fake.handlers['/events?after=cursor&limit=200']=lambda _:self.event_page([self.event('control.changed')])
        self.client.events()
        self.assertTrue(self.client.writable())
        self.assertEqual(self.client.deadline,20.0)
        self.fake.handlers['/control?sessionId=session']=lambda _:{**lease,'generation':'9007199254740994'}
        self.client._revalidate_control()
        self.assertFalse(self.client.writable())

    def test_default_read_only_and_local_single_writer(self):
        c=Client(self.fake,self.store,EXPECTED)
        c.hello()
        with self.assertRaises(ProtocolError):c.control('acquire')
        with self.assertRaises(ProtocolError):Store(self.path)


if __name__=='__main__':unittest.main()
