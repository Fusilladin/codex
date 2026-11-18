import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scanBytes} from '../fork/lib/canary.mjs';
import {sha256} from '../fork/lib/manifest.mjs';
import {temp} from './helpers.mjs';

test('privacy refusals identify rules and stale pins without emitting content, paths or private patterns',async t=>{
  function diagnostic(scan,bytes,options,ruleId,secret) {
    let error;try{scan(bytes,options);}catch(e){error=e;}
    assert.ok(error,'matched bytes must still be refused');
    assert.equal(error.state,'invalid-input');
    assert.ok(error.message.startsWith('Canary or sensitive content refused (value redacted); '));
    assert.ok(!error.message.includes(secret),'matched value must stay redacted');
    const data=JSON.parse(error.message.split('; ')[1]);
    assert.equal(data.ruleId,ruleId);assert.equal(data.artifactSha256,sha256(bytes));
    assert.match(data.matchSha256,/^[a-f0-9]{64}$/);assert.match(data.ruleSha256,/^[a-f0-9]{64}$/);
    return data;
  }
  const token='sk-'+'SyntheticFixtureOnly'.repeat(2),body=Buffer.from(token);
  const bytes=Buffer.concat([Buffer.from([255]),body]),options={name:'bin/codex'};
  const first=diagnostic(scanBytes,bytes,options,'token-like-sk',token);
  assert.equal(first.offset,1);assert.equal(first.length,body.length);assert.equal(first.matchSha256,sha256(body));
  assert.equal(first.file,'bin/codex');assert.equal(first.policyStatus,'no-exact-entry');
  const privateName='SyntheticPrivateFilename';
  assert.equal(diagnostic(scanBytes,bytes,{name:privateName},'token-like-sk',privateName).file,'other');
  for(const [ruleId,value] of [
    ['home-path',['','home','SyntheticFixture'].join('/')],
    ['token-like-github','ghp_'+'SyntheticFixtureOnly'.repeat(2)],
    ['private-key',['-----BEGIN','PRIVATE KEY-----'].join(' ')],
    ['synthetic-canary','FORK_SECRET_CANARY_'+'SyntheticFixture'],
  ]) diagnostic(scanBytes,Buffer.from(value),{},ruleId,value);

  const root=temp(t);mkdirSync(join(root,'lib'));
  for(const file of ['canary.mjs','manifest.mjs'])copyFileSync(new URL('../fork/lib/'+file,import.meta.url),join(root,'lib',file));
  const old=Buffer.concat([Buffer.from('old'),body]);
  const match={kind:'tokenLike',offset:3,length:body.length,sha256:sha256(body)};
  const proofBody={artifactSha256:sha256(old),classification:'upstream-non-secret-literal',file:'bin/codex',match,upstreamCommit:'a'.repeat(40)};
  const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]))):value;
  const proofSha256=sha256(JSON.stringify(canonical(proofBody)));
  const {match:unused,...entryBody}=proofBody;
  writeFileSync(join(root,'privacy-literals.json'),JSON.stringify({schema:1,entries:[{...entryBody,...match,proofSha256}]}));
  writeFileSync(join(root,'privacy-literal-proofs.json'),JSON.stringify({complete:true,unresolved:[],proofs:[{...proofBody,proofSha256}]}));
  const module=await import(pathToFileURL(join(root,'lib/canary.mjs')).href);
  assert.doesNotThrow(()=>module.scanBytes(old,options));
  assert.equal(diagnostic(module.scanBytes,bytes,options,'token-like-sk',token).policyStatus,'artifact-pin-mismatch');
  const privatePattern='SyntheticOwner'+'Pattern';
  const blocklist=join(root,'private-blocklist');writeFileSync(blocklist,privatePattern);
  const previous=process.env.FORKCTL_BLOCKLIST;
  try {
    process.env.FORKCTL_BLOCKLIST=blocklist;
    const data=diagnostic(module.scanBytes,Buffer.from(privatePattern),options,'owner-pattern',privatePattern);
    assert.equal(data.ruleSha256,sha256(privatePattern));
  } finally {
    if(previous===undefined)delete process.env.FORKCTL_BLOCKLIST;else process.env.FORKCTL_BLOCKLIST=previous;
  }
});
