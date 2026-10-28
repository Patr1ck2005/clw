"""Render a static first-run guide. Never touch launchers, profiles or credentials."""
from pathlib import Path
import html

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = 'webcodex-desktop-v0.4.1-win32-x64-setup.exe'

def build_page(manual: str) -> str:
    css='body{margin:0;background:#10171c;color:#dce8eb;font:16px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1060px;margin:auto;padding:40px 28px}h1{font-size:38px;line-height:1.25;color:#fff}h2{color:#b4e3d9;margin-top:28px}a{color:#a3e5dc}.notice{border-left:4px solid #ffc878;padding:12px 18px;background:#222c31}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0b1115;border:1px solid #32434a;padding:20px;border-radius:10px;font:14px/1.65 Consolas,monospace}summary{cursor:pointer}small{color:#9eb0b7}code{overflow-wrap:anywhere}@media(max-width:700px){main{padding:24px 16px}h1{font-size:28px}}'
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>WebCodex · 首次使用</title><style>{css}</style></head><body><main>
<small>一次本机安装与账号授权 · 后续开发不必反复批准</small><h1>先打开原版 WebCodex，<br>不再手动拼装服务。</h1>
<p class="notice">安装文件已准备并核对发布者校验和，但未执行。安装包未数字签名；安全策略拦截时不要关闭防护。账号连接仍待实际验证。</p>
<h2>1 · 安装并选择项目</h2><p>在资源管理器打开本指南同目录的downloads文件夹，运行你审核确认的原版安装文件：</p><pre>{INSTALLER}</pre>
<p>打开后选择 <strong>Local Full Runtime / Use WebCodex on this computer</strong>，项目选择：</p><pre>D:\\Dev\\Projects\\Personal\\clw-webcodex</pre>
<p>不选Quick Share，不同时运行旧START脚本。由原版Desktop管理通用Server/Runner；无需先初始化CLI的workspace配置。</p>
<h2>2 · 在本机完成当前账号授权</h2><p>到OpenAI Platform的Tunnel设置创建或选择Tunnel并关联目标ChatGPT工作区。把Tunnel ID和有相应权限的Restricted Key填入原版WebCodex的Settings → OpenAI Tunnel network。</p>
<p>密钥只填本机，不发聊天或截图。上游此版本会把Key保存在未加密的本地secrets配置中，不要共享该目录。Tunnel就绪之后再在ChatGPT新增Tunnel连接；不能把本地绿色状态当成已经接通。</p>
<p><a href="https://platform.openai.com/settings/organization/tunnels" rel="noopener">OpenAI Tunnel设置</a> · <a href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" rel="noopener">官方权限说明</a></p>
<h2>接通后继续完整任务</h2><p>先用当前账号真实读取项目、核对一次写入与后台Job，然后复用到第二账号。账号不限定用途；检查点保存后继续原任务，不按时长切断工作。</p>
<p>math-research的目录更名尚被Windows拒绝，但不阻塞先连接以上已存在的产品项目。</p>
<p><a href="DESKTOP_FIRST_RUN.md">详细首次使用说明</a> · <a href="../clw-webcodex/prompts/START_TASK.md">通用开工模板</a> · <a href="GENERAL_SETUP.md">高级CLI备选（现在不必执行）</a></p>
<details><summary>展开详细字段、事实与来源</summary><pre>{html.escape(manual)}</pre></details>
<small>本页无脚本、登录表单或自动安装功能，不收集凭据，不执行命令，也不是实时状态面板。</small></main></body></html>'''

def render(root: Path = ROOT) -> None:
    manual=(root/'DESKTOP_FIRST_RUN.md').read_text(encoding='utf-8')
    (root/'START_HERE.html').write_text(build_page(manual),encoding='utf-8')

if __name__ == '__main__':
    render()
