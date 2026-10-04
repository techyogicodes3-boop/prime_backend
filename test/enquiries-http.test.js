import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../app.js';

test('accepts a URL-encoded enquiry without a JSON preflight', async t => {
  const smtpKeys=['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','MAIL_FROM'];
  const previous=Object.fromEntries(smtpKeys.map(key=>[key,process.env[key]]));
  smtpKeys.forEach(key=>delete process.env[key]);
  t.after(()=>smtpKeys.forEach(key=>previous[key]===undefined?delete process.env[key]:process.env[key]=previous[key]));

  const enquiries=[];
  const collection={
    async insertOne(record){enquiries.push(record)},
    async updateOne(filter,update){const record=enquiries.find(item=>item._id===filter._id);if(record&&update.$set)Object.assign(record,update.$set)},
  };
  const db={collection:()=>collection};
  const server=createApp(db).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));

  const address=server.address();
  const response=await fetch(`http://127.0.0.1:${address.port}/api/enquiries`,{
    method:'POST',
    headers:{Origin:'http://localhost:5173'},
    body:new URLSearchParams({name:'Test User',email:'test@example.com',phone:'9876543210',organization:'Test School',location:'Pune',topic:'Test',message:'This is an integration test enquiry.'}),
  });

  assert.equal(response.status,503);
  assert.equal(enquiries.length,1);
  assert.equal(enquiries[0].phone,'9876543210');
  assert.equal(enquiries[0].emailStatus,'awaiting_configuration');
});
