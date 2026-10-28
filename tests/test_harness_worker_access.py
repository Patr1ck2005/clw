"""Authorized scope inheritance, with no browser, model or external writes."""
from pathlib import Path
import json, sys, tempfile, unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_team_scopes import plain_root,worker_access,validate_access

class WorkerAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='clw-worker-scope-')
        self.addCleanup(self.temp.cleanup)
        self.root=plain_root(self.temp.name)
    def parent(self,paths,access='write'):
        return {'root':self.root,'access':access,'write_paths':json.dumps(paths)}
    def test_same_root_and_nested_child_only_inherit_the_authorized_intersection(self):
        parent=self.parent(['src','tests'])
        self.assertEqual(worker_access(parent,self.root,{}),('write',['src','tests']))
        self.assertEqual(worker_access(parent,str(Path(self.root)/'src'),{}),('write',['.']))
        self.assertEqual(worker_access(parent,str(Path(self.root)/'docs'),{}),('read',[]))
        self.assertEqual(worker_access(self.parent(['src/feature']),str(Path(self.root)/'src'),{}),('write',['feature']))
    def test_full_parent_scope_is_not_global_access(self):
        parent=self.parent(['.'])
        self.assertEqual(worker_access(parent,str(Path(self.root)/'child'),{}),('write',['.']))
        self.assertEqual(worker_access(parent,self.root+'-neighbor',{}),('read',[]))
        self.assertEqual(worker_access(parent,str(Path(self.root).parent),{}),('read',[]))
    def test_explicit_read_or_partial_settings_do_not_silently_gain_write(self):
        parent=self.parent(['.'])
        self.assertEqual(worker_access(parent,self.root,{'access':'read'}),('read',[]))
        self.assertEqual(worker_access(self.parent([],access='read'),self.root,{}),('read',[]))
        self.assertEqual(worker_access(None,self.root,{}),('read',[]))
        for payload in ({'access':'write'},{'write_paths':['src']},{'access':'write','write_paths':['../outside']}):
            with self.subTest(payload=payload),self.assertRaises(ValueError):
                access,paths=worker_access(parent,self.root,payload)
                validate_access(access,paths,[])

if __name__=='__main__':unittest.main()
