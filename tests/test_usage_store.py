from pathlib import Path
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import hashlib,json,sqlite3,sys,tempfile,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from usage_store import UsageStore,entry,amount
from task_domain import TaskError

def sample(**kw):
    return {'bucket':'api','account_alias':'account-A','kind':'delta','unit':'USD','amount':'0.10','source':'operator_observation','reference':'provider-ref','window':'2026-09','observed_at':'2026-09-21T01:00:00Z','resets_at':None,'task_id':'','note':'invoice transcribed; not authenticated','status':'known'}|kw
class UsageTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'usage.sqlite3';self.store=UsageStore(self.path)
    def tearDown(self):self.temp.cleanup()
    def raw(self,data=None,**kw):return {'request_id':str(uuid.uuid4()),'action':'record','actor':'tester','data':sample() if data is None else data}|kw
    def record(self,data=None,**kw):return self.store.command(self.raw(data,**kw))['entry']
    def test_three_official_remaining_values_unknown(self):self.assertEqual(self.store.summary()['official_remaining'],{'chat':None,'work_codex':None,'api':None})
    def test_decimal_money_without_binary_float_error(self):
        for i in range(3):self.record(sample(reference=str(i)))
        self.assertEqual(Decimal(self.store.summary()['totals'][0]['known_subtotal']),Decimal('0.30'))
    def test_foreign_db_not_adopted(self):
        p=Path(self.temp.name)/'foreign.db'
        with closing(sqlite3.connect(p)) as db:db.execute('CREATE TABLE user (id INTEGER)')
        before=hashlib.sha256(p.read_bytes()).hexdigest()
        with self.assertRaises(TaskError):UsageStore(p)
        self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(),before)
    def test_store_identity_persists(self):self.assertEqual(self.store.store_id,UsageStore(self.path).store_id)
    def test_unknown_money_is_null_not_zero(self):
        self.record(sample(amount=None,status='unknown'));g=self.store.summary()['totals'][0];self.assertIsNone(g['total']);self.assertEqual(g['unknown_count'],1)
    def test_unknown_record_cannot_supply_zero(self):
        with self.assertRaises(TaskError):self.record(sample(status='unknown',amount='0'))
    def test_pool_currency_source_account_and_window_not_mixed(self):
        self.record()
        for i,change in enumerate([{'source':'estimate'},{'unit':'CNY'},{'account_alias':'B'},{'window':'2026-10'},{'bucket':'chat','unit':'messages','amount':'1'}]):self.record(sample(reference=str(i),**change))
        self.assertEqual(len(self.store.summary()['totals']),6)
    def test_estimate_not_confirmed_spending(self):
        self.record(sample(source='estimate'));self.assertEqual(self.store.summary()['totals'][0]['source'],'estimate');self.assertIsNone(self.store.summary()['official_remaining']['api'])
    def test_same_id_same_payload_only_one_record(self):
        r=self.raw();self.store.command(r);self.store.command(r);self.assertEqual(len(self.store.listing()['entries']),1)
    def test_same_id_different_payload_refused(self):
        r=self.raw();self.store.command(r);r['data']['amount']='10'
        with self.assertRaises(TaskError):self.store.command(r)
    def test_provider_reference_duplicate_refused(self):
        self.record()
        with self.assertRaises(TaskError):self.record()
    def test_concurrent_same_key_one_entry(self):
        r=self.raw()
        with ThreadPoolExecutor(3) as pool:list(pool.map(lambda _:self.store.command(r),range(3)))
        self.assertEqual(len(self.store.listing()['entries']),1)
    def test_unknown_corrected_same_identity_history_preserved(self):
        a=self.record(sample(amount=None,status='unknown'));b=self.record(sample(amount='0.20'),action='correct',entry_id=a['id'],expected_version=1)
        self.assertEqual(a['id'],b['id']);self.assertEqual(len(self.store.history(a['id'])['records']),2);self.assertEqual(self.store.summary()['totals'][0]['total'],'0.20')
    def test_stale_correction_does_not_overwrite(self):
        a=self.record();self.record(sample(amount='1'),action='correct',entry_id=a['id'],expected_version=1)
        with self.assertRaises(TaskError):self.record(sample(amount='2'),action='correct',entry_id=a['id'],expected_version=1)
    def test_correction_cannot_change_identity(self):
        a=self.record()
        for key,val in [('account_alias','B'),('unit','CNY'),('window','another'),('reference','new')]:
            with self.assertRaises(TaskError):self.record(sample(**{key:val}),action='correct',entry_id=a['id'],expected_version=1)
    def test_window_snapshots_latest_not_sum(self):
        base=sample(bucket='work_codex',kind='snapshot',unit='used_percent',amount='20');self.record(base)
        self.record(base|{'reference':'later','observed_at':'2026-09-21T02:00:00Z','amount':'30'});s=self.store.summary();self.assertEqual(s['totals'],[]);self.assertEqual(s['snapshots'][0]['amount'],'30')
    def test_older_late_arrival_does_not_replace_latest(self):
        base=sample(bucket='chat',kind='snapshot',unit='remaining_messages',amount='5');self.record(base)
        self.record(base|{'reference':'late','observed_at':'2026-09-20T01:00:00Z','amount':'15'});self.assertEqual(self.store.summary()['snapshots'][0]['amount'],'5')
    def test_snapshot_never_attributed_to_task(self):
        with self.assertRaises(TaskError):self.record(sample(bucket='chat',kind='snapshot',unit='used_percent',task_id='task-1'))
    def test_no_official_source_spoof(self):
        with self.assertRaises(TaskError):self.record(sample(source='official_api'))
        with self.assertRaises(TaskError):self.record(sample(source_verified=True))
    def test_invalid_amounts_and_units(self):
        for v in ['-1','NaN','Infinity','1e5',True,1.0,'0.123456789']:
            with self.subTest(v=v):
                with self.assertRaises(TaskError):self.record(sample(amount=v))
        with self.assertRaises(TaskError):self.record(sample(unit='tokens'))
    def test_percent_max_and_integral_counts(self):
        for unit,value in [('used_percent','101'),('remaining_messages','1.5')]:
            with self.assertRaises(TaskError):self.record(sample(bucket='chat',kind='snapshot',unit=unit,amount=value))
    def test_timestamp_requires_timezone(self):
        with self.assertRaises(TaskError):self.record(sample(observed_at='2026-09-21'))
    def test_actual_pagination(self):
        for i in range(3):self.record(sample(reference=str(i)))
        a=self.store.listing(limit=2);b=self.store.listing(a['next_after']);self.assertEqual(len(a['entries'])+len(b['entries']),3)
    def test_subsecond_snapshot_ordering_is_chronological(self):
        base=sample(bucket='chat',kind='snapshot',unit='used_percent',amount='1');self.record(base)
        self.record(base|{'reference':'subsecond','observed_at':'2026-09-21T01:00:00.100Z','amount':'2'})
        self.assertEqual(self.store.summary()['snapshots'][0]['amount'],'2')
    def test_expired_window_is_explicit(self):
        self.record(sample(bucket='chat',kind='snapshot',unit='used_percent',resets_at='2000-01-01T00:00:00Z'))
        self.assertTrue(self.store.summary()['snapshots'][0]['expired'])
    def test_secret_fields_refused(self):
        with self.assertRaises(TaskError):self.record(sample(api_key='never a task value'))
if __name__=='__main__':unittest.main(verbosity=2)
