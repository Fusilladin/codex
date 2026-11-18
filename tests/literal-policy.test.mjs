import test from 'node:test';
import assert from 'node:assert/strict';
import {exactTokenLiterals,exactOwnerLiterals,scanBytes} from '../fork/lib/canary.mjs';
import {sha256} from '../fork/lib/manifest.mjs';
test('exact upstream literal exception binds whole artifact, entry name, offset and match digest',()=>{
 const token='sk-'+'PublicLiteralOnly'.repeat(2),bytes=Buffer.concat([Buffer.from([255]),Buffer.from('prefix '+token+' suffix')]);
 const entry={kind:'tokenLike',file:'bin/codex',artifactSha256:sha256(bytes),offset:8,length:token.length,sha256:sha256(Buffer.from(token)),classification:'upstream-non-secret-literal',upstreamCommit:'a'.repeat(40),proofSha256:'b'.repeat(64)};
 assert.equal(exactTokenLiterals(bytes,'bin/codex',[entry]),true);
 for(const changed of [{offset:9},{length:token.length-1},{sha256:'0'.repeat(64)},{artifactSha256:'0'.repeat(64)},{file:'NOTICE'},{classification:'credential'},{proofSha256:''}])assert.equal(exactTokenLiterals(bytes,'bin/codex',[{...entry,...changed}]),false);
 assert.equal(exactTokenLiterals(Buffer.concat([bytes,Buffer.from('mutation')]),'bin/codex',[entry]),false);
 assert.equal(exactTokenLiterals(bytes,'bin/codex-exec-server',[entry]),false);
 assert.throws(()=>scanBytes(bytes,{name:'bin/codex'}),/redacted/);
 for(const bad of [['','home','fixture'].join('/'),'FORK_SECRET_CANARY_'+'Fixture',['-----BEGIN','PRIVATE KEY-----'].join(' ')])assert.throws(()=>scanBytes(Buffer.from(bad)),/redacted/);
});

test('owner-pattern exceptions bind original UTF-8 match, private regex hash and exact artifact bytes',()=>{
 const bytes=Buffer.concat([Buffer.from([255,254]),Buffer.from('PublicTypeName')]),patternText='Type',patternSha256=sha256(patternText),pattern=new RegExp(patternText,'i');
 const entry={kind:'ownerPattern',file:'bin/codex',artifactSha256:sha256(bytes),offset:8,length:4,sha256:sha256(Buffer.from(patternText)),classification:'upstream-non-secret-literal',upstreamCommit:'a'.repeat(40),proofSha256:'b'.repeat(64),patternSha256};
 assert.equal(exactOwnerLiterals(bytes,'bin/codex',[entry],[{pattern,patternSha256}]),true);
 for(const change of [{offset:7},{patternSha256:'0'.repeat(64)},{sha256:'0'.repeat(64)},{kind:'tokenLike'}])assert.equal(exactOwnerLiterals(bytes,'bin/codex',[{...entry,...change}],[{pattern,patternSha256}]),false);
 assert.equal(exactOwnerLiterals(bytes,'bin/codex',[entry],[{pattern:new RegExp('Public'+patternText),patternSha256:sha256('Public'+patternText)}]),false);
});

test('loaded literal policy requires its exact source-proof digest before granting an exception',async t=>{
 const {mkdirSync,copyFileSync,writeFileSync}=await import('node:fs');
 const {join}=await import('node:path');
 const {pathToFileURL}=await import('node:url');
 const {temp}=await import('./helpers.mjs');
 const root=temp(t);mkdirSync(join(root,'lib'));
 for(const file of ['canary.mjs','manifest.mjs'])copyFileSync(new URL('../fork/lib/'+file,import.meta.url),join(root,'lib',file));
 const token='sk-'+'PublicFixtureLiteral'.repeat(2),bytes=Buffer.from(token),match={kind:'tokenLike',offset:0,length:bytes.length,sha256:sha256(bytes)};
 const body={artifactSha256:sha256(bytes),classification:'upstream-non-secret-literal',file:'bin/codex',match,upstreamCommit:'a'.repeat(40)};
 const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]))):value;
 const proofSha256=sha256(JSON.stringify(canonical(body))),entry={...match,...body,proofSha256};delete entry.match;
 writeFileSync(join(root,'privacy-literals.json'),JSON.stringify({schema:1,entries:[entry]}));
 const report={complete:true,unresolved:[],proofs:[{...body,proofSha256}]};
 writeFileSync(join(root,'privacy-literal-proofs.json'),JSON.stringify(report));
 const module=await import(pathToFileURL(join(root,'lib/canary.mjs')).href);
 assert.doesNotThrow(()=>module.scanBytes(bytes,{name:'bin/codex'}));
 report.proofs[0].classification='unreviewed';writeFileSync(join(root,'privacy-literal-proofs.json'),JSON.stringify(report));
 assert.throws(()=>module.scanBytes(bytes,{name:'bin/codex'}),/Invalid exact literal policy/);
});

test('a proven literal never exempts an adjacent sk credential or another artifact',async t=>{
 const {mkdirSync,copyFileSync,writeFileSync}=await import('node:fs');
 const {join}=await import('node:path');
 const {pathToFileURL}=await import('node:url');
 const {temp}=await import('./helpers.mjs');
 const root=temp(t);mkdirSync(join(root,'lib'));
 for(const file of ['canary.mjs','manifest.mjs'])copyFileSync(new URL('../fork/lib/'+file,import.meta.url),join(root,'lib',file));
 const literal=Buffer.from('sk-'+'PublicFixtureLiteral'.repeat(2));
 const options={name:'bin/codex'};
 const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]))):value;
 function pin(bytes) {
  const match={kind:'tokenLike',offset:1,length:literal.length,sha256:sha256(literal)};
  const body={artifactSha256:sha256(bytes),classification:'upstream-non-secret-literal',file:options.name,match,upstreamCommit:'a'.repeat(40)};
  const proofSha256=sha256(JSON.stringify(canonical(body)));
  const {match:unused,...entryBody}=body;
  writeFileSync(join(root,'privacy-literals.json'),JSON.stringify({schema:1,entries:[{...entryBody,...match,proofSha256}]}));
  writeFileSync(join(root,'privacy-literal-proofs.json'),JSON.stringify({complete:true,unresolved:[],proofs:[{...body,proofSha256}]}));
 }
 const module=await import(pathToFileURL(join(root,'lib/canary.mjs')).href);
 const clean=Buffer.concat([Buffer.from([255]),literal,Buffer.from([0])]);pin(clean);
 assert.doesNotThrow(()=>module.scanBytes(clean,options));
 const prefix='sk-';
 // Inert synthetic keys with legacy, project and service-account shapes.
 for(const key of [prefix+'A7b9C2d4E6f8G0h1'.repeat(3),prefix+'proj-'+'A7b9C2d4E6f8G0h1'.repeat(9),prefix+'svcacct-'+'A7b9C2d4E6f8G0h1'.repeat(9)]) {
  const bytes=Buffer.concat([clean,Buffer.from(key)]);
  // Rebind the harmless literal to the complete contaminated artifact: a stale
  // artifact pin cannot be the reason the second match is refused.
  pin(bytes);
  assert.throws(()=>module.scanBytes(bytes,options),error=>{
   assert.ok(!error.message.includes(key),'credential bytes must stay redacted');
   const data=JSON.parse(error.message.split('; ')[1]);
   assert.equal(data.ruleId,'token-like-sk');assert.equal(data.offset,clean.length);
   assert.equal(data.matchSha256,sha256(Buffer.from(key)));
   return true;
  });
 }
 pin(clean);
 assert.throws(()=>module.scanBytes(Buffer.concat([clean,Buffer.from([0])]),options),/redacted/);
 assert.throws(()=>module.scanBytes(clean,{name:'bin/codex-exec-server'}),/redacted/);
 // The same public match relocated within an otherwise plausible binary fails.
 assert.throws(()=>module.scanBytes(Buffer.concat([Buffer.from([0]),clean]),options),/redacted/);
});
