"""Discover only this installation's existing managed Harness listener."""
from pathlib import Path
import os
from urllib.parse import urlsplit
from product_runtime import atomic_json, read_json


def image_identity(pid):
    from windows_process_owner import _NativeApi, OwnershipUnavailable
    api=_NativeApi();handle=api.open(pid)
    try:
        created=api.marker(handle);executable=api.image(handle)
        if api.marker(handle)!=created or api.image(handle)!=executable:
            raise OwnershipUnavailable('harness_endpoint_owner_changed')
        return {'ProcessId':pid,'CreationFiletime':str(created),'ExecutablePath':executable}
    finally:api.close(handle)


def publish(root, origin, instance_id, store_id, process):
    root = Path(root).resolve()
    (root / '.local/harness').mkdir(parents=True, exist_ok=True)
    if 'ExecutablePath' not in process:
        actual=image_identity(process['ProcessId'])
        if actual['CreationFiletime']!=process['CreationFiletime']:
            raise ValueError('harness_endpoint_owner_changed')
        process=actual
    record = {'schema': 1, 'data_home': str((root / '.local').resolve()),
              'origin': origin, 'instance_id': instance_id, 'store_id': store_id,
              'pid': process['ProcessId'], 'creation_filetime': process['CreationFiletime'],
              'executable': process['ExecutablePath']}
    atomic_json(root / '.local/harness/endpoint.json', record)
    return record


def resolve(root, *, inspect_process=None):
    root = Path(root).resolve()
    value = read_json(root / '.local/harness/endpoint.json', maximum=8192)
    parsed = urlsplit(value.get('origin', ''))
    if (value.get('schema') != 1 or value.get('data_home') != str((root / '.local').resolve())
            or parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
            or not parsed.port or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
            or not isinstance(value.get('pid'), int) or not value.get('instance_id') or not value.get('store_id')):
        raise ValueError('harness_endpoint_invalid')
    process = (inspect_process or image_identity)(value['pid'])
    normalize = lambda path: os.path.normcase(os.path.abspath(str(path).removeprefix('\\\\?\\')))
    if (process['CreationFiletime'] != value.get('creation_filetime')
            or normalize(process['ExecutablePath']) != normalize(value.get('executable', ''))):
        raise ValueError('harness_endpoint_owner_changed')
    return value['origin']
