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
