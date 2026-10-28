"""Project runtime protocol guides into a public candidate without instance history."""
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MANAGED_SECTIONS={'协作的日常流程：送任务、带回结果','每轮正式开发的工作量',
 '持续目标的接续与暂停','Codex＋Web 的上下文来源','网页主控的工具',
 '安全交接到后继对话','结果与恢复'}

def project(name,source):
    if name=='MANAGED_WEB.md':
        blocks=re.split(r'(?m)(?=^## )',source)
        source='# CLW 网页主控与协作合同\n\n'+''.join(block for block in blocks
          if block.startswith('## ') and block.splitlines()[0][3:] in MANAGED_SECTIONS)
        source=re.sub(r'2026-10-04 Camp[^\n]*','',source)
        source=re.sub(r'(?m)^上述简化已[^\n]*',
          '原任务保留自己的协议、账号和请求身份，不因界面简化自动迁移。原身份、重复发送、用户暂停和未知副作用由程序维护；Codex＋Web 的原生上下文运输保持。',source)
        source=re.sub(r'完整协作方法与可复制模板见 \[WorkFlow\]\(D:/Dev/WorkFlow/README.md\)，当前是否已经加载看 CURRENT。',
          '安装与人工操作见[使用说明](../../README.md)。',source)
        source=source.replace('本次误点击 Camp 停止生成及其原任务恢复的事实记录在 CURRENT/DEV，不能删掉错误记录或声称没有中断。','')
        source=re.sub(r'2026-\d{2}-\d{2}\s*用户(?:确认|纠正|进一步明确退出标准)：','',source)
        source=source.replace('用户于2026-09-28明确要求：','')
        source=source.replace('具体字段见 [AUTONOMOUS_RUN_RECEIVER.md](AUTONOMOUS_RUN_RECEIVER.md)；',
          '具体字段查 CLI 的 `--help` 与本次工具返回的真实合同；')
    elif name=='HOST_RECEIVER.md':
        source=re.sub(r'首次采用的源为[^\n]*\n','',source)
        source=source.replace('见 `BRANCHES.md`','具体字段查 `harness_host_client.py --help` 与原请求合同')
        source=source.replace('具体架构修正见CONTROL_PLANE_DECISION.md。','')
        source=source.replace('原 self-trial 的 W1/W2 暂停不随新请求解除。','独立的用户停止仍保留。')
        source=source.replace('--target primary-a','--target <自己的target>')
        source=re.sub(r'wc_sess_[A-Za-z0-9_-]+','<自己的Session>',source)
    elif name=='WEB_RECEIVER.md':
        source=source.replace('此前ACCOUNT-A-SELF-TRIAL的暂停不被新通知解除，其W1/W2与旧稿不得随意修改。',
          '独立的用户停止不因新通知解除。')
    else:raise ValueError('public_guide_unknown')
    source=re.sub(r'\[([^\]]+)\]\([^)]*evidence/[^)]*\)',r'\1',source)
    # Only public parameter placeholders are meaningful in an installed copy.
    if re.search(r'wc_sess_|tunnel_[0-9a-f]{32}|web-[0-9a-f]{8}-|hthr_[0-9a-f]{32}',source):
        raise ValueError('public_guide_contains_instance_identity')
    if re.search(r'D:/Dev/|CURRENT/DEV|Camp|Spirefall|evidence/',source):
        raise ValueError('public_guide_contains_instance_history')
    lines=source.splitlines()
    lines[1:1]=['','本说明由开发合同生成公开投影，保留通用工具行为；不携带开发实例的账号、绑定、历史回执或验收记录。实际参数以当前工具合同与原请求为准。']
    return '\n'.join(lines).rstrip()+'\n'

def main(root=ROOT):
    output=Path(root)/'docs/product-receivers';output.mkdir(parents=True,exist_ok=True)
    for name in ['MANAGED_WEB.md','HOST_RECEIVER.md','WEB_RECEIVER.md']:
        source=(Path(root)/'docs/harness'/name).read_text(encoding='utf-8-sig')
        (output/name).write_text(project(name,source),encoding='utf8')
    print('Generated three public protocol guides; no instance state read or model called.')

if __name__=='__main__':main()
