"""Read-only Windows process/port ownership without CIM or third-party packages.

Returned command lines are for the caller's exact ownership comparison only.
This module never logs them, stops processes, or changes a service/route.
Unavailable or racing identity is an error, never an empty process inventory.
"""
from __future__ import annotations
import ctypes,ctypes.wintypes as w,os,socket,struct
from contextlib import ExitStack
from pathlib import PureWindowsPath

TARGET_NAMES=frozenset(('electron.exe','bun.exe','python.exe','pythonw.exe','node.exe','pwsh.exe','powershell.exe','codex.exe'))
SUPPORTED_TARGET_NAMES=TARGET_NAMES|frozenset(('webcodex-server.exe','webcodex-runner.exe','tunnel-client.exe','webcodex.exe'))
MAX_COMMAND_LINE=1024*1024
MAX_TCP_TABLE=8*1024*1024
DWORD=ctypes.c_uint32

class OwnershipUnavailable(RuntimeError):
    def __init__(self,code='windows_process_ownership_unavailable'):
        super().__init__(code)

class _ProcessEntry(ctypes.Structure):
    _fields_=[('size',DWORD),('usage',DWORD),('pid',DWORD),('heap',ctypes.c_size_t),('module',DWORD),('threads',DWORD),('parent',DWORD),('priority',ctypes.c_int32),('flags',DWORD),('name',w.WCHAR*260)]
class _UnicodeString(ctypes.Structure):
    _fields_=[('length',ctypes.c_uint16),('maximum',ctypes.c_uint16),('buffer',ctypes.c_void_p)]
class _Tcp4(ctypes.Structure):
    _fields_=[(name,DWORD) for name in ('state','local_address','local_port','remote_address','remote_port','pid')]
class _Tcp6(ctypes.Structure):
    _fields_=[('local_address',ctypes.c_ubyte*16),('local_scope',DWORD),('local_port',DWORD),('remote_address',ctypes.c_ubyte*16),('remote_scope',DWORD),('remote_port',DWORD),('state',DWORD),('pid',DWORD)]

def _decode_command_line(buffer,returned):
    capacity=ctypes.sizeof(buffer)
    if not ctypes.sizeof(_UnicodeString)<=returned<=capacity:raise OwnershipUnavailable()
    value=_UnicodeString.from_buffer(buffer);base=ctypes.addressof(buffer)
    if value.length%2 or value.maximum%2 or not value.length or value.length>value.maximum or not value.buffer or value.buffer<base+ctypes.sizeof(value) or value.buffer+value.maximum>base+returned:
        raise OwnershipUnavailable()
    try:result=ctypes.string_at(value.buffer,value.length).decode('utf-16-le',errors='strict')
    except UnicodeError:raise OwnershipUnavailable() from None
    if '\x00' in result:raise OwnershipUnavailable()
    return result

def _decode_tcp_table(buffer,size,family,port):
    Row=_Tcp4 if family==2 else _Tcp6
    if family not in (2,23) or not 4<=size<=ctypes.sizeof(buffer):raise OwnershipUnavailable('windows_port_ownership_unavailable')
    count=struct.unpack_from('<I',buffer)[0]
    if 4+count*ctypes.sizeof(Row)>size:raise OwnershipUnavailable('windows_port_ownership_unavailable')
    rows=[]
    for index in range(count):
        row=Row.from_buffer_copy(buffer,4+index*ctypes.sizeof(Row))
        if row.state!=2 or not row.pid:raise OwnershipUnavailable('windows_port_ownership_unavailable')
        if socket.ntohs(row.local_port&0xffff)!=port:continue
        address=socket.inet_ntop(socket.AF_INET if family==2 else socket.AF_INET6,struct.pack('<I',row.local_address) if family==2 else bytes(row.local_address))
        rows.append({'LocalAddress':address,'LocalPort':port,'OwningProcess':int(row.pid)})
    return rows

class _NativeApi:
    def __init__(self):
        if os.name!='nt':raise OwnershipUnavailable()
        try:self.kernel=ctypes.WinDLL('kernel32',use_last_error=True);self.nt=ctypes.WinDLL('ntdll');self.ip=ctypes.WinDLL('iphlpapi')
        except (OSError,AttributeError):raise OwnershipUnavailable() from None
        k=self.kernel
        k.CreateToolhelp32Snapshot.argtypes=[DWORD,DWORD];k.CreateToolhelp32Snapshot.restype=w.HANDLE
        k.Process32FirstW.argtypes=[w.HANDLE,ctypes.POINTER(_ProcessEntry)];k.Process32FirstW.restype=w.BOOL
        k.Process32NextW.argtypes=k.Process32FirstW.argtypes;k.Process32NextW.restype=w.BOOL
        k.CloseHandle.argtypes=[w.HANDLE];k.CloseHandle.restype=w.BOOL
        k.OpenProcess.argtypes=[DWORD,w.BOOL,DWORD];k.OpenProcess.restype=w.HANDLE
        k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,DWORD,w.LPWSTR,ctypes.POINTER(DWORD)];k.QueryFullProcessImageNameW.restype=w.BOOL
        k.GetProcessTimes.argtypes=[w.HANDLE,*([ctypes.POINTER(w.FILETIME)]*4)];k.GetProcessTimes.restype=w.BOOL
        k.GetExitCodeProcess.argtypes=[w.HANDLE,ctypes.POINTER(DWORD)];k.GetExitCodeProcess.restype=w.BOOL
        self.nt.NtQueryInformationProcess.argtypes=[w.HANDLE,DWORD,ctypes.c_void_p,DWORD,ctypes.POINTER(DWORD)];self.nt.NtQueryInformationProcess.restype=ctypes.c_int32
        self.ip.GetExtendedTcpTable.argtypes=[ctypes.c_void_p,ctypes.POINTER(DWORD),w.BOOL,DWORD,ctypes.c_int,DWORD];self.ip.GetExtendedTcpTable.restype=DWORD
    def close(self,handle):
        if not self.kernel.CloseHandle(handle):raise OwnershipUnavailable()
    def snapshot(self):
        handle=self.kernel.CreateToolhelp32Snapshot(2,0)
        if not handle or handle==ctypes.c_void_p(-1).value:raise OwnershipUnavailable()
        try:
            result={};entry=_ProcessEntry();entry.size=ctypes.sizeof(entry)
            ok=self.kernel.Process32FirstW(handle,ctypes.byref(entry))
            while ok:
                pid=int(entry.pid);name=entry.name.casefold()
                if pid in result or not name:raise OwnershipUnavailable()
                result[pid]={'name':name,'parent':int(entry.parent)}
                ok=self.kernel.Process32NextW(handle,ctypes.byref(entry))
            if ctypes.get_last_error()!=18 or os.getpid() not in result:raise OwnershipUnavailable()
            return result
        finally:self.close(handle)
    def open(self,pid):
        handle=self.kernel.OpenProcess(0x1000,False,pid)
        if not handle:raise OwnershipUnavailable()
        return handle
    def marker(self,handle):
        values=[w.FILETIME() for _ in range(4)];code=DWORD()
        if not self.kernel.GetProcessTimes(handle,*[ctypes.byref(value) for value in values]) or not self.kernel.GetExitCodeProcess(handle,ctypes.byref(code)):raise OwnershipUnavailable()
        created=(values[0].dwHighDateTime<<32)|values[0].dwLowDateTime
        if not created or values[1].dwHighDateTime or values[1].dwLowDateTime or code.value!=259:raise OwnershipUnavailable()
        return created
    def image(self,handle):
        buffer=ctypes.create_unicode_buffer(32768);size=DWORD(len(buffer))
        if not self.kernel.QueryFullProcessImageNameW(handle,0,buffer,ctypes.byref(size)) or not 0<size.value<len(buffer):raise OwnershipUnavailable()
        return buffer[:size.value]
    def command_line(self,handle):
        size=DWORD();status=self.nt.NtQueryInformationProcess(handle,60,None,0,ctypes.byref(size))
        if status&0xffffffff not in (0xc0000004,0xc0000023) or not ctypes.sizeof(_UnicodeString)<=size.value<=MAX_COMMAND_LINE:raise OwnershipUnavailable()
        buffer=ctypes.create_string_buffer(size.value);returned=DWORD()
        status=self.nt.NtQueryInformationProcess(handle,60,buffer,len(buffer),ctypes.byref(returned))
        if status<0:raise OwnershipUnavailable()
        return _decode_command_line(buffer,returned.value)
    def tcp_table(self,family):
        size=DWORD();status=self.ip.GetExtendedTcpTable(None,ctypes.byref(size),False,family,3,0)
        if status!=122 or not 4<=size.value<=MAX_TCP_TABLE:raise OwnershipUnavailable('windows_port_ownership_unavailable')
        # The table can grow between size/read without changing any route.
        for _ in range(3):
            buffer=ctypes.create_string_buffer(size.value);capacity=len(buffer)
            status=self.ip.GetExtendedTcpTable(buffer,ctypes.byref(size),False,family,3,0)
            if status==122 and capacity<size.value<=MAX_TCP_TABLE:continue
            if status or size.value>capacity:raise OwnershipUnavailable('windows_port_ownership_unavailable')
            return buffer,size.value
        raise OwnershipUnavailable('windows_port_ownership_unavailable')

def process_identity(pid):
    """Live exact PID creation/image identity under one held handle; no argv."""
    if type(pid) is not int or not 1<=pid<=0xffffffff:raise OwnershipUnavailable()
    api=_NativeApi();handle=api.open(pid)
    try:
        created=api.marker(handle);image=api.image(handle)
        if api.image(handle)!=image or api.marker(handle)!=created:raise OwnershipUnavailable()
        name=PureWindowsPath(image).name.casefold()
        if not name:raise OwnershipUnavailable()
        return {'ProcessId':pid,'ProcessName':name,'CreationFiletime':str(created)}
    finally:api.close(handle)

def retained_process_identities(pids):
    """Observe only retained owner PIDs; census absence never masks a denied read.

    Toolhelp supplies names/PIDs without opening foreign processes. Exact live
    creation/image identities use held handles, with no command-line reads.
    """
    try:requested=frozenset(pids)
    except TypeError:raise ValueError('invalid_retained_process_ids') from None
    if any(type(pid) is not int or not 1<=pid<=0xffffffff for pid in requested):raise ValueError('invalid_retained_process_ids')
    api=_NativeApi();first=api.snapshot();rows={};markers={}
    with ExitStack() as stack:
        for pid in sorted(requested & first.keys()):
            handle=api.open(pid);stack.callback(api.close,handle)
            created=api.marker(handle);image=api.image(handle)
            if PureWindowsPath(image).name.casefold()!=first[pid]['name']:raise OwnershipUnavailable()
            rows[pid]={'ProcessId':pid,'ProcessName':first[pid]['name'],'ExecutablePath':image,'CreationFiletime':str(created)}
            markers[pid]=(handle,created,image)
        last=api.snapshot()
        if any(first.get(pid)!=last.get(pid) for pid in requested):raise OwnershipUnavailable()
        if any(api.marker(handle)!=created or api.image(handle)!=image for handle,created,image in markers.values()):raise OwnershipUnavailable()
        return rows

def process_inventory(*,target_names=None,candidate_filter=None):
    """Complete PID census with exact identities for the requested names.

    The default retains the original strict eight-name census. Startup callers
    may request their own executable names and identify which rows can own
    their application. Already identified unrelated processes need not remain
    alive for that application's absence check; new named candidates are read
    from the second snapshot, never silently discarded.
    """
    if target_names is None:names=TARGET_NAMES
    else:
        if isinstance(target_names,(str,bytes)):raise ValueError('invalid_process_inventory_names')
        try:names=frozenset(target_names)
        except TypeError:raise ValueError('invalid_process_inventory_names') from None
        if not names or not names<=SUPPORTED_TARGET_NAMES:raise ValueError('invalid_process_inventory_names')
    if candidate_filter is not None and not callable(candidate_filter):raise ValueError('invalid_process_candidate_filter')
    api=_NativeApi();first=api.snapshot();rows={};markers={}
    with ExitStack() as stack:
        def inspect(pid,entry):
            handle=api.open(pid);stack.callback(api.close,handle);created=api.marker(handle)
            image=api.image(handle);command=api.command_line(handle)
            if PureWindowsPath(image).name.casefold()!=entry['name'] or api.marker(handle)!=created:raise OwnershipUnavailable()
            row={'ProcessId':pid,'ParentProcessId':entry['parent'],'CommandLine':command,'ProcessName':entry['name'],'ExecutablePath':image,'CreationFiletime':str(created)}
            if candidate_filter is None or candidate_filter(row):
                rows[pid]=row;markers[pid]=(handle,created)
        for pid,entry in first.items():
            if entry['name'] in names:inspect(pid,entry)
        last=api.snapshot()
        targets=lambda values:{pid:entry for pid,entry in values.items() if entry['name'] in names}
        if candidate_filter is None:
            if targets(first)!=targets(last):raise OwnershipUnavailable()
        else:
            if any(first[pid]!=last.get(pid) for pid in markers):raise OwnershipUnavailable()
            # A new Python launcher or primary Electron must not hide behind
            # another process's harmless exit. Inspect all additions/changes.
            for pid,entry in targets(last).items():
                if first.get(pid)!=entry:inspect(pid,entry)
        if any(api.marker(handle)!=created for handle,created in markers.values()):raise OwnershipUnavailable()
        # Non-target PIDs also matter: a retained owner PID reused by another
        # executable is ambiguous and cannot disappear behind a name filter.
        census={**first,**last} if candidate_filter is None else last
        for pid,entry in census.items():
            rows.setdefault(pid,{'ProcessId':pid,'CommandLine':None,'ProcessName':entry['name']})
        return [rows[pid] for pid in sorted(rows)]

def tcp_listeners(port):
    """Return the complete IPv4+IPv6 listener ownership for one exact port."""
    if type(port) is not int or not 1<=port<=65535:raise OwnershipUnavailable('windows_port_ownership_unavailable')
    api=_NativeApi();rows=[]
    for family in (2,23):
        buffer,size=api.tcp_table(family);rows.extend(_decode_tcp_table(buffer,size,family,port))
    return rows
