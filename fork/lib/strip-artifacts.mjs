import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256,invalid,validateManifest,candidateKey} from './manifest.mjs';
import {readJSON,atomicJSON} from './state.mjs';
const args = ['--strip-all','--enable-deterministic-archives'];
export function validatedBuild(stateRoot,attempt) {
  if(!/^[a-f0-9-]{36}$/.test(attempt??''))throw invalid('Invalid build attempt');
  const root=realpathSync(stateRoot),dir=join(root,'build-attempts',attempt),receipt=readJSON(join(dir,'attempt.json'));
  const candidate=receipt&&readJSON(join(root,'candidates',receipt.key+'.json'));
  if(!candidate||receipt.id!==attempt||receipt.state!=='validated'||receipt.executionKind!=='host'||candidate.lastValidatedAttempt!==attempt||candidate.validatedReceiptHash!==sha256(JSON.stringify(receipt))||candidate.inputHash!==receipt.inputHash||receipt.artifacts?.length!==3)throw invalid('Exact validated host receipt required');
  validateManifest(candidate.manifest);
  if(candidate.key!==receipt.key||candidateKey(candidate.manifest)!==receipt.key||sha256(JSON.stringify(candidate.manifest))!==receipt.inputHash||receipt.refreshedLockHash!==candidate.manifest.lockfile_sha256)throw invalid('Strip input identity mismatch');
  for(const a of receipt.artifacts){
    const path=join(dir,'artifacts',a.bin);
    if(!candidate.manifest.bins.includes(a.bin)||a.path!==path||realpathSync(path)!==path||!lstatSync(path).isFile()||lstatSync(path).nlink!==1||sha256(readFileSync(path))!==a.sha256)throw invalid('Frozen build artifact mismatch');
  }
  return {root,dir,receipt,candidate};
}
export function stripArtifacts({stateRoot,attempt}) {
  const {root,dir,receipt,candidate}=validatedBuild(stateRoot,attempt);
  const path=join(dir,'STRIP.json'),destination=join(dir,'stripped-artifacts'),repeat=join(dir,'strip-repeat');
  mkdirSync(destination);mkdirSync(repeat);
  const tool=realpathSync('/usr/bin/strip'),version=spawnSync(tool,['--version'],{encoding:'utf8'});
  if(version.status!==0)throw invalid('Strip tool unavailable');
  const toolSha256=sha256(readFileSync(tool)),artifacts=[];
  for(const a of receipt.artifacts){
    const outputs=[join(destination,a.bin),join(repeat,a.bin)];
    for(const output of outputs){
      const r=spawnSync(tool,[...args,'-o',output,a.path],{env:{PATH:process.env.PATH,LC_ALL:'C'},timeout:60000});
      if(r.status!==0||r.error||!lstatSync(output).isFile()||!(lstatSync(output).mode&0o111))throw invalid('Strip stage failed (details redacted)');
    }
    const hash=sha256(readFileSync(outputs[0]));
    if(hash!==sha256(readFileSync(outputs[1]))||sha256(readFileSync(a.path))!==a.sha256)throw invalid('Strip determinism or raw preservation failed');
    artifacts.push({bin:a.bin,path:outputs[0],rawSha256:a.sha256,rawBytes:lstatSync(a.path).size,sha256:hash,bytes:lstatSync(outputs[0]).size,repeatSha256:hash});
  }
  if(sha256(readFileSync(tool))!==toolSha256)throw invalid('Strip tool changed');
  const result={schema:1,state:'stripped',attempt,key:receipt.key,inputHash:receipt.inputHash,buildReceiptHash:candidate.validatedReceiptHash,tool:{path:tool,sha256:toolSha256,version:version.stdout.split('\n')[0]},args,deterministic:true,artifacts};
  writeFileSync(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  candidate.stripReceiptHash=sha256(JSON.stringify(result));atomicJSON(join(root,'candidates',receipt.key+'.json'),candidate);
  return result;
}
export function verifiedStripped(stateRoot,attempt){
  const {dir,receipt,candidate}=validatedBuild(stateRoot,attempt),stripped=readJSON(join(dir,'STRIP.json'));
  if(!stripped||stripped.state!=='stripped'||stripped.attempt!==attempt||stripped.key!==receipt.key||stripped.inputHash!==receipt.inputHash||stripped.buildReceiptHash!==candidate.validatedReceiptHash||candidate.stripReceiptHash!==sha256(JSON.stringify(stripped))||stripped.deterministic!==true||JSON.stringify(stripped.args)!==JSON.stringify(args)||stripped.artifacts?.length!==3)throw invalid('Bound deterministic strip receipt required');
  for(const a of receipt.artifacts){
    const processed=stripped.artifacts.find(b=>b.bin===a.bin),path=join(dir,'stripped-artifacts',a.bin);
    if(!processed||processed.rawSha256!==a.sha256||processed.path!==path||realpathSync(path)!==path||!lstatSync(path).isFile()||lstatSync(path).nlink!==1||sha256(readFileSync(path))!==processed.sha256||processed.sha256!==processed.repeatSha256||lstatSync(path).size!==processed.bytes)throw invalid('Stripped artifact mismatch');
  }
  return stripped;
}
