import { readPrivateTargetProfile, validatePrivateTargetProfile, assertPrivateTargetBinding } from './private-target-profile.mjs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { readRegularEvidenceSnapshot, stableJson, writeExclusiveJson } from './internal-ci-evidence.mjs';
export async function verifyInternalBetaPublicBuild({sourceContext,contractPath,configPath,detailsPath,expectedSource,env=process.env,privateTargetProfile}) {
const privateTarget=validatePrivateTargetProfile(privateTargetProfile);
const context=readInternalCiSourceContext(resolve(sourceContext),{expectedSource,env});
contractPath=resolve(contractPath);configPath=resolve(configPath);detailsPath=resolve(detailsPath);
const contractItem=readRegularEvidenceSnapshot(contractPath,context.evidenceRoot),configItem=readRegularEvidenceSnapshot(configPath,context.evidenceRoot),config=JSON.parse(configItem.bytes),contract=JSON.parse(contractItem.bytes); const expected={sourceSha:context.sourceSha,publicBuildConfigSha256:config.sha256,nextPublicApiUrl:'/api/v2',nextPublicAppOrigin:privateTarget.origin,nextPublicAppUrl:privateTarget.origin,nextPublicAppEnv:'production',nextPublicSignupMode:'closed_beta',nextPublicOidcEnabled:'false',nextPublicTurnstileSiteKey:'',nextPublicPrivacyContactEmail:'privacy@lunchlineup.com',nextPublicSupportContactEmail:'support@lunchlineup.com',nextPublicDpaContactEmail:'privacy@lunchlineup.com'};
assertPrivateTargetBinding(config.privateTarget, privateTarget);
const expectedValues={NEXT_PUBLIC_API_URL:'/api/v2',NEXT_PUBLIC_APP_ORIGIN:privateTarget.origin,NEXT_PUBLIC_APP_URL:privateTarget.origin,NEXT_PUBLIC_APP_ENV:'production',NEXT_PUBLIC_SIGNUP_MODE:'closed_beta',NEXT_PUBLIC_OIDC_ENABLED:'false'}, expectedConfigSha=createHash('sha256').update(stableJson(expectedValues)).digest('hex');
if(config.version!==1||config.kind!=='lunchlineup-internal-beta-public-build-config'||config.sourceSha!==context.sourceSha||stableJson(config.values)!==stableJson(expectedValues)||config.sha256!==expectedConfigSha||stableJson(contract)!==stableJson(expected)) throw new Error('Web image public-build contract mismatch.');
if(!readRegularEvidenceSnapshot(contractPath,context.evidenceRoot).bytes.equals(contractItem.bytes)||!readRegularEvidenceSnapshot(configPath,context.evidenceRoot).bytes.equals(configItem.bytes))throw new Error('Validated public build inputs changed before publication.');
writeExclusiveJson(detailsPath,{sourceSha:context.sourceSha,treeSha:context.treeSha,publicBuildConfigSha256:config.sha256,contract:{path:contractItem.path,sha256:createHash('sha256').update(contractItem.bytes).digest('hex'),bytes:contractItem.bytes.length},values:config.values},{root:context.evidenceRoot});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),one=(f)=>{const i=args.indexOf(f);return i<0?'':args[i+1]??'';};
 const selected=readPrivateTargetProfile();
 const privateTargetProfile=Object.fromEntries(['version','kind','targetId','origin','expectedHostname','machineId'].map(key=>[key,selected[key]]));
 await verifyInternalBetaPublicBuild({sourceContext:one('--source-context'),contractPath:one('--contract'),configPath:one('--public-build-config'),detailsPath:one('--details'),privateTargetProfile});
}
