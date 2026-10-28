"""One source for the actual enrollment message and its non-authorizing preview."""
from harness_accounts import connector_name
from harness_state import canonical
from harness_managed_preparation import prompt as preparation_prompt
from harness_work_package import WORK_PACKAGE_GUIDANCE, context_pointers


def enrollment_blocks(*, root, account, instructions, cli, store_id, target, ticket,first_turn_mode='task_v1'):
    connector = connector_name(account)
    mode = ('接入与首个任务在本轮一起完成。' if first_turn_mode=='task_v1' else '接入后在本轮完成首次准备，不开始项目写入。') if instructions else '仅接入，不开始项目写入。'
    return [
        {'title': '连接器与项目背景', 'text': f'CLW 专用网页工作区接入。{mode}@{connector}\n工作工程：{root}\n'},
        {'title': '指导入口', 'text': context_pointers(root, first=True)},
        {'title': '读取项目指导与接入本地工具', 'text':
         f'用 {connector} 的 work_on_project 取得本对话的 project/Workflow Session：已知真实 project 时传 project + instruction，'
         '否则发现真实 client_id 后传 client_id + path + instruction（path 为上面工程）。两种形式不混用，不猜身份。'
         '新 Session 省略 session_id；已有本对话有效 Session 则复用，不复制别人的 Session。'
         '首次只请求 context_request=["project.instructions"] 并读取项目指导；已读指导不重复加载，其他手册按需读取。\n'
         f'再通过该项目已授权工具运行：python -X utf8 -B "{cli}" enroll --store-id {store_id} '
         f'--target {target} --session-id <本对话的实际Session> --operation-id <本次唯一且固定的操作键> '
         '--payload-json <以下 JSON 作为单一参数，将 project 替换为工具返回的实际项目>\n' +
         canonical({'ticket': ticket, 'project': '<本对话实际project>', 'root': root})},
        {'title': '你的首次要求与结果交付', 'text': preparation_prompt(instructions,first_turn_mode)},
        *([{'title': '本轮完整工作量', 'text': WORK_PACKAGE_GUIDANCE}]
          if instructions and first_turn_mode=='task_v1' else []),
        {'title': '原操作接续', 'text': '已受理或结果未知的操作查询原回执后接续。实际工具权限以本对话合同为准。'},
    ]
