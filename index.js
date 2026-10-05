import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './db.js';
import {createApp} from './app.js';
import {deliverNotifications} from './notifications.js';
const apiEnvFile=fileURLToPath(new URL('./.env',import.meta.url));
if(existsSync(apiEnvFile))process.loadEnvFile(apiEnvFile);
if (process.env.NODE_ENV==='production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<48) throw Error('Production requires SESSION_SECRET of at least 48 characters.');
  const appOrigins=String(process.env.APP_ORIGIN||'').split(',').map(value=>value.trim()).filter(Boolean);
  if (!appOrigins.length || appOrigins.some(origin=>!origin.startsWith('https://'))) throw Error('Production requires one or more HTTPS APP_ORIGIN values.');
  if (!process.env.MONGODB_URI) throw Error('Production requires MONGODB_URI.');
}
let db;
try{
  db=await openDatabase();
}catch(error){
  console.error('MongoDB connection failed. Check MONGODB_URI and the Atlas Network Access list.',error.name||'ConnectionError');
  process.exit(1);
}
const server=createApp(db).listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log('Prism server ready.'));
server.requestTimeout=30000;
let delivering=false;
const deliver=async()=>{if(delivering)return;delivering=true;try{await deliverNotifications(db);}catch{console.error('Notification worker could not complete.');}finally{delivering=false;}};
const timer=setInterval(deliver,30000);timer.unref();deliver();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(async()=>{await db.close();process.exit(0);});});

