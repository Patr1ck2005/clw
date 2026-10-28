import test from 'node:test';import assert from 'node:assert/strict';
import {projectEvents,composerAction,canSend,isWebProvider,statusLabel} from '../apps/control-center/harness-model.mjs';
test('host is Web without gaining Codex controls',()=>{assert.equal(isWebProvider('chatgpt_web_host'),true);assert.equal(composerAction({provider:'chatgpt_web_host',status:'processing',active_turn:'request'},null),'message.append');});
test('queued and paused inputs do not become duplicate sends',()=>{for(const status of ['waiting','processing','waiting_children','host_paused'])assert.equal(canSend({status},null),false);});
test('host reply provider and requested phase stay visible',()=>{const rows=projectEvents([{seq:1,kind:'assistant_message',data:{item_id:'reply',provider:'chatgpt_web_host',text:'公开结果'}},{seq:2,kind:'host_result',data:{status:'completed'}}]);assert.equal(rows[0].provider,'chatgpt_web_host');assert.equal(rows[1].role,'system');});
test('waiting does not claim native model execution',()=>{assert.match(statusLabel('waiting'),/等待/);assert.match(projectEvents([{seq:1,kind:'host_queued',data:{}}])[0].text,/尚未执行/);});
