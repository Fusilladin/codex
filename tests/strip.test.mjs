import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {temp,manifest} from './helpers.mjs';
import {sha256,candidateKey} from '../fork/lib/manifest.mjs';
import {stripArtifacts,verifiedStripped} from '../fork/lib/strip-artifacts.mjs';
test('deterministic strip preserves raw bytes and rejects transformed bytes or binding tampering',t=>{
 const root=temp(t),attempt=randomUUID(),dir=join(root,'build-attempts',attempt),m={...manifest('a'.repeat(40)),production_ready:true,lockfile_sha256:'b'.repeat(64)},key=candidateKey(m);
 mkdirSync(join(dir,'artifacts'),{recursive:true});mkdirSync(join(root,'candidates'));
 const artifacts=m.bins.map(bin=>{const path=join(dir,'artifacts',bin);copyFileSync('/usr/bin/true',path);return {bin,path,sha256:sha256(readFileSync(path))};});
 // Synthetic receipt around an actual system ELF; this test is fixture evidence.
 const receipt={id:attempt,key,state:'validated',executionKind:'host',inputHash:sha256(JSON.stringify(m)),refreshedLockHash:m.lockfile_sha256,artifacts};
 writeFileSync(join(dir,'attempt.json'),JSON.stringify(receipt));
 const candidate={key,manifest:m,inputHash:receipt.inputHash,lastValidatedAttempt:attempt,validatedReceiptHash:sha256(JSON.stringify(receipt))};
 writeFileSync(join(root,'candidates',key+'.json'),JSON.stringify(candidate));
 const result=stripArtifacts({stateRoot:root,attempt});assert.equal(result.deterministic,true);assert.equal(verifiedStripped(root,attempt).artifacts.length,3);
 for(const a of artifacts)assert.equal(sha256(readFileSync(a.path)),a.sha256);
 const processed=result.artifacts[0],before=readFileSync(processed.path);writeFileSync(processed.path,Buffer.concat([before,Buffer.from('tamper')]));assert.throws(()=>verifiedStripped(root,attempt),/mismatch/);writeFileSync(processed.path,before);
 const path=join(dir,'STRIP.json'),original=readFileSync(path);writeFileSync(path,JSON.stringify({...result,buildReceiptHash:'0'.repeat(64)}));assert.throws(()=>verifiedStripped(root,attempt),/receipt/);writeFileSync(path,original);
 const raw=artifacts[0];writeFileSync(raw.path,Buffer.concat([readFileSync(raw.path),Buffer.from('tamper')]));assert.throws(()=>verifiedStripped(root,attempt),/mismatch/);
});
