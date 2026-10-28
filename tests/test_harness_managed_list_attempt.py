"""Actual isolated Host list projection for adapter reload; no external execution."""
from contextlib import closing
from pathlib import Path
import json,sys,unittest,uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_managed as managed_fixtures


def offer(fixture):
    page,binding=fixture.enroll(account='A')
    request=fixture.f.command(binding['thread_id'],'message.send',{'text':'Complete the isolated approved module.'})
    offered=fixture.wire(page,'pulse')
    assert offered['state']=='offer'
    return page,request['request_id'],offered['attempt_id']


def paired_list(fixture):
    camp,camp_request,camp_attempt=offer(fixture)
    fixture.wire(camp,'dispatch',attempt_id=camp_attempt)
    fixture.wire(camp,'sent',attempt_id=camp_attempt,
        page={**managed_fixtures.PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
              'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
    math,math_request,math_attempt=offer(fixture)
    fixture.m.browser('pause',{'page_id':math,'paused':True})
    # Reproduce the retained historical suspended offer only in this temp store.
    with closing(fixture.h.state.connect()) as db:
        db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?",(math_request,))
        db.commit()
    return {'state':fixture.m.browser('list',{}),'camp':camp,'math':math,
            'camp_request':camp_request,'camp_attempt':camp_attempt,
            'math_request':math_request,'math_attempt':math_attempt}


class ManagedListAttemptTests(unittest.TestCase):
    def setUp(self):
        self.fixture=managed_fixtures.ManagedTests()
        self.fixture.setUp()

    def tearDown(self):self.fixture.tearDown()

    def row(self,page):
        return next(row for row in self.fixture.m.browser('list',{})['pages'] if row['page_id']==page)

    def attempts_and_receipts(self):
        with closing(self.fixture.h.state.connect()) as db:
            return {table:[dict(row) for row in db.execute('SELECT * FROM '+table+' ORDER BY attempt_id' if table=='control_browser_receipts'
                    else 'SELECT * FROM '+table+' ORDER BY id')]
                    for table in ('control_attempts','control_browser_receipts')}

    def test_list_has_null_attempt_for_reserved_and_bound_pages_without_attempt(self):
        reserved,_=self.fixture.reserve(account='A')
        bound,_=self.fixture.enroll(account='A')
        for page in (reserved,bound):
            with self.subTest(page=page):
                row=self.row(page)
                self.assertIsNone(row['latest_request'])
                self.assertIsNone(row['attempt'])

    def test_list_preserves_exact_offer_dispatch_and_acknowledgment_timestamps(self):
        page,request,attempt=offer(self.fixture)
        row=self.row(page)
        self.assertEqual(row['attempt'],{'id':attempt,'state':'offered','dispatched':None,'acknowledged':None})
        self.assertEqual(row['latest_request']['id'],request)
        self.assertEqual(row['latest_request']['attempt_id'],attempt)
        self.assertIsNone(row['latest_request']['sent_user_hash'])
        self.fixture.wire(page,'dispatch',attempt_id=attempt)
        row=self.row(page)
        self.assertEqual(row['attempt']['state'],'dispatching')
        self.assertIsInstance(row['attempt']['dispatched'],(int,float))
        self.assertIsNone(row['attempt']['acknowledged'])
        self.fixture.wire(page,'sent',attempt_id=attempt,
            page={**managed_fixtures.PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
                  'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        row=self.row(page)
        self.assertEqual(row['attempt']['state'],'acknowledged')
        self.assertIsInstance(row['attempt']['acknowledged'],(int,float))
        self.assertEqual(row['latest_request']['sent_user_hash'],'b'*64)
        self.assertEqual(set(row['attempt']),{'id','state','dispatched','acknowledged'})

    def test_list_projects_the_exact_latest_request_attempt_when_offered_times_tie(self):
        page,request,attempt=offer(self.fixture)
        with closing(self.fixture.h.state.connect()) as db:
            duplicate=dict(db.execute('SELECT * FROM control_attempts WHERE id=?',(attempt,)).fetchone())
            duplicate.update(id='control_'+uuid.uuid4().hex,epoch=duplicate['epoch']+1,state='unknown',dispatched=17.0)
            fields=list(duplicate)
            db.execute('INSERT INTO control_attempts ('+','.join(fields)+') VALUES ('+','.join('?' for _ in fields)+')',
                [duplicate[field] for field in fields])
            db.commit()
        row=self.row(page)
        with closing(self.fixture.h.state.connect()) as db:
            exact=dict(db.execute('SELECT id,state,dispatched,acknowledged FROM control_attempts WHERE id=? AND request_id=?',
                (row['latest_request']['attempt_id'],request)).fetchone())
        self.assertEqual(row['attempt'],exact)

    def test_repeated_list_reads_do_not_mutate_attempts_or_original_browser_receipts(self):
        paired=paired_list(self.fixture)
        before=self.attempts_and_receipts()
        for _ in range(3):
            rows={row['page_id']:row for row in self.fixture.m.browser('list',{})['pages']}
            self.assertEqual(rows[paired['camp']]['latest_request']['sent_user_hash'],'b'*64)
            math=rows[paired['math']]
            self.assertIs(math['paused'],True)
            self.assertEqual(math['latest_request']['phase'],'suspended')
            self.assertEqual(math['attempt'],{'id':paired['math_attempt'],'state':'offered','dispatched':None,'acknowledged':None})
        self.assertEqual(self.attempts_and_receipts(),before)


if __name__=='__main__':
    if sys.argv[1:]==['--emit-list-fixture']:
        fixture=managed_fixtures.ManagedTests()
        fixture.setUp()
        try:print(json.dumps(paired_list(fixture)))
        finally:fixture.tearDown()
    else:unittest.main()
