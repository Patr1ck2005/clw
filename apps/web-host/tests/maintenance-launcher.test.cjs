'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {exitFailure}=require('../../../scripts/quit_web_workspace_for_maintenance.cjs');
test('received IPC rejection survives a subsequent CDP disconnect',()=>{
 for(const text of ["page.evaluate: Error invoking remote method 'clw-command': Error: maintenance_jobs_active",'maintenance_original_store_changed','Maintenance exit was not accepted; original app retained','maintenance_jobs_active; Target page, context or browser has been closed'])assert.equal(exitFailure(Error(text)),'rejected');
});
test('only transport closure is an unknown receipt, never acceptance',()=>{
 assert.equal(exitFailure(Error('page.evaluate: Target page, context or browser has been closed'),{dispatched:true}),'unknown');
 assert.equal(exitFailure(Error('Browser has been closed'),{dispatched:true}),'unknown');
 for(const text of ['Expected exactly one original shell','readiness failed','Timeout 5000ms exceeded'])assert.equal(exitFailure(Error(text)),'rejected');
});
test('dispatched timeout or lost acknowledgement stays unknown even with a connected browser',()=>{
 for(const text of ['Timeout 5000ms exceeded','page.evaluate: Protocol error','Connection closed','unclassified acknowledgement failure'])assert.equal(exitFailure(Error(text),{dispatched:true}),'unknown');
 for(const text of ["page.evaluate: Error invoking remote method 'clw-command': Error: maintenance_jobs_active",'Maintenance exit was not accepted; original app retained'])assert.equal(exitFailure(Error(text),{dispatched:true}),'rejected');
 assert.equal(exitFailure(Error('Timeout 5000ms exceeded'),{dispatched:false}),'rejected');
});
