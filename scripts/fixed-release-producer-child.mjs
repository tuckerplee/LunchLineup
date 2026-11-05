// Private installed owner entry; no candidate CLI/default environment authority.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { produceDisposableReleaseArtifacts } from './produce-disposable-release-artifacts.mjs';
const [path,sha]=process.argv.slice(2);
if(process.argv.length!==4||typeof path!=='string'||!/^\/var\/lib\/custom-ci\/runs\/[0-9]{8}T[0-9]{6}Z-lunchlineup-[a-f0-9]{8}-[a-f0-9]{6}\/producer-control\/request.json$/.test(path))throw new Error('Fixed owner request required.');
const st=lstatSync(path),bytes=readFileSync(path);
if(realpathSync(path)!==path||!st.isFile()||st.uid!==0||st.gid!==0||(st.mode&0o777)!==0o444||st.nlink!==1||bytes.length!==st.size||bytes.length>1048576||createHash('sha256').update(bytes).digest('hex')!==sha)throw new Error('Protected request differs.');
const request=JSON.parse(bytes);
if(process.getuid()!==request.uid||process.geteuid()!==request.uid||request.uid<=0||process.getgid()!==request.gid||process.getegid()!==request.gid||request.gid<=0)throw new Error('Nonroot producer identity differs.');
request.options.env={...request.options.env,RELEASE_PRODUCER_REQUEST:path,RELEASE_PRODUCER_REQUEST_SHA256:sha};
await produceDisposableReleaseArtifacts(request.options);
// Full output lives in the independently selected evidence root. This small
// terminal summary is deliberately neither admission nor recursive settlement.
process.stdout.write(JSON.stringify({runId:request.runId,producerCompleted:true,admission:false,qualification:false,recursiveSettlement:false})+'\n');
