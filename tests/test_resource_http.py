"""Real loopback HTTP metadata and durable tick tests, never production state."""
from pathlib import Path
import json,sys,time,threading,unittest,uuid
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from contextlib import closing
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from test_resources import ResourceCase
from task_domain import encoded
from serve_control_center import create_server

class ResourceHTTPTests(ResourceCase):
    def setUp(self):
        super().setUp();self.server=create_server(task_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_address[1]}'
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();super().tearDown()
    def get(self,path='resources',headers=None):
        with urlopen(Request(self.url+'/api/tasks/'+path,headers=headers or {}),timeout=8) as response:return json.load(response)
    def test_info_reports_capability_not_os_authority(self):
        info=self.get('info');self.assertTrue(info['resource_coordination']);self.assertEqual(info['read_schema_max'],4);self.assertFalse(info['model_dispatch'])
        result=self.get();self.assertEqual(result['store_id'],self.store.store_id);self.assertFalse(result['os_ownership_enforced'])
    def test_read_endpoint_does_not_accept_arbitrary_source_path(self):
        with self.assertRaises(HTTPError) as e:self.get('resources?path=C:/outside')
        self.assertEqual(e.exception.code,404)
    def test_cross_origin_cannot_read_catalog(self):
        with self.assertRaises(HTTPError) as e:self.get(headers={'Origin':'https://foreign.invalid'})
        self.assertEqual(e.exception.code,403)
    def test_post_requires_existing_intent_and_same_origin(self):
        raw={'request_id':str(uuid.uuid4()),'action':'resource.define','actor':'fixture','data':{}}
        with self.assertRaises(HTTPError) as e:
            urlopen(Request(self.url+'/api/tasks/command',data=json.dumps(raw).encode(),headers={'Content-Type':'application/json','Origin':self.url}),timeout=5)
        self.assertEqual(e.exception.code,403);self.assertEqual(self.store.resources()['resources'],[])
    def test_periodic_coordinator_advances_recorded_queue_without_browser(self):
        # Prevent the immediate hook, then let the server's actual periodic hook run.
        t=self.start();t,key=self.define(t);self.observe(t,key)
        import task_resources
        with patch.object(task_resources,'advance',return_value=0):self.request(t,'A',[key])
        self.assertEqual(self.group(t)['phase'],'queued')
        deadline=time.monotonic()+6
        while self.group(t)['phase']=='queued' and time.monotonic()<deadline:time.sleep(.1)
        self.assertEqual(self.group(t)['phase'],'reserved')
        self.assertFalse(self.get('info')['resource_coordinator']['model_called'])
    def test_observation_never_renews_source_timestamp(self):
        t=self.start();t,key=self.define(t);at=time.time()-10;self.observe(t,key,at=at,ttl=1)
        self.get();self.get();self.assertEqual(self.get()['resources'][0]['observation']['source_observed_at'],at)
        self.assertFalse(self.get()['resources'][0]['observation_current'])
    def test_unknown_job_held_after_store_reopen_and_http_read(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);self.begin(t);self.act(t,'unknown',reason='no reply')
        from task_store import TaskStore
        self.server.task_api.store=TaskStore(self.path)
        row=self.get()['resources'][0];self.assertEqual(row['occupied'],1);self.assertEqual(row['holders'][0]['phase'],'unknown')
    def test_coordinator_error_is_visible_without_releasing_resources(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);before=self.latest(t)
        with patch.object(self.store,'coordinate_resources',side_effect=RuntimeError('fixture')):
            self.server._resource_check_after=0;self.server.service_actions()
        self.assertEqual(self.get('info')['resource_coordinator']['status'],'unavailable')
        self.assertEqual(self.latest(t),before)

if __name__=='__main__':unittest.main(verbosity=2)
