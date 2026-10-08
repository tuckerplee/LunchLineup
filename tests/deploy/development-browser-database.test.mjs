import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDatabaseObservation as validate } from '../../scripts/check-development-browser-database.mjs';
const fresh={database:'lunchlineup_ci',role:'lunchlineup_ci_admin',system:'7399913421352615182',recovery:false,relations:0};
const role={database:'lunchlineup_ci',role:'lunchlineup_ci_app',superuser:false,bypassrls:false,createrole:false,createdb:false,replication:false};
test('fresh disposable database and restricted actual login accepted',()=>{validate('before',fresh);validate('role',role);});
for(const [key,value] of [['relations',1],['relations','0'],['role','postgres'],['database','other'],['recovery',true],['system',''],['system',123],['system','0']])
 test(`fresh database rejects ${key}=${value}`,()=>assert.throws(()=>validate('before',{...fresh,[key]:value})));
for(const key of ['superuser','bypassrls','createrole','createdb','replication'])
 test(`app role refuses ${key}`,()=>assert.throws(()=>validate('role',{...role,[key]:true})));
test('incomplete/extra rows, wrong role/database and unknown mode refuse',()=>{
 for(const value of [{...role,role:'lunchlineup_ci_admin'},{...role,database:'other'},{...role,extra:false},[],null,{}])assert.throws(()=>validate('role',value));
 assert.throws(()=>validate('after',fresh));
});
