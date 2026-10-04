import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createMailTransport, enquiryMailConfigured} from '../notifications.js';

const envFile=fileURLToPath(new URL('../.env',import.meta.url));
if(existsSync(envFile))process.loadEnvFile(envFile);

if(!enquiryMailConfigured()){
  console.error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and MAIL_FROM.');
  process.exit(1);
}

const transport=createMailTransport();
try{
  await transport.verify();
  console.log('SMTP connection and authentication succeeded.');
}catch(error){
  console.error('SMTP verification failed.',{code:error?.code||'unknown',command:error?.command||'unknown',responseCode:error?.responseCode||0});
  process.exitCode=1;
}finally{
  transport.close();
}
