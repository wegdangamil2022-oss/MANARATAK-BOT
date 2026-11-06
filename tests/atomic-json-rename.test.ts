import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renameStateAtomically} from '../src/atomic-json-rename.js';
const failure=(code:string)=>Object.assign(new Error(code),{code});
test('Windows transient rename failures retry the same atomic operation in a bounded sequence',async()=>{
 let calls=0;const waits:number[]=[];
 await renameStateAtomically('state.tmp','state',async(from,to)=>{assert.equal(from,'state.tmp');assert.equal(to,'state');if(++calls<4)throw failure('EPERM');},'win32',async ms=>{waits.push(ms);});
 assert.equal(calls,4);assert.deepEqual(waits,[10,30,80]);
});
test('permanent failures and non-Windows errors are propagated without deleting or replacing the destination',async()=>{
 let calls=0;await assert.rejects(renameStateAtomically('state.tmp','state',async()=>{calls++;throw failure('EPERM');},'win32',async()=>{}),/EPERM/u);assert.equal(calls,6);
 calls=0;await assert.rejects(renameStateAtomically('state.tmp','state',async()=>{calls++;throw failure('EIO');},'win32',async()=>{}),/EIO/u);assert.equal(calls,1);
 calls=0;await assert.rejects(renameStateAtomically('state.tmp','state',async()=>{calls++;throw failure('EPERM');},'linux',async()=>{}),/EPERM/u);assert.equal(calls,1);
});
