import test from 'node:test';
import assert from 'node:assert/strict';
import {statusText} from '../apps/control-center/product-status.mjs';
const sample=()=>({success:true,schema_version:1,product:'clw-control-center',version:'0.6.0-g0.1',channel:'stable',instance_id:'1'.repeat(32),fixed_release:true,verified_at_start:true,commit_describes_payload:true,source_commit:'a'.repeat(40),payload_sha256:'b'.repeat(64),state_id:'c'.repeat(32)});
test('fixed identity describes current runtime without claiming autonomy',()=>{const x=statusText(sample());assert.match(x.title,/稳定运行版/);assert.match(x.detail,/不代表网页托管/);});
test('development HEAD is not declared an exact release',()=>{const x=statusText({...sample(),channel:'development',fixed_release:false});assert.match(x.detail,/启动快照/);});
test('source change requires explicit restart without clearing drafts',()=>{const x=statusText({...sample(),restart_required:true});assert.equal(x.warning,true);assert.match(x.disk,/不会热更新/);});
test('failure is not green',()=>assert.throws(()=>statusText({...sample(),success:false})));
test('different service rejected',()=>assert.throws(()=>statusText({...sample(),product:'other'})));
test('unknown version rejected',()=>assert.throws(()=>statusText({...sample(),schema_version:2})));
test('unknown channel rejected',()=>assert.throws(()=>statusText({...sample(),channel:'live'})));
test('same port does not imply same process',()=>assert.throws(()=>statusText({...sample(),instance_id:''})));
test('long invalid text rejected',()=>assert.throws(()=>statusText({...sample(),version:'x'.repeat(1000)})));
test('absence of Git identity stays unknown',()=>assert.equal(statusText({...sample(),fixed_release:false,verified_at_start:false,commit_describes_payload:false,channel:'development',source_commit:null}).commit,'未知'));
test('fixed release without exact commit rejected',()=>assert.throws(()=>statusText({...sample(),source_commit:null})));
test('fixed release without payload hash rejected',()=>assert.throws(()=>statusText({...sample(),payload_sha256:'unknown'})));
test('fixed release without exact payload provenance rejected',()=>assert.throws(()=>statusText({...sample(),commit_describes_payload:false})));
test('wrong format state group rejected',()=>assert.throws(()=>statusText({...sample(),state_id:{id:'confused'}})));
test('instance identity must be exact hex',()=>assert.throws(()=>statusText({...sample(),instance_id:'-'.repeat(32)})));

const workspace=()=>({...sample(),product:'clw-web-workspace',channel:'candidate',source_kind:'frozen_current_worktree',
  commit_describes_payload:false,build_id:'20261004T160000Z-'+'d'.repeat(12)+'-'+'e'.repeat(8),manifest_sha256:'f'.repeat(64)});
test('workspace fixed snapshot preserves dirty bytes without claiming HEAD equality',()=>{
  const result=statusText(workspace());assert.match(result.detail,/冻结源码/);assert.match(result.detail,/来源提交不等于冻结内容/);
});
test('workspace source assertion cannot be replaced by legacy commit equality',()=>assert.throws(()=>statusText({...workspace(),commit_describes_payload:true})));
test('workspace snapshot requires exact manifest and build identity',()=>{
  for(const field of ['build_id','manifest_sha256'])assert.throws(()=>statusText({...workspace(),[field]:'wrong'}));
});
test('workspace release cannot claim unobserved source kind',()=>assert.throws(()=>statusText({...workspace(),source_kind:'head_only'})));
