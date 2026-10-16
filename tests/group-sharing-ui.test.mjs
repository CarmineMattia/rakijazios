import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)(process.env.RAKAZO_JSDOM_PATH || 'jsdom');
const script = readFileSync(process.env.RAKAZO_SHARING_OVERLAY || new URL('../patches/web/dist/group-sharing-overlay.js', import.meta.url), 'utf8');
const response = (data, status=200) => ({ ok:status===200, status, json:async()=>data });
async function until(predicate) { for(let n=0;n<100;n++){ if(predicate()) return; await new Promise(r=>setTimeout(r,10)); } assert.fail('UI did not reach expected state'); }
async function fixture(fetch) {
  const dom=new JSDOM('<div id="rk-invite-root" class="rk-open"><div class="rk-card"></div></div>',{url:'http://localhost:5173/app/test',runScripts:'outside-only'});
  const observers=[], Observer=dom.window.MutationObserver;
  dom.window.MutationObserver=class extends Observer { constructor(cb){super(cb);observers.push(this);} };
  dom.window.fetch=(path, options)=>path.startsWith('/api/local-runners/groups/')
    ? Promise.resolve(response({bots:[]})) : fetch(path, options);
  dom.window.eval(script);
  await until(()=>dom.window.document.querySelector('[data-rk-group-sharing] button'));
  return { dom, doc:dom.window.document, close:async()=>{observers.forEach(o=>o.disconnect());dom.window.close();await Promise.resolve();} };
}
const group={id:'g',name:'Team',owned:true,bots:['Alpha','Beta']};
const messages={name:'Team',messages:[{id:'m',seq:1,author:'Alpha',text:'Hello'}],active:[]};
test('pending sends block duplicates and retries keep the same nonce',async()=>{
  const sends=[]; let resolveSend;
  const f=await fixture(async(path,options)=>{
    if(path.endsWith('/groups')) return response({groups:[group]});
    if(!options.method) return response(messages);
    sends.push(JSON.parse(options.body)); return new Promise(resolve=>{resolveSend=resolve;});
  });
  try {
    [...f.doc.querySelectorAll('button')].find(b=>b.textContent==='Open').click();
    await until(()=>f.doc.querySelector('.rk-group-message'));
    const form=f.doc.querySelector('#rk-group-dialog form'), input=form.querySelector('textarea'), send=form.querySelector('button');
    input.value='Hello bots'; form.requestSubmit();form.requestSubmit();
    assert.equal(sends.length,1);assert.equal(send.disabled,true);assert.equal(input.disabled,true);
    resolveSend(response({error:'Temporary failure'},500));await until(()=>!send.disabled);
    assert.equal(input.value,'Hello bots');form.requestSubmit();assert.equal(sends.length,2);
    assert.equal(sends[0].clientNonce,sends[1].clientNonce);
    resolveSend(response({ok:true}));await until(()=>!send.disabled);assert.equal(input.value,'');
  } finally { await f.close(); }
});
test('a revoked send clears history and disables the composer',async()=>{
  const f=await fixture(async(path,options)=>path.endsWith('/groups')?response({groups:[group]}):options.method?response({error:'Group not found or access revoked'},404):response(messages));
  try {
    [...f.doc.querySelectorAll('button')].find(b=>b.textContent==='Open').click(); await until(()=>f.doc.querySelector('.rk-group-message'));
    const form=f.doc.querySelector('#rk-group-dialog form');form.querySelector('textarea').value='Test';form.requestSubmit();
    await until(()=>f.doc.querySelector('[role=status]').textContent.includes('revoked'));
    assert.equal(f.doc.querySelectorAll('.rk-group-message').length,0);assert.equal(form.querySelector('textarea').disabled,true);assert.equal(form.querySelector('button').disabled,true);
  } finally { await f.close(); }
});
test('sharing requires choosing a person and can be revoked',async()=>{
  const grants=[];
  const f=await fixture(async(path,options)=>{
    if(path.endsWith('/groups'))return response({groups:[group]});
    if(!options.method)return response({people:[{userId:'colleague',name:'Colleague',shared:false}]});
    grants.push(JSON.parse(options.body));return response({ok:true});
  });
  try {
    [...f.doc.querySelectorAll('button')].find(b=>b.textContent==='Manage sharing').click();
    await until(()=>[...f.doc.querySelectorAll('button')].some(b=>b.textContent==='Share group'));
    assert.equal(grants.length,0);
    [...f.doc.querySelectorAll('button')].find(b=>b.textContent==='Share group').click();await until(()=>grants.length===1 && [...f.doc.querySelectorAll('button')].some(b=>b.textContent==='Revoke access'));
    assert.deepEqual(grants[0],{userId:'colleague',shared:true});
    [...f.doc.querySelectorAll('button')].find(b=>b.textContent==='Revoke access').click();await until(()=>grants.length===2);assert.deepEqual(grants[1],{userId:'colleague',shared:false});
  } finally { await f.close(); }
});
test('tool turns render readable activity, and members are not told to open the original',async()=>{
  const history={name:'Team',active:[],messages:[
    {id:'a',seq:1,author:'Alpha',text:'',activity:['Used tools: Shell · done in 3s']},
    {id:'b',seq:2,author:'Alpha',text:'Here you go',activity:['Handed off to Beta']},
    {id:'c',seq:3,author:'Beta',text:'',activity:[]},
  ]};
  for (const owned of [false,true]) {
    const f=await fixture(async(path)=>path.endsWith('/groups')?response({groups:[{...group,owned}]}):response(history));
    try {
      [...f.doc.querySelectorAll('button')].find(b=>b.textContent==='Open').click();
      await until(()=>f.doc.querySelectorAll('.rk-group-message').length===3);
      const rows=[...f.doc.querySelectorAll('.rk-group-message')].map(r=>r.textContent);
      assert.match(rows[0],/Used tools: Shell · done in 3s/);
      assert.match(rows[1],/Here you go/);assert.match(rows[1],/Handed off to Beta/);
      assert.equal(f.doc.body.textContent.includes('Non-text message'),false);
      if(owned) assert.match(rows[2],/Open the group from your chat list/);
      else { assert.match(rows[2],/No text in this turn\./); assert.equal(/open/i.test(rows[2]),false); }
    } finally { await f.close(); }
  }
});
