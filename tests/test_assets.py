"""Asset workflow tests use local temporary stores and generated raster fixtures, never providers."""
from pathlib import Path
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from decimal import Decimal
import hashlib,json,sqlite3,sys,tempfile,unittest,uuid,zipfile
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from PIL import Image,PngImagePlugin
from asset_store import AssetStore
from asset_images import decode
from asset_domain import contract, MAX_UPLOAD
from task_domain import TaskError,fingerprint
from task_store import TaskStore
from test_task_store import example

def sample(api=False,keys=('icon',)):
    return {'title':'测试素材批次','project_id':'agent:test:project','project_root':'D:/sandbox/project','task_id':'','style_brief':'简洁、可读；不是生成请求','executor':'external_api' if api else 'manual','provider':'fixture-only','model':'no-model','account_alias':'test-local','billing_bucket':'api' if api else 'none','budget':{'currency':'USD','max_total':'1.00','per_attempt':'0.25'} if api else None,'items':[{'key':k,'prompt':'测试候选 '+k,'width':64,'height':64,'format':'png','transparency':'required','references':[]} for k in keys]}

def raster(w=64,h=64,fmt='PNG',transparent=True,metadata=False):
    image=Image.new('RGBA' if fmt!='JPEG' else 'RGB',(w,h),(20,90,130,90) if fmt!='JPEG' else (20,90,130))
    if not transparent:image=Image.new('RGB',(w,h),(30,90,170))
    options={}
    if metadata:
        info=PngImagePlugin.PngInfo();info.add_text('private','fixture-private-metadata');options['pnginfo']=info
    b=BytesIO();image.save(b,format=fmt,**options);return b.getvalue()

class AssetTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.s=AssetStore(self.root/'assets.sqlite3')
    def tearDown(self):self.tmp.cleanup()
    def cmd(self,action,b=None,data=None,rid=None):
        raw={'action':action,'data':data or {},'actor':'test','request_id':rid or str(uuid.uuid4())}
        if b:raw.update(batch_id=b['id'],expected_version=b['version'])
        return self.s.command(raw)['batch']
    def new(self,api=False,keys=('icon',)):return self.cmd('create',data={'contract':sample(api,keys)})
    def ready(self,api=False,keys=('icon',)):
        b=self.cmd('publish',self.new(api,keys),{'confirmed':True});return self.cmd('reserve',b,{'asset_keys':list(keys)})
    def outcome(self,b,index=0,state='completed',status=None,amount=None,ref='original-ref'):
        status=status or ('unknown' if b['contract']['budget'] else 'not_applicable')
        return self.cmd('outcome',b,{'attempt_id':b['attempts'][index]['id'],'state':state,'external_ref':ref,'evidence':'explicit external test receipt','charge':{'status':status,'amount':amount},'confirmed':True})
    def raw_upload(self,b,data,index=0):return {'request_id':str(uuid.uuid4()),'actor':'test','batch_id':b['id'],'expected_version':b['version'],'attempt_id':b['attempts'][index]['id'],'spec_hash':b['spec_hash'],'source_sha256':hashlib.sha256(data).hexdigest(),'name':'fixture.png'}
    def upload(self,b,data=None,index=0):
        data=data if data is not None else raster();return self.s.upload(self.raw_upload(b,data,index),data)['batch']
    def review(self,b,outcome='approved',cid=None):return self.cmd('review',b,{'candidate_id':cid or b['candidates'][-1]['id'],'outcome':outcome,'note':'已实际核对视觉与使用许可（测试夹具）','confirmed':True})
    def assert_code(self,code,fn):
        with self.assertRaises(TaskError) as c:fn()
        self.assertEqual(c.exception.code,code)
    def test_complete_lifecycle_exports_real_bytes(self):
        b=self.review(self.upload(self.outcome(self.ready())))
        self.assertTrue(b['delivery_ready']);data=self.s.delivery(b['id'])
        with zipfile.ZipFile(BytesIO(data)) as z:
            m=json.loads(z.read('manifest.json'));image=z.read('candidates/icon.png')
            self.assertEqual(hashlib.sha256(image).hexdigest(),m['selected_candidates'][0]['sha256']);self.assertEqual(m['spec_hash'],b['spec_hash']);self.assertIn('not_performed',m['integration'])
    def test_draft_update_and_published_immutable(self):
        b=self.new();c=deepcopy(b['contract']);c['title']='修订';b=self.cmd('update',b,{'contract':c});b=self.cmd('publish',b,{'confirmed':True})
        self.assertEqual(b['spec_hash'],fingerprint(c));self.assert_code('frozen',lambda:self.cmd('update',b,{'contract':sample()}))
    def test_clone_clears_reviews_and_preserves_original(self):
        b=self.review(self.upload(self.outcome(self.ready())));n=self.cmd('clone',b,{'title':'独立修订'})
        self.assertEqual(n['supersedes'],b['id']);self.assertEqual(n['attempts'],[]);self.assertEqual(n['selected'],{});self.assertTrue(self.s.get(b['id'])['delivery_ready'])
    def test_clone_forbidden_with_unknown(self):
        b=self.outcome(self.ready(),state='outcome_unknown');self.assert_code('unresolved',lambda:self.cmd('clone',b,{'title':'no replay'}))
    def test_publish_does_not_create_attempt(self):
        b=self.cmd('publish',self.new(),{'confirmed':True});self.assertEqual(b['attempts'],[]);self.assertFalse(b['delivery_ready'])
    def test_handoff_is_not_dispatch_and_includes_hashes(self):
        b=self.ready();h=self.s.export_handoff(b['id'])['content'];self.assertFalse(h['provider_idempotency_guaranteed']);self.assertEqual(h['items'][0]['active_attempt']['state'],'reserved');self.assertEqual(len(h['items'][0]['input_hash']),64)
        self.assertIn(b['attempts'][0]['id'],self.s.export_handoff(b['id'],'markdown')['content']);self.assertEqual(self.s.get(b['id'])['version'],b['version'])
    def test_provider_budget_pair_and_strict_money(self):
        for value in ['NaN','-1','1e2','0.000000001',1,True]:
            c=sample(True);c['budget']['max_total']=value
            self.assert_code('money',lambda:contract(c))
        c=sample();c['billing_bucket']='api';self.assert_code('billing',lambda:contract(c))
    def test_total_and_per_attempt_positive(self):
        c=sample(True);c['budget']['per_attempt']='2';self.assert_code('budget',lambda:contract(c))
    def test_duplicate_and_unsafe_item_keys(self):
        for value in ['../bad','a/b','C:foo','Upper','a b','con','nul','com1','lpt9']:
            c=sample();c['items'][0]['key']=value;self.assert_code('key',lambda:contract(c))
        self.assert_code('key',lambda:contract(sample(keys=('same','same'))))
    def test_dimensions_and_transparency_contract(self):
        for value in [True,0,4097,3.2]:
            c=sample();c['items'][0]['width']=value;self.assert_code('dimensions',lambda:contract(c))
        c=sample();c['items'][0]['format']='jpg';self.assert_code('image_spec',lambda:contract(c))
    def test_secret_fields_and_secret_text_rejected(self):
        c=sample();c['api_key']='not-accepted';self.assert_code('invalid',lambda:contract(c))
        c=sample();c['items'][0]['prompt']='sk-'+('x'*24);self.assert_code('secret',lambda:contract(c))
    def test_reference_hash_is_declaration(self):
        c=sample();c['items'][0]['references']=[{'name':'source.png','sha256':'a'*64}];b=self.cmd('publish',self.cmd('create',data={'contract':c}),{'confirmed':True})
        self.assertIn('declared_hashes_only',self.s.export_handoff(b['id'])['content']['reference_files'])
    def test_budget_batch_reservation_is_atomic(self):
        b=self.cmd('publish',self.new(True,('a','b','c','d','e')),{'confirmed':True})
        self.assert_code('budget',lambda:self.cmd('reserve',b,{'asset_keys':['a','b','c','d','e']}));self.assertEqual(self.s.get(b['id'])['attempts'],[])
        b=self.cmd('reserve',b,{'asset_keys':['a','b','c','d']});self.assertEqual(b['accounting']['available'],'0.00')
    def test_unknown_bill_blocks_new_reservation(self):
        b=self.outcome(self.ready(True,('a','b')),state='completed');self.assertEqual(b['accounting']['known_total'],'0');self.assertEqual(b['accounting']['unknown_count'],1)
        self.assert_code('unresolved',lambda:self.cmd('reserve',b,{'asset_keys':['a']}))
    def test_success_does_not_imply_zero_charge(self):
        b=self.outcome(self.ready(True));self.assertIsNone(b['attempts'][0]['charge']['amount']);self.assertEqual(b['phase'],'reconcile')
    def test_known_charge_reconciles_and_overspend_is_visible(self):
        b=self.outcome(self.ready(True),status='known',amount='1.20');self.assertTrue(b['accounting']['over_budget']);self.assertEqual(b['accounting']['known_total'],'1.20');self.assert_code('budget',lambda:self.cmd('reserve',b,{'asset_keys':['icon']}))
    def test_known_bill_allows_delivery_after_review(self):
        b=self.outcome(self.ready(True));b=self.review(self.upload(b));self.assertFalse(b['delivery_ready']);b=self.outcome(b,status='known',amount='0.20');self.assertTrue(b['delivery_ready'])
    def test_not_sent_releases_budget_without_deleting_attempt(self):
        b=self.outcome(self.ready(True),state='not_sent',status='not_charged',ref='');self.assertEqual(b['accounting']['available'],'1.00');b=self.cmd('reserve',b,{'asset_keys':['icon']});self.assertEqual(len(b['attempts']),2)
    def test_failed_does_not_assume_free_retry(self):
        b=self.outcome(self.ready(True),state='failed');self.assert_code('unresolved',lambda:self.cmd('reserve',b,{'asset_keys':['icon']}));b=self.outcome(b,state='failed',status='not_charged');b=self.cmd('reserve',b,{'asset_keys':['icon']});self.assertEqual(len(b['attempts']),2)
    def test_unknown_original_outcome_reconciled_no_new_attempt(self):
        b=self.outcome(self.ready(),state='outcome_unknown');aid=b['attempts'][0]['id'];b=self.outcome(b);self.assertEqual(b['attempts'][0]['id'],aid);self.assertEqual(len(b['attempts']),1)
    def test_original_external_ref_cannot_change(self):
        b=self.outcome(self.ready(),state='outcome_unknown');self.assert_code('identity',lambda:self.outcome(b,ref='different-call'))
    def test_duplicate_active_and_approved_never_re_reserved(self):
        b=self.ready();self.assert_code('active',lambda:self.cmd('reserve',b,{'asset_keys':['icon']}));b=self.review(self.upload(self.outcome(b)));self.assert_code('active',lambda:self.cmd('reserve',b,{'asset_keys':['icon']}))
    def test_rework_clears_selection_and_allows_new_explicit_attempt(self):
        b=self.review(self.upload(self.outcome(self.ready())));b=self.review(b,'changes_requested');self.assertFalse(b['delivery_ready']);b=self.cmd('reserve',b,{'asset_keys':['icon']});self.assertEqual(len(b['attempts']),2)
    def test_completed_cannot_be_restarted(self):
        b=self.outcome(self.ready());self.assert_code('state',lambda:self.outcome(b,state='in_progress'))
    def test_upload_requires_completed_and_exact_contract(self):
        b=self.ready();self.assert_code('attempt',lambda:self.upload(b));b=self.outcome(b);data=raster();raw=self.raw_upload(b,data);raw['spec_hash']='f'*64;self.assert_code('frozen',lambda:self.s.upload(raw,data))
    def test_upload_byte_hash_is_checked(self):
        b=self.outcome(self.ready());raw=self.raw_upload(b,raster());self.assert_code('upload_hash',lambda:self.s.upload(raw,raster(63)))
    def test_invalid_bytes_not_saved(self):
        b=self.outcome(self.ready());self.assert_code('invalid_image',lambda:self.upload(b,b'<svg onload=alert(1)></svg>'));self.assertEqual(self.s.get(b['id'])['candidates'],[])
    def test_mismatched_image_saved_but_not_approvable(self):
        b=self.upload(self.outcome(self.ready()),raster(32));self.assertEqual(b['candidates'][0]['validation']['status'],'failed');self.assert_code('validation',lambda:self.review(b))
    def test_missing_transparency_rejected_for_approval(self):
        b=self.upload(self.outcome(self.ready()),raster(transparent=False));self.assert_code('validation',lambda:self.review(b))
    def test_png_metadata_removed_hashes_separate(self):
        data=raster(metadata=True);b=self.upload(self.outcome(self.ready()),data);c=b['candidates'][0];image,mime=self.s.image(b['id'],c['id']);self.assertEqual(c['source_sha256'],hashlib.sha256(data).hexdigest());self.assertNotIn(b'fixture-private-metadata',image);self.assertEqual(mime,'image/png');self.assertNotEqual(c['sha256'],c['source_sha256'])
    def test_actual_jpeg_and_webp_decode(self):
        for fmt in ['JPEG','WEBP']:
            meta,data=decode(raster(fmt=fmt));self.assertIn(meta['format'],('jpg','webp'));self.assertEqual(meta['width'],64)
    def test_animated_and_oversize_images_refused(self):
        b=BytesIO();images=[Image.new('RGBA',(32,32),(n,2,3,200)) for n in (0,100)];images[0].save(b,format='PNG',save_all=True,append_images=images[1:],duration=100,loop=0)
        self.assert_code('animation',lambda:decode(b.getvalue()));self.assert_code('image_format',lambda:decode(raster(4097,1)));self.assert_code('image_size',lambda:decode(b'a'*(MAX_UPLOAD+1)))
    def test_truncated_image_rejected(self):self.assert_code('invalid_image',lambda:decode(raster()[:50]))
    def test_blob_capacity_rolls_back_metadata_and_receipt(self):
        b=self.outcome(self.ready());data=raster();raw=self.raw_upload(b,data)
        with patch('asset_store.MAX_BLOBS',1):self.assert_code('capacity',lambda:self.s.upload(raw,data))
        self.assertFalse(self.s.receipt(raw['request_id'])['found']);self.assertEqual(self.s.get(b['id'])['candidates'],[])
    def test_wrong_batch_cannot_read_candidate(self):
        b=self.upload(self.outcome(self.ready()));n=self.new();self.assert_code('not_found',lambda:self.s.image(n['id'],b['candidates'][0]['id']))
    def test_blob_corruption_blocks_approval_and_download(self):
        b=self.upload(self.outcome(self.ready()));c=b['candidates'][0]
        with closing(self.s.connect()) as db:db.execute('UPDATE blobs SET data=? WHERE sha256=?',(b'corrupt',c['sha256']))
        self.assert_code('integrity',lambda:self.review(b));self.assert_code('integrity',lambda:self.s.image(b['id'],c['id']))
    def test_only_one_selected_candidate_per_item(self):
        b=self.upload(self.outcome(self.ready()));first=b['candidates'][0]['id'];b=self.review(b);b=self.upload(b,raster(metadata=True));b=self.review(b);self.assertNotEqual(b['selected']['icon'],first);self.assertEqual(b['candidates'][0]['review']['outcome'],'superseded')
    def test_upload_receipt_survives_restart_no_duplicate(self):
        b=self.outcome(self.ready());data=raster();raw=self.raw_upload(b,data);r=self.s.upload(raw,data);self.s=AssetStore(self.s.path);r2=self.s.upload(raw,data);self.assertTrue(r2['replayed']);self.assertEqual(r['candidate_id'],r2['candidate_id']);self.assertEqual(len(self.s.get(b['id'])['candidates']),1)
    def test_repeat_file_new_request_refused(self):
        b=self.upload(self.outcome(self.ready()));self.assert_code('duplicate',lambda:self.upload(b))
    def test_upload_same_id_different_bytes_refused(self):
        b=self.outcome(self.ready());data=raster();raw=self.raw_upload(b,data);self.s.upload(raw,data);other=raster(32);raw['source_sha256']=hashlib.sha256(other).hexdigest();self.assert_code('request_conflict',lambda:self.s.upload(raw,other))
    def test_same_command_and_concurrent_id_returns_original(self):
        rid=str(uuid.uuid4())
        with ThreadPoolExecutor(4) as p:bs=list(p.map(lambda _:self.cmd('create',data={'contract':sample()},rid=rid),range(4)))
        self.assertEqual(len({b['id'] for b in bs}),1);self.assertEqual(len(self.s.listing()['batches']),1)
    def test_stale_version_keeps_original(self):
        b=self.new();n=self.cmd('publish',b,{'confirmed':True});self.assert_code('version_conflict',lambda:self.cmd('update',b,{'contract':sample()}));self.assertEqual(self.s.get(b['id'])['version'],n['version'])
    def test_concurrent_reserve_only_one_winner(self):
        b=self.cmd('publish',self.new(),{'confirmed':True})
        def claim(_):
            try:self.cmd('reserve',b,{'asset_keys':['icon']});return True
            except TaskError:return False
        with ThreadPoolExecutor(4) as p:self.assertEqual(sum(p.map(claim,range(4))),1)
    def test_foreign_db_not_modified(self):
        path=self.root/'other.sqlite3'
        with closing(sqlite3.connect(path)) as db:db.execute('CREATE TABLE unrelated(value TEXT)');db.commit()
        before=path.read_bytes();self.assert_code('foreign_store',lambda:AssetStore(path));self.assertEqual(path.read_bytes(),before)
    def test_receipt_preserved_after_later_version(self):
        rid=str(uuid.uuid4());b=self.cmd('create',data={'contract':sample()},rid=rid);self.cmd('publish',b,{'confirmed':True});old=self.cmd('create',data={'contract':sample()},rid=rid);self.assertEqual(old,b)
    def test_history_and_listing_page_bounds(self):
        for i in range(3):self.new()
        p=self.s.listing(limit=2);self.assertEqual(len(p['batches']),2);self.assertEqual(len(self.s.listing(after=p['next_after'])['batches']),1)
        b=self.ready();events=self.s.events(b['id'])['events'];self.assertEqual([e['action'] for e in events],['create','publish','reserve'])
    def test_parent_revision_requires_explicit_reconfirmation(self):
        tasks=TaskStore(self.root/'tasks.sqlite3');t=tasks.command({'request_id':str(uuid.uuid4()),'actor':'test','action':'create','data':{'contract':example()}})['task'];self.s=AssetStore(self.s.path,tasks)
        c=sample();c['task_id']=t['id'];b=self.cmd('publish',self.cmd('create',data={'contract':c}),{'confirmed':True})
        tasks.command({'request_id':str(uuid.uuid4()),'actor':'test','action':'publish','data':{},'task_id':t['id'],'expected_version':t['version']})
        self.assert_code('parent_changed',lambda:self.s.export_handoff(b['id']));b=self.cmd('confirm_parent',b,{'note':'核对父任务版本变化没有改变素材要求','confirmed':True});self.assertEqual(self.s.get(b['id'])['parent_state'],'current')
    def test_unknown_action_cannot_launch(self):self.assert_code('action',lambda:self.cmd('dispatch',self.new(),{}))

    def test_active_known_charge_keeps_unspent_reservation(self):
        b=self.outcome(self.ready(True),state='in_progress',status='known',amount='0.10')
        self.assertEqual(Decimal(b['accounting']['held_total']),Decimal('0.15'))
        self.assertEqual(Decimal(b['accounting']['available']),Decimal('0.75'))
    def test_parent_project_id_alone_cannot_link_an_unrelated_root(self):
        tasks=TaskStore(self.root/'tasks.sqlite3');t=tasks.command({'request_id':str(uuid.uuid4()),'actor':'test','action':'create','data':{'contract':example()}})['task'];self.s=AssetStore(self.s.path,tasks)
        c=sample();c['task_id']=t['id'];c['project_root']='D:/unrelated-project'
        self.assert_code('parent',lambda:self.cmd('create',data={'contract':c}))
    def test_frozen_contract_integrity_checked_at_delivery(self):
        b=self.review(self.upload(self.outcome(self.ready())))
        with closing(self.s.connect()) as db:
            raw=json.loads(db.execute('SELECT data FROM batches WHERE id=?',(b['id'],)).fetchone()[0]);raw['contract']['items'][0]['prompt']='changed after approval';db.execute('UPDATE batches SET data=? WHERE id=?',(json.dumps(raw),b['id']))
        self.assert_code('integrity',lambda:self.s.delivery(b['id']))
    def test_markdown_contains_actual_budget_limits(self):
        b=self.ready(True);text=self.s.export_handoff(b['id'],'markdown')['content'];self.assertIn('1.00',text);self.assertIn('0.25',text);self.assertIn('USD',text)
    def test_external_receipt_cannot_be_double_counted(self):
        b=self.ready(True,('a','b'));b=self.outcome(b,0,status='known',amount='0.10',ref='same-paid-receipt')
        self.assert_code('duplicate_reference',lambda:self.outcome(b,1,status='known',amount='0.10',ref='same-paid-receipt'))

    def test_exif_orientation_is_applied_before_dimensions_and_validation(self):
        image=Image.new('RGB',(32,64),(20,90,130));exif=Image.Exif();exif[274]=6
        raw=BytesIO();image.save(raw,format='JPEG',exif=exif)
        meta,data=decode(raw.getvalue())
        self.assertEqual((meta['width'],meta['height']),(64,32))
        with Image.open(BytesIO(data)) as clean:self.assertNotIn(274,clean.getexif());self.assertEqual(clean.size,(64,32))
        from asset_images import validate
        self.assertEqual(validate(meta,{'width':64,'height':32,'format':'jpg','transparency':'opaque'})['status'],'passed')
    def test_exif_all_eight_pixel_orientations_and_repeat_normalization(self):
        methods={2:Image.Transpose.FLIP_LEFT_RIGHT,3:Image.Transpose.ROTATE_180,4:Image.Transpose.FLIP_TOP_BOTTOM,5:Image.Transpose.TRANSPOSE,6:Image.Transpose.ROTATE_270,7:Image.Transpose.TRANSVERSE,8:Image.Transpose.ROTATE_90}
        source=Image.new('RGBA',(32,64),(20,90,130,200));source.putpixel((0,0),(255,0,0,255));source.putpixel((31,63),(0,255,0,80))
        for orientation in range(1,9):
            with self.subTest(orientation=orientation):
                exif=Image.Exif();exif[274]=orientation;raw=BytesIO();source.save(raw,format='PNG',exif=exif)
                meta,data=decode(raw.getvalue());expected=source.transpose(methods[orientation]) if orientation in methods else source
                self.assertEqual((meta['width'],meta['height']),expected.size)
                with Image.open(BytesIO(data)) as clean:self.assertEqual(clean.convert('RGBA').tobytes(),expected.tobytes());self.assertFalse(clean.getexif())
                repeated,repeated_bytes=decode(data);self.assertEqual(data,repeated_bytes);self.assertEqual(meta['sha256'],repeated['sha256'])

if __name__=='__main__':unittest.main(verbosity=2)
