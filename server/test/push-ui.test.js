import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ResultsService} from '../src/results.js';
import {sseEventWire} from '../src/api.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(ROOT,name),'utf8');

test('results service exposes change notifications for push UI invalidation',()=>{
  const state={history:[],events:[]};
  const service=new ResultsService(state,state);
  let received=null;
  const off=service.onChange(change=>{received=change;});
  service.emitChange({type:'day-updated',date:'2026-09-29',count:3,at:123});
  assert.equal(received.date,'2026-09-29');
  assert.equal(received.count,3);
  assert.equal(received.at,123);
  off();received=null;service.emitChange({date:'x'});assert.equal(received,null);
});

test('single feed stream carries UI invalidations without a polling endpoint',()=>{
  const api=read('src/api.js');
  assert.match(api,/\['live','prematch','results','history','leagues'\]/);
  assert.match(api,/sseEventWire\(['"]ui-invalidate['"]\s*,\s*payload\)/);
  assert.match(api,/resultsService\?\.onChange/);
  assert.match(api,/broadcastUi\('history'/);
  assert.match(api,/broadcastUi\('leagues'/);
});


test('SSE hello frame is a complete event, not a raw hello token',()=>{
  const wire=sseEventWire('hello',{features:{uiPush:1},ui:{results:{revision:7}}});
  assert.match(wire,/^event: hello\n/);
  assert.match(wire,/\ndata: \{.*"uiPush":1.*\}\n\n$/);
  const blocks=wire.split(/\r?\n\r?\n/).filter(Boolean);
  assert.equal(blocks.length,1);
  const api=read('src/api.js');
  assert.doesNotMatch(api,/writeSse\(res\s*,\s*['"]hello['"]\s*,/);
  assert.match(api,/writeSse\(res\s*,\s*sseEventWire\(['"]hello['"]\s*,\s*hello\)\)/);
});
