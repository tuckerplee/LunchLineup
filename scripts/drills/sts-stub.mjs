// Local drill only. MinIO does not implement AWS STS GetCallerIdentity, which
// scripts/backup.sh uses to record the authenticated uploader principal. This
// stub answers only that action; everything else is rejected. Production uses
// the real AWS STS endpoint and never runs this file.
import { createServer } from 'node:http';

const arn = process.env.DRILL_STS_ARN ?? 'arn:aws:iam::000000000000:user/ll-drill-backup-writer';
const port = Number(process.env.DRILL_STS_PORT ?? 8080);

createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    if (!/(^|&)Action=GetCallerIdentity(&|$)/.test(body)) {
      response.writeHead(400, { 'content-type': 'text/xml' });
      response.end('<ErrorResponse><Error><Code>InvalidAction</Code></Error></ErrorResponse>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/xml' });
    response.end(
      '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">'
      + `<GetCallerIdentityResult><Arn>${arn}</Arn><UserId>AIDADRILL000000000000</UserId>`
      + '<Account>000000000000</Account></GetCallerIdentityResult>'
      + '<ResponseMetadata><RequestId>drill-sts-stub</RequestId></ResponseMetadata>'
      + '</GetCallerIdentityResponse>',
    );
  });
}).listen(port, '0.0.0.0');
