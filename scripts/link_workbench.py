"""Verified, idempotent local link. No new credentials, grants, or backend mutations."""
from __future__ import annotations
import json
import os
from pathlib import Path
import tempfile
from live_transport import runner_configuration, runner_profile_kind, ObservationError
from live_observer import Observer

class LinkError(ValueError):
    pass


def write_reference(destination: Path, reference: dict) -> bool:
    """Atomic create without replacing an existing connection. True iff created.
    Contains absolute references only, never credential bytes. A same-reference retry
    is safe; a different or corrupt existing reference is never silently overwritten.
    """
    body = json.dumps(reference, ensure_ascii=False, indent=2) + '\n'
    def same_existing():
        try:
            if destination.stat().st_size > 16384:
                return False
            return json.loads(destination.read_text(encoding='utf-8-sig')) == reference
        except (OSError, ValueError, UnicodeError):
            return False
    if destination.exists():
        if same_existing():return False
        raise LinkError('已有不同或损坏的连接引用，未覆盖；请先核对本机配置。')
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.connection-', suffix='.tmp', dir=destination.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as file:
            file.write(body);file.flush();os.fsync(file.fileno())
        try:
            os.link(temporary, destination) # Atomic exclusive install; never replace.
            return True
        except FileExistsError:
            if same_existing():return False
            raise LinkError('关联期间其他进程已保存不同连接，未覆盖。') from None
    finally:
        Path(temporary).unlink(missing_ok=True)


def link_profile(destination: Path, runner_path: Path, user_token_file: Path | None = None):
    """Both paths must be explicitly selected/authorized by the caller.
    Successful runtime observation precedes persistence; 401/403 never create a link.
    """
    try:
        runner_path = runner_path.resolve()
        transport = runner_configuration(runner_path, user_token_file)
        state = Observer(transport).state()
        if state['state'] != 'connected' or state.get('projection') is None:
            raise LinkError('运行接口核验未通过（'+str(state.get('error_code') or state['state'])+'），没有保存关联。')
        reference = {'schema_version':1, 'runner_config':str(runner_path)}
        if user_token_file is not None:
            reference['user_token_file'] = str(user_token_file.resolve())
        created = write_reference(destination, reference)
        return transport, {'linked':True,'created':created,'credential_mode':'managed_user_pat' if user_token_file else 'runtime_credential',
            'project_count':len(state['projection']['projects']), 'runner_id':transport.client_id,
            'read_only':True,'credential_bytes_persisted':False}
    except LinkError:
        raise
    except (OSError, ValueError, TypeError, ObservationError):
        raise LinkError('选择的连接配置或用户运行凭据不可用，未修改后端；没有显示凭据内容。') from None


def select_and_link(destination: Path):
    """Native UI obtains explicit consent for the paired PAT before reading it."""
    from tkinter import Tk, filedialog, messagebox
    tk = Tk();tk.withdraw()
    try:
        chosen = filedialog.askopenfilename(parent=tk, title='选择 WebCodex 的 Runner 配置', filetypes=[('Runner TOML','*.toml')])
        if not chosen:return None
        runner = Path(chosen).resolve();user_ref = None
        if runner_profile_kind(runner) == 'managed':
            paired = runner.parent / 'webcodex-user-token'
            accepted = messagebox.askyesno('关联已登录的 WebCodex 用户',
                '该配置属于托管 Runner，不能使用 Runner 密钥访问工作台。\n\n'
                '是否允许工作台读取同一登录目录中已有的 webcodex-user-token？\n'
                '只用于项目、Session 和 Job 等只读查询；不新建密钥，不改权限。\n'
                '仅保存文件路径引用，不把密钥放入浏览器或聊天。\n\n'+str(paired), parent=tk)
            if not accepted:return None
            user_ref = paired
        transport, receipt = link_profile(destination, runner, user_ref)
        return transport, receipt
    except LinkError as exc:
        messagebox.showerror('未完成关联', str(exc), parent=tk)
        return None
    except (OSError, ValueError, TypeError, ObservationError):
        messagebox.showerror('未完成关联', '未通过本机配置或只读运行接口核验。原连接不会被替换；请核对所选登录配置。', parent=tk)
        return None
    finally:
        tk.destroy()
