import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { sha256File, statRegularEvidenceFile, writeExclusiveJson } from './internal-ci-evidence.mjs';
const args=process.argv.slice(2),one=(f)=>{const i=args.indexOf(f);return i<0?'':args[i+1]??'';}; const context=readInternalCiSourceContext(resolve(one('--source-context'))), contractPath=resolve(one('--contract')), configPath=resolve(one('--public-build-config')), detailsPath=resolve(one('--details'));
const contractItem=statRegularEvidenceFile(contractPath,context.evidenceRoot), config=JSON.parse(readFileSync(configPath,'utf8')), contract=JSON.parse(readFileSync(contractPath,'utf8')); const expected={sourceSha:context.sourceSha,publicBuildConfigSha256:config.sha256,nextPublicApiUrl:'/api/v2',nextPublicAppOrigin:'https://beta.lunchlineup.com',nextPublicAppUrl:'https://beta.lunchlineup.com',nextPublicAppEnv:'production',nextPublicSignupMode:'closed_beta'};
if(config.version!==1||config.kind!=='lunchlineup-internal-beta-public-build-config'||config.sourceSha!==context.sourceSha||JSON.stringify(contract)!==JSON.stringify(expected)) throw new Error('Web image public-build contract mismatch.');
writeExclusiveJson(detailsPath,{sourceSha:context.sourceSha,treeSha:context.treeSha,publicBuildConfigSha256:config.sha256,contract:{path:contractItem.path,sha256:await sha256File(contractPath,context.evidenceRoot),bytes:contractItem.bytes},values:config.values},{root:context.evidenceRoot});
