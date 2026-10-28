"""Native buffer/census countercases; no model, service change or owner stop."""
from pathlib import Path
from unittest.mock import patch
import ctypes,os,socket,struct,sys,unittest,subprocess,shutil
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import windows_process_owner as owners
from web_host_supervisor_owner import command_argv

def command_buffer(text):
    encoded=text.encode('utf-16-le');prefix=ctypes.sizeof(owners._UnicodeString)
    buffer=ctypes.create_string_buffer(prefix+len(encoded)+2);value=owners._UnicodeString.from_buffer(buffer)
    value.length=len(encoded);value.maximum=len(encoded)+2;value.buffer=ctypes.addressof(buffer)+prefix
    ctypes.memmove(value.buffer,encoded,len(encoded));return buffer
class Api:
    def __init__(self):
        self.rows={7:{'name':'python.exe','parent':1},91:{'name':'other.exe','parent':1}};self.calls=0;self.closed=[];self.changed=False;self.dead=False;self.denied=False
    def snapshot(self):
        self.calls+=1;rows={pid:dict(value) for pid,value in self.rows.items()}
        if self.changed and self.calls==2:rows[7]['parent']=2
        return rows
    def open(self,pid):
        if self.denied:raise owners.OwnershipUnavailable()
        return pid
    def close(self,handle):self.closed.append(handle)
    def marker(self,handle):
        if self.dead and self.calls==2:raise owners.OwnershipUnavailable()
        return 1234
    def image(self,handle):return r'C:\Python\python.exe'
    def command_line(self,handle):return r'C:\Python\python.exe D:\chosen\versions\original\scripts\serve.py'

class NativeBufferTests(unittest.TestCase):
    def test_retained_owner_probe_opens_only_saved_pids_and_never_reads_argv(self):
        api=Api();api.rows[88]={'name':'python.exe','parent':1};opened=[]
        def open_process(pid):
            opened.append(pid)
            if pid!=7:raise owners.OwnershipUnavailable()
            return pid
        api.open=open_process;api.command_line=lambda _:self.fail('retained owner argv read')
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.retained_process_identities({7,999})
        self.assertEqual(rows,{7:{'ProcessId':7,'ProcessName':'python.exe','ExecutablePath':r'C:\Python\python.exe','CreationFiletime':'1234'}})
        self.assertEqual(opened,[7]);self.assertEqual(api.calls,2);self.assertEqual(api.closed,[7])
    def test_retained_empty_or_absent_metadata_needs_only_pid_census(self):
        api=Api();api.open=lambda _:self.fail('unrelated handle opened')
        with patch.object(owners,'_NativeApi',return_value=api):self.assertEqual(owners.retained_process_identities({999}),{})
        self.assertEqual(api.calls,2)
    def test_retained_denial_image_creation_and_census_races_refuse(self):
        for kind in ('denied','dead','changed','added','image','creation'):
            api=Api();original=api.snapshot
            if kind in ('denied','dead','changed'):setattr(api,kind,True)
            elif kind=='added':
                def snapshot():
                    rows=original()
                    if api.calls==1:rows.pop(7)
                    return rows
                api.snapshot=snapshot
            elif kind=='image':
                api.image=lambda _:r'C:\Python\python.exe' if api.calls==1 else r'C:\Other\python.exe'
            else:api.marker=lambda _:1234 if api.calls==1 else 5678
            with self.subTest(kind=kind),patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):
                owners.retained_process_identities({7})
            if kind not in ('denied','added'):self.assertEqual(api.closed,[7])
    def test_retained_pid_validation_never_creates_a_native_probe(self):
        for pids in ({True},{0},{-1},{'7'},None):
            with self.subTest(pids=pids),patch.object(owners,'_NativeApi',side_effect=AssertionError('native probe')),self.assertRaises(ValueError):owners.retained_process_identities(pids)
    @unittest.skipUnless(os.name=='nt','Windows native exact retained owner API')
    def test_actual_retained_owner_uses_native_census_and_only_one_exact_handle_without_argv(self):
        api=owners._NativeApi();original=api.open;opened=[]
        def open_process(pid):opened.append(pid);return original(pid)
        api.open=open_process;api.command_line=lambda _:self.fail('argv read during retained owner check')
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.retained_process_identities({os.getpid()})
        self.assertEqual(opened,[os.getpid()]);self.assertEqual(set(rows),{os.getpid()})
        self.assertEqual(Path(rows[os.getpid()]['ExecutablePath']).resolve(),Path(sys.executable).resolve())
        self.assertEqual(rows[os.getpid()]['CreationFiletime'],owners.process_identity(os.getpid())['CreationFiletime'])
    def test_counted_unicode_is_exact_without_normalizing_quotes_or_replacing_utf16(self):
        text='"C:\\开发\\python.exe" "D:\\版本\\two words\\run.py"';buffer=command_buffer(text)
        self.assertEqual(owners._decode_command_line(buffer,len(buffer)),text)
    def test_exact_process_identity_uses_one_live_handle_without_argv_and_refuses_change(self):
        api=Api();api.command_line=lambda handle:(_ for _ in ()).throw(AssertionError('argv read'))
        with patch.object(owners,'_NativeApi',return_value=api):
            self.assertEqual(owners.process_identity(7),{'ProcessId':7,'ProcessName':'python.exe','CreationFiletime':'1234'})
        self.assertEqual(api.closed,[7]);self.assertEqual(api.calls,0)
        for kind in ('creation','image','denied'):
            api=Api();calls=[]
            if kind=='creation':
                def marker(handle):calls.append(handle);return 1234 if len(calls)==1 else 5678
                api.marker=marker
            elif kind=='image':
                def image(handle):calls.append(handle);return r'C:\Python\python.exe' if len(calls)==1 else r'C:\Other\python.exe'
                api.image=image
            else:api.denied=True
            with patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):owners.process_identity(7)
            if kind!='denied':self.assertEqual(api.closed,[7])
    def test_invalid_length_pointer_counted_nul_and_surrogate_are_not_empty_argv(self):
        cases=[]
        for mutate in [lambda v:setattr(v,'length',3),lambda v:setattr(v,'length',0),lambda v:setattr(v,'buffer',1),lambda v:setattr(v,'maximum',60000)]:
            buffer=command_buffer('original');mutate(owners._UnicodeString.from_buffer(buffer));cases.append(buffer)
        cases.append(command_buffer('before\x00after'))
        surrogate=command_buffer('a');ctypes.memmove(owners._UnicodeString.from_buffer(surrogate).buffer,b'\x00\xd8',2);cases.append(surrogate)
        for buffer in cases:
            with self.assertRaises(owners.OwnershipUnavailable):owners._decode_command_line(buffer,len(buffer))
        with self.assertRaises(owners.OwnershipUnavailable):owners._decode_command_line(command_buffer('original'),4)
    def test_complete_census_preserves_non_target_pid_for_retained_owner_reuse_guard(self):
        api=Api()
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.process_inventory()
        self.assertEqual([row['ProcessId'] for row in rows],[7,91]);self.assertIsNone(rows[1]['CommandLine']);self.assertIn('original',rows[0]['CommandLine']);self.assertEqual(api.closed,[7])
    def test_target_denial_exit_and_snapshot_change_refuse_without_partial_inventory(self):
        for flag in ('denied','dead','changed'):
            api=Api();setattr(api,flag,True)
            with patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):owners.process_inventory()
            if flag!='denied':self.assertEqual(api.closed,[7])
    def test_image_name_mismatch_refuses_the_original_pid(self):
        api=Api();api.image=lambda handle:r'C:\different\node.exe'
        with patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):owners.process_inventory()
        self.assertEqual(api.closed,[7])

    def test_explicit_names_ignore_other_executable_churn_without_opening_them(self):
        api=Api();api.rows[8]={'name':'node.exe','parent':1};original=api.snapshot
        def snapshot():
            rows=original()
            if api.calls==2:rows.pop(8)
            return rows
        api.snapshot=snapshot
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.process_inventory(target_names={'python.exe'})
        self.assertEqual([row['ProcessId'] for row in rows],[7,8,91]);self.assertEqual(api.closed,[7])
        self.assertIsNone(next(row for row in rows if row['ProcessId']==8)['CommandLine'])

    def test_explicit_native_backend_names_use_same_exact_identity_contract(self):
        api=Api();api.rows={7:{'name':'webcodex-server.exe','parent':1},8:{'name':'webcodex-runner.exe','parent':1}}
        api.image=lambda handle:'C:/owned/'+('webcodex-server.exe' if handle==7 else 'webcodex-runner.exe')
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.process_inventory(target_names={'webcodex-server.exe','webcodex-runner.exe'})
        self.assertEqual({row['ProcessName'] for row in rows},{'webcodex-server.exe','webcodex-runner.exe'})
        self.assertTrue(all(row['CreationFiletime']=='1234' for row in rows));self.assertEqual(api.closed,[8,7])

    def test_explicit_tunnel_and_desktop_names_return_held_parent_identity_metadata(self):
        api=Api();api.rows={7:{'name':'tunnel-client.exe','parent':91},8:{'name':'webcodex.exe','parent':17}}
        api.image=lambda handle:'C:/owned/'+('tunnel-client.exe' if handle==7 else 'webcodex.exe')
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.process_inventory(target_names={'tunnel-client.exe','webcodex.exe'})
        self.assertEqual({row['ProcessId']:row['ParentProcessId'] for row in rows},{7:91,8:17})
        self.assertTrue(all(row['CreationFiletime']=='1234' and row['CommandLine'] for row in rows))
        self.assertEqual(api.closed,[8,7])

    def test_extra_supported_names_do_not_expand_default_eight_name_observation(self):
        api=Api();api.rows.update({88:{'name':'tunnel-client.exe','parent':1},89:{'name':'webcodex.exe','parent':1}})
        original=api.open
        def open_process(pid):
            self.assertEqual(pid,7,'default inventory tried to open an extra supported name');return original(pid)
        api.open=open_process
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.process_inventory()
        self.assertEqual(len(owners.TARGET_NAMES),8)
        self.assertNotIn('tunnel-client.exe',owners.TARGET_NAMES);self.assertNotIn('webcodex.exe',owners.TARGET_NAMES)
        self.assertEqual(api.closed,[7]);self.assertEqual(next(row for row in rows if row['ProcessId']==7)['ParentProcessId'],1)
        self.assertTrue(all(row.get('CreationFiletime') is None for row in rows if row['ProcessId'] in [88,89]))

    def test_tunnel_parent_change_between_snapshots_is_not_stable_identity(self):
        api=Api();api.rows={7:{'name':'tunnel-client.exe','parent':91}};api.changed=True
        api.image=lambda handle:'C:/owned/tunnel-client.exe'
        with patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):
            owners.process_inventory(target_names={'tunnel-client.exe'})
        self.assertEqual(api.closed,[7])

    def test_invalid_explicit_names_or_filter_cannot_return_an_empty_inventory(self):
        for names in [set(),{'unknown.exe'},'python.exe',None]:
            if names is None:continue
            with self.subTest(names=str(names)),self.assertRaises(ValueError):owners.process_inventory(target_names=names)
        with self.assertRaises(ValueError):owners.process_inventory(candidate_filter=True)

    def test_identified_foreign_python_exit_is_not_an_application_owner_race(self):
        api=Api();original=api.snapshot
        def snapshot():
            rows=original()
            if api.calls==2:rows.pop(7)
            return rows
        api.snapshot=snapshot
        with patch.object(owners,'_NativeApi',return_value=api):rows=owners.process_inventory(target_names={'python.exe'},candidate_filter=lambda row:False)
        self.assertEqual(rows,[{'ProcessId':91,'CommandLine':None,'ProcessName':'other.exe'}]);self.assertEqual(api.closed,[7])

    def test_related_owner_exit_and_unreadable_candidate_never_become_empty(self):
        for kind in ['exit','denied','argv']:
            api=Api();original=api.snapshot
            if kind=='exit':
                def snapshot():
                    rows=original()
                    if api.calls==2:rows.pop(7)
                    return rows
                api.snapshot=snapshot
            elif kind=='denied':api.denied=True
            else:api.command_line=lambda _:(_ for _ in ()).throw(owners.OwnershipUnavailable())
            with self.subTest(kind=kind),patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):
                owners.process_inventory(target_names={'python.exe'},candidate_filter=lambda row:True)

    def test_new_named_process_is_classified_before_absence_and_new_real_owner_retained(self):
        for related in [True,False]:
            api=Api();original=api.snapshot
            def snapshot():
                rows=original()
                if api.calls==2:rows[17]={'name':'python.exe','parent':1}
                return rows
            api.snapshot=snapshot
            with patch.object(owners,'_NativeApi',return_value=api):
                rows=owners.process_inventory(target_names={'python.exe'},candidate_filter=lambda row:related and row['ProcessId']==17)
            new=next(row for row in rows if row['ProcessId']==17)
            self.assertEqual(new.get('CreationFiletime'),('1234' if related else None));self.assertEqual(api.closed,[17,7])
    def test_creation_change_or_unreadable_command_line_never_returns_a_partial_census(self):
        for kind in ('creation','argv'):
            api=Api();calls=[]
            if kind=='creation':
                def marker(handle):calls.append(handle);return 1234 if len(calls)==1 else 5678
                api.marker=marker
            else:
                def unavailable(handle):raise owners.OwnershipUnavailable()
                api.command_line=unavailable
            with patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):owners.process_inventory()
            self.assertEqual(api.closed,[7])
    def test_ipv4_and_ipv6_bounded_owner_tables_and_truncated_count(self):
        for family,Row in ((2,owners._Tcp4),(23,owners._Tcp6)):
            row=Row();row.state=2;row.pid=72480;row.local_port=socket.htons(18944)
            if family==2:row.local_address=struct.unpack('<I',socket.inet_pton(socket.AF_INET,'127.0.0.1'))[0]
            else:row.local_address[:]=socket.inet_pton(socket.AF_INET6,'::1')
            buffer=ctypes.create_string_buffer(struct.pack('<I',1)+bytes(row));result=owners._decode_tcp_table(buffer,len(buffer),family,18944)
            self.assertEqual(result[0]['OwningProcess'],72480);self.assertEqual(result[0]['LocalPort'],18944)
            with self.assertRaises(owners.OwnershipUnavailable):owners._decode_tcp_table(buffer,4,family,18944)
    def test_one_family_failure_cannot_be_reported_as_no_listener(self):
        api=Api();empty=ctypes.create_string_buffer(struct.pack('<I',0))
        def table(family):
            if family==23:raise owners.OwnershipUnavailable('windows_port_ownership_unavailable')
            return empty,len(empty)
        api.tcp_table=table
        with patch.object(owners,'_NativeApi',return_value=api),self.assertRaises(owners.OwnershipUnavailable):owners.tcp_listeners(18944)
    @unittest.skipUnless(os.name=='nt','Windows native process API')
    def test_actual_current_process_exact_handle_image_and_counted_argv(self):
        api=owners._NativeApi();handle=api.open(os.getpid())
        try:
            before=api.marker(handle);image=api.image(handle);command=api.command_line(handle);after=api.marker(handle)
            self.assertEqual(before,after);self.assertEqual(Path(image).resolve(),Path(sys.executable).resolve())
            # Windows preserves the literal invocation (including a PATH alias)
            # separately from the resolved executable image.
            argv=command_argv(command)
            self.assertIn(Path(argv[0]).name.casefold(),('python','python.exe'))
            self.assertIn('-b',[arg.casefold() for arg in argv[1:]])
            self.assertEqual(owners.process_identity(os.getpid()),{'ProcessId':os.getpid(),'ProcessName':'python.exe','CreationFiletime':str(before)})
        finally:api.close(handle)

    @unittest.skipUnless(os.name=='nt','Windows native process API')
    def test_actual_short_lived_foreign_python_does_not_block_but_related_exit_refuses(self):
        for related in [False,True]:
            child=subprocess.Popen([sys.executable,'-B','-c','import time;time.sleep(.3)'],
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                close_fds=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            try:
                api=owners._NativeApi();snapshot=api.snapshot;calls=[]
                def scoped_snapshot():
                    if calls:child.wait(timeout=3)
                    calls.append(1)
                    return {pid:row for pid,row in snapshot().items() if pid in {os.getpid(),child.pid}}
                api.snapshot=scoped_snapshot
                with patch.object(owners,'_NativeApi',return_value=api):
                    candidate=lambda row:row['ProcessId']==child.pid if related else row['ProcessId']==os.getpid()
                    if related:
                        with self.assertRaises(owners.OwnershipUnavailable):owners.process_inventory(target_names={'python.exe'},candidate_filter=candidate)
                    else:
                        rows=owners.process_inventory(target_names={'python.exe'},candidate_filter=candidate)
                        self.assertEqual([row['ProcessId'] for row in rows],[os.getpid()])
                        self.assertEqual(rows[0]['CreationFiletime'],owners.process_identity(os.getpid())['CreationFiletime'])
                self.assertEqual(calls,[1,1]);self.assertEqual(child.returncode,0)
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=3) # Exact isolated fixture child only.

    @unittest.skipUnless(os.name=='nt' and shutil.which('node'),'Windows native process API and existing Node')
    def test_actual_short_lived_node_is_not_read_by_browser_candidate_inventory(self):
        child=subprocess.Popen([shutil.which('node'),'-e','setTimeout(()=>{},300)'],
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
            close_fds=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            api=owners._NativeApi();snapshot=api.snapshot;opened=[];open_process=api.open;calls=[]
            def scoped_snapshot():
                if calls:child.wait(timeout=3)
                calls.append(1)
                return {pid:row for pid,row in snapshot().items() if pid in {os.getpid(),child.pid}}
            def scoped_open(pid):opened.append(pid);return open_process(pid)
            api.snapshot=scoped_snapshot;api.open=scoped_open
            with patch.object(owners,'_NativeApi',return_value=api):
                rows=owners.process_inventory(target_names={'electron.exe','python.exe','pythonw.exe'},candidate_filter=lambda row:True)
            self.assertNotIn(child.pid,opened);self.assertEqual(opened,[os.getpid()]);self.assertEqual(child.returncode,0)
            self.assertEqual(next(row for row in rows if row['ProcessId']==os.getpid())['ProcessName'],'python.exe')
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=3) # Exact isolated fixture child only.

if __name__=='__main__':unittest.main()
