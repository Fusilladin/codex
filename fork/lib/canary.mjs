import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalid, sha256 } from './manifest.mjs';

// Every subtree is scanned. Negative tests assemble synthetic tokens at runtime.
// Private policy is injectable; passing a scan is not publication authorization.
const patterns = [ /\/home\//, /sk-[A-Za-z0-9_-]{16,}/, /gh[pousr]_[A-Za-z0-9_]{16,}/, /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, /FORK_SECRET_CANARY_[A-Za-z0-9]+/ ];
const ruleIds = ['home-path', 'token-like-sk', 'token-like-github', 'private-key', 'synthetic-canary'];
function canonical(value) {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const literalPath = new URL('../privacy-literals.json', import.meta.url);
function literals() {
  let policyLoaded=false;
  try {
    const policy = JSON.parse(readFileSync(literalPath, 'utf8'));
    policyLoaded=true;
    if (policy.schema !== 1 || !Array.isArray(policy.entries)) throw Error();
    if(policy.entries.length) {
      const report=JSON.parse(readFileSync(new URL('../privacy-literal-proofs.json',import.meta.url),'utf8'));
      if(report.complete!==true||!Array.isArray(report.proofs)||report.unresolved?.length)throw Error();
      for(const entry of policy.entries) {
        const proof=report.proofs.find(p=>p.proofSha256===entry.proofSha256);
        if(!proof)throw Error();
        const {proofSha256,...body}=proof;
        if(sha256(canonical(body))!==proofSha256||proof.file!==entry.file||proof.artifactSha256!==entry.artifactSha256||proof.upstreamCommit!==entry.upstreamCommit||proof.classification!==entry.classification||proof.match.kind!==entry.kind||proof.match.offset!==entry.offset||proof.match.length!==entry.length||proof.match.sha256!==entry.sha256||proof.match.patternSha256!==entry.patternSha256)throw Error();
      }
    }
    return policy.entries;
  } catch (error) {
    if (error.code === 'ENOENT'&&!policyLoaded) return [];
    throw invalid('Invalid exact literal policy (details redacted)');
  }
}
// Exact exceptions are evaluated per original match. No masked text, relaxed
// regex, credential-category exception, or name-wide exemption is accepted.
function approved(bytes, name, artifactSha256, entry, offset, length, digest) {
  return Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(length)&&length>0&&offset+length<=bytes.length&&/^bin\/(codex|codex-code-mode-host|codex-exec-server)$/.test(entry.file) && entry.file === name && entry.artifactSha256 === artifactSha256 && entry.offset === offset && entry.length === length && entry.sha256 === digest && entry.classification === 'upstream-non-secret-literal' && /^[a-f0-9]{40}$/.test(entry.upstreamCommit) && /^[a-f0-9]{64}$/.test(entry.proofSha256) && sha256(bytes.subarray(offset, offset+length)) === digest;
}
function refusedToken(bytes, name, entries) {
  const text=bytes.toString('latin1'),artifactSha256=sha256(bytes);
  for(const [index,pattern] of patterns.slice(1,3).entries()) {
    for(const match of text.matchAll(new RegExp(pattern.source,'g'))) {
      const offset=match.index,length=match[0].length,digest=sha256(bytes.subarray(offset,offset+length));
      if(!entries.some(e=>e.kind==='tokenLike'&&approved(bytes,name,artifactSha256,e,offset,length,digest)))return {ruleId:ruleIds[index+1],ruleSha256:sha256(pattern.source),offset,length,matchSha256:digest,policyStatus:entries.some(e=>e.kind==='tokenLike'&&e.file===name&&e.sha256===digest&&e.artifactSha256!==artifactSha256)?'artifact-pin-mismatch':'no-exact-entry'};
    }
  }
}
export function exactTokenLiterals(bytes, name, entries) {
  return !refusedToken(bytes,name,entries);
}
function refusedOwner(bytes, name, entries, patterns) {
  const text=bytes.toString('utf8'),artifactSha256=sha256(bytes);
  for(const {pattern,patternSha256} of patterns) {
    for(const match of text.matchAll(new RegExp(pattern.source,'gi'))) {
      const body=Buffer.from(match[0]),digest=sha256(body);
      // Decode the prefix at the known exact byte boundary; replacement decoding
      // means byte offsets cannot be inferred from UTF-16 regex indices.
      if(!entries.some(e=>e.kind==='ownerPattern'&&e.patternSha256===patternSha256&&approved(bytes,name,artifactSha256,e,e.offset,body.length,digest)&&bytes.subarray(0,e.offset).toString('utf8').length===match.index))return {ruleId:'owner-pattern',ruleSha256:patternSha256,length:body.length,matchSha256:digest,policyStatus:'no-exact-entry'};
    }
  }
}
export function exactOwnerLiterals(bytes, name, entries, patterns) {
  return !refusedOwner(bytes,name,entries,patterns);
}
export function scanBytes(bytes,{name}={}) {
  const text=bytes.toString('latin1');let extra=[];
  if(process.env.FORKCTL_BLOCKLIST) {
    try {
      extra=readFileSync(process.env.FORKCTL_BLOCKLIST,'utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')).map(line=>({pattern:new RegExp(line,'i'),patternSha256:sha256(line)}));
    }catch{throw invalid('Privacy blocklist unreadable or invalid (details redacted)');}
  }
  const entries=literals();
  let refusal;
  for(const index of [0,3,4]) {
    const match=patterns[index].exec(text);
    if(match){refusal={ruleId:ruleIds[index],ruleSha256:sha256(patterns[index].source),offset:match.index,length:match[0].length,matchSha256:sha256(bytes.subarray(match.index,match.index+match[0].length)),policyStatus:'no-exceptions'};break;}
  }
  refusal ??= refusedToken(bytes,name,entries);
  refusal ??= refusedOwner(bytes,name,entries,extra);
  if(refusal) {
    // Only fixed labels and digests cross the log boundary. Never include names,
    // regexes, matched bytes, surrounding content, or nested exception messages.
    const file=/^bin\/(codex|codex-code-mode-host|codex-exec-server)$/.test(name??'')?name:'other';
    throw invalid('Canary or sensitive content refused (value redacted); '+JSON.stringify({schema:1,file,artifactSha256:sha256(bytes),...refusal}));
  }
}
export function scanEntryName(name) {
  if (name.split(/[\\/]/).some(part => /^(?:auth\.json|credentials(?:\.json)?|sessions?|conversations?)$/i.test(part))) throw invalid('Sensitive entry refused (value redacted)');
}
export function scanTree(root) {
  // Validate configured policy even for an empty tree.
  scanBytes(Buffer.alloc(0));
  function walk(path, prefix = '') {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw invalid('Unsafe scan entry');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        scanEntryName(name); scanBytes(Buffer.from(name));
        walk(join(path, name), prefix ? `${prefix}/${name}` : name);
      }
    } else scanBytes(readFileSync(path), {name: prefix});
  }
  walk(root);
}
