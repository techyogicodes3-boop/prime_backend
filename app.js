import {registerMaterials} from './materials.js';
import {existsSync} from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readListings,findListing,findListingBySubmissionKey,saveListing,deleteListing} from './db.js';
import {hashPassword,checkPassword,sessionFor,createSession,destroySession,cookie,createAdminToken,adminFromToken} from './auth.js';
import {defaults,options,textFields,validate,isVisible,publicRecord} from './contracts/properties-schema.js';
import {mailConfigured,whatsappNumber,whatsappLink,sendEnquiryEmail} from './notifications.js';
import {enquiryValidationError} from './enquiry-validation.js';
 
const frontendDist=fileURLToPath(new URL('../app/dist/',import.meta.url));
const propertyBase=['/api/properties','/api/Properties'];
// eslint-disable-next-line no-control-regex
const clean=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:10,fields:2,fieldSize:100000},fileFilter:(_req,file,done)=>['image/jpeg','image/png','image/webp'].includes(file.mimetype)?done(null,true):done(Object.assign(Error('Use JPEG, PNG or WebP images.'),{status:422,fields:{images:'Unsupported image type.'}}))}).array('images',10);
const uploadImage=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1,fields:2,fieldSize:100000},fileFilter:(_req,file,done)=>['image/jpeg','image/png','image/webp'].includes(file.mimetype)?done(null,true):done(Object.assign(Error('Use a JPEG, PNG or WebP image.'),{status:422,fields:{image:'Unsupported image type.'}}))}).single('image');
const limiter=(limit,windowMs)=>rateLimit({windowMs,limit,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many requests. Please try again later.'}});

export function createApp(db){
  if(!db)throw Error('MongoDB connection is required.');
  const app=express();
  app.disable('x-powered-by');
  if(process.env.TRUST_PROXY==='1')app.set('trust proxy',1);
  app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:{policy:'cross-origin'}}));
  app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.use(express.json({limit:'120kb'}));
  app.use('/api',(req,res,next)=>{
    const allowed=new Set([process.env.APP_ORIGIN||'http://localhost:5173']);
    if(process.env.NODE_ENV!=='production')allowed.add('http://127.0.0.1:5173').add('http://localhost:5173');
    const origin=req.headers.origin;
    if(origin&&!allowed.has(origin))return res.status(403).json({error:'Request origin is not permitted.'});
    if(origin){
      res.set('Access-Control-Allow-Origin',origin);
      res.set('Access-Control-Allow-Credentials','true');
      res.vary('Origin');
    }
    res.set('Access-Control-Allow-Methods','GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers','Content-Type, Idempotency-Key, X-CSRF-Token, Authorization');
    if(req.method==='OPTIONS')return res.sendStatus(204);
    next();
  });

  const requireSession=kind=>async(req,res,next)=>{
    req.session=await sessionFor(db,req);
    if(!req.session||req.session.kind!==kind||(kind==='admin'&&req.session.role!=='admin'))return res.status(401).json({error:'Please sign in.'});
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==req.session.csrf)return res.status(403).json({error:'Session verification failed. Refresh and try again.'});
    next();
  };
  const adminAuth=async(req,res,next)=>{
    req.admin=await adminFromToken(db,req);
    if(!req.admin)return res.status(401).json({error:'Please sign in.'});
    next();
  };
  const userAuth=requireSession('user');
  const dummyHash=hashPassword(randomBytes(32).toString('hex'));

  app.post('/api/admin/login',limiter(10,15*60*1000),async(req,res)=>{
    const username=clean(req.body?.email??req.body?.username).toLowerCase(),password=typeof req.body?.password==='string'?req.body.password:'';
    if(!password||!username||password.length>256||username.length>150)return res.status(400).json({error:'Enter your email and password.'});
    const admin=await db.collection('admins').findOne({username});
    const valid=await checkPassword(password,admin?.passwordHash||await dummyHash);
    if(!admin||!valid)return res.status(401).json({error:'Invalid email or password.'});
    if(!admin.active||admin.role!=='admin')return res.status(403).json({error:'This account is not authorized.'});
    res.json({username,token:createAdminToken(admin)});
  });
  app.get('/api/admin/session',adminAuth,(req,res)=>res.json(req.admin));
  app.post('/api/admin/logout',(_req,res)=>res.json({ok:true}));

  app.post('/api/auth/register',limiter(8,60*60*1000),async(req,res)=>{
    const name=clean(req.body?.name),email=clean(req.body?.email).toLowerCase(),password=typeof req.body?.password==='string'?req.body.password:'';
    const fields={};
    if(name.length<2||name.length>100)fields.name='Enter your full name.';
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>150)fields.email='Enter a valid email address.';
    if(password.length<12||password.length>256)fields.password='Use 12–256 characters.';
    if(Object.keys(fields).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields});
    const user={_id:randomUUID(),name,email,passwordHash:await hashPassword(password),role:'user',active:true,createdAt:new Date(),updatedAt:new Date()};
    try{await db.collection('users').insertOne(user);}catch(error){if(error.code===11000)return res.status(409).json({error:'An account already exists for this email.'});throw error;}
    const session=await createSession(db,user._id,'user');
    res.status(201).set('Set-Cookie',cookie(session.token,8*60*60)).json({user:{name,email},csrf:session.csrf});
  });
  app.post('/api/auth/login',limiter(10,15*60*1000),async(req,res)=>{
    const email=clean(req.body?.email).toLowerCase(),password=typeof req.body?.password==='string'?req.body.password:'';
    const user=await db.collection('users').findOne({email});
    const valid=await checkPassword(password,user?.passwordHash||await dummyHash);
    if(!user||!valid)return res.status(401).json({error:'Invalid email or password.'});
    if(!user.active)return res.status(403).json({error:'This account is inactive.'});
    const session=await createSession(db,user._id,'user');
    res.set('Set-Cookie',cookie(session.token,8*60*60)).json({user:{name:user.name,email:user.email},csrf:session.csrf});
  });
  app.get('/api/auth/session',userAuth,(req,res)=>res.json({user:{name:req.session.name,email:req.session.username},csrf:req.session.csrf}));
  app.post('/api/auth/logout',userAuth,async(req,res)=>{await destroySession(db,req);res.set('Set-Cookie',cookie('',0)).json({ok:true});});

  app.post('/api/enquiries',limiter(12,60*60*1000),async(req,res)=>{
    const payload=req.body&&typeof req.body==='object'?req.body:{};
    const name=clean(payload.name),email=clean(payload.email),phone=clean(payload.phone),message=clean(payload.message),topic=clean(payload.topic||'General enquiry'),organization=clean(payload.organization),location=clean(payload.location);
    const validationError=enquiryValidationError({name,email,phone,message});
    if(validationError)return res.status(422).json({error:validationError});
    const enquiry={_id:randomUUID(),name,email,phone,organization,location,message,topic,status:'New',emailStatus:'pending',createdAt:new Date()};
    await db.collection('enquiries').insertOne(enquiry);
    try{
      const delivery=await sendEnquiryEmail(enquiry);
      if(!delivery.sent){await db.collection('enquiries').updateOne({_id:enquiry._id},{$set:{emailStatus:'awaiting_configuration'}});return res.status(503).json({error:'Your enquiry was saved, but email delivery is not configured yet. Please contact info@prismedu.in.'});}
      await db.collection('enquiries').updateOne({_id:enquiry._id},{$set:{emailStatus:'sent',emailSentAt:new Date()}});
      res.status(201).json({ok:true,message:'Email sent successfully. We will reach you as soon as possible.'});
    }catch(error){
      const emailErrorCode=String(error?.code||error?.responseCode||'unknown').slice(0,40);
      console.error('Enquiry email delivery failed.',{code:emailErrorCode,command:String(error?.command||'').slice(0,40)});
      await db.collection('enquiries').updateOne({_id:enquiry._id},{$set:{emailStatus:'failed',emailErrorCode}});
      res.status(502).json({error:'Your enquiry was saved, but the email could not be sent. Please try again or email info@prismedu.in.'});
    }
  });

  app.get('/api/resources',async(_req,res)=>{
    const items=await db.collection('resources').find({status:'Published'}).sort({date:-1,createdAt:-1}).toArray();
    res.json({items:items.map(resourceRecord)});
  });
  app.get('/api/resources/:slug',async(req,res)=>{
    const item=await db.collection('resources').findOne({slug:req.params.slug,status:'Published'});
    if(!item)return res.status(404).json({error:'Resource not found.'});
    res.json(resourceRecord(item));
  });
  app.get('/api/resource-media/:id',async(req,res)=>{
    const media=await db.collection('resourceMedia').findOne({_id:req.params.id});
    const resource=media&&await db.collection('resources').findOne({_id:media.resourceId});
    if(!media||!resource)return res.sendStatus(404);
    res.set('Content-Type',media.mime).set('X-Content-Type-Options','nosniff').send(Buffer.from(media.bytes?.buffer||media.bytes));
  });
  app.get('/api/co-partners',async(_req,res)=>{
    await ensureDefaultCoPartners(db);
    const items=await db.collection('coPartners').find({}).sort({displayOrder:1,createdAt:1}).toArray();
    res.json({items:items.map(coPartnerRecord)});
  });
  app.get('/api/co-partner-media/:id',async(req,res)=>{
    const media=await db.collection('coPartnerMedia').findOne({_id:req.params.id});
    const partner=media&&await db.collection('coPartners').findOne({_id:media.partnerId});
    if(!media||!partner)return res.sendStatus(404);
    res.set('Content-Type',media.mime).set('X-Content-Type-Options','nosniff').send(Buffer.from(media.bytes?.buffer||media.bytes));
  });

  app.get(propertyBase.map(path=>path+'/config'),(_req,res)=>res.json({whatsappNumber:whatsappNumber(),emailConfigured:Boolean(mailConfigured()),options}));
  app.get(propertyBase,async(req,res)=>{
    let records=(await readListings(db)).filter(item=>isVisible(item,req.query.featured!=='true'));
    if(req.query.featured==='true')records=records.filter(item=>item.featured);
    const locations=[...new Set(records.map(item=>item.city).filter(Boolean))].sort();
    records=filterRecords(records,req.query);
    records.sort((a,b)=>a.displayOrder-b.displayOrder||b.createdAt.localeCompare(a.createdAt));
    const limit=Math.min(60,Math.max(1,Number(req.query.limit)||6)),page=Math.max(1,Number(req.query.page)||1);
    res.json({items:records.slice((page-1)*limit,page*limit).map(publicRecord),total:records.length,page,limit,locations});
  });
  app.get(propertyBase.map(path=>path+'/:id'),async(req,res)=>{
    const item=await findListing(db,req.params.id);
    if(!item||!isVisible(item))return res.status(404).json({error:'Property listing not found or no longer available.'});
    res.json(publicRecord(item));
  });
  app.get('/api/media/:id',async(req,res)=>{
    const media=await db.collection('propertyMedia').findOne({_id:req.params.id});
    const record=media&&await findListing(db,media.listingId);
    if(!media||(!isVisible(record)&&!await sessionFor(db,req)&&!await adminFromToken(db,req)))return res.sendStatus(404);
    res.set('Content-Type',media.mime).set('X-Content-Type-Options','nosniff').send(Buffer.from(media.bytes?.buffer||media.bytes));
  });
  app.post(['/api/properties/submissions','/api/submissions'],limiter(12,60*60*1000),upload,async(req,res)=>{
    const key=req.headers['idempotency-key'];
    if(typeof key!=='string'||!/^[a-f0-9-]{36}$/i.test(key))return res.status(400).json({error:'A valid submission key is required.'});
    const keyHash=createHash('sha256').update(key).digest('hex'),existing=await findListingBySubmissionKey(db,keyHash);
    if(existing)return submitted(res,existing,db,200);
    const data=parseData(req);
    if(data.website)return res.status(400).json({error:'Unable to accept this submission.'});
    const item=prepareRecord(data,null,true),errors=validate(item,{publicSubmission:true});
    if(Object.keys(errors).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields:errors});
    const images=await prepareImages(req.files);
    try{await persist(db,item,images,keyHash,true);}catch(error){
      if(error.code===11000){const retry=await findListingBySubmissionKey(db,keyHash);if(retry)return submitted(res,retry,db,200);}
      throw error;
    }
    return submitted(res,item,db,201);
  });

  registerMaterials(app,db,{adminAuth,upload,parseData,prepareImages});
  app.use('/api/admin',adminAuth);
  app.get('/api/admin/resources',async(_req,res)=>{
    const items=await db.collection('resources').find({}).sort({updatedAt:-1}).toArray();
    res.json({items:items.map(resourceRecord)});
  });
  app.post('/api/admin/resources',uploadImage,async(req,res)=>{
    const data=parseData(req),item=prepareResource(data),fields=validateResource(item);
    if(Object.keys(fields).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields});
    const image=req.file&&(await prepareImages([req.file]))[0];
    if(image)item.imageId=image.id;
    await db.collection('resources').insertOne({_id:item.id,...item});
    if(image)await db.collection('resourceMedia').insertOne({_id:image.id,resourceId:item.id,bytes:image.bytes,mime:image.mime});
    res.status(201).json(item);
  });
  app.put('/api/admin/resources/:id',uploadImage,async(req,res)=>{
    const previous=await db.collection('resources').findOne({_id:req.params.id});
    if(!previous)return res.status(404).json({error:'Resource not found.'});
    const data=parseData(req);
    if(data.updatedAt!==previous.updatedAt)return res.status(409).json({error:'This resource changed since you opened it. Reload and try again.'});
    const item=prepareResource(data,previous),fields=validateResource(item);
    if(Object.keys(fields).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields});
    const image=req.file&&(await prepareImages([req.file]))[0],oldImageId=previous.imageId;
    if(image)item.imageId=image.id;
    await db.collection('resources').replaceOne({_id:req.params.id},{_id:item.id,...item});
    if(image)await db.collection('resourceMedia').insertOne({_id:image.id,resourceId:item.id,bytes:image.bytes,mime:image.mime});
    if(oldImageId&&oldImageId!==item.imageId)await db.collection('resourceMedia').deleteOne({_id:oldImageId});
    res.json(item);
  });
  app.delete('/api/admin/resources/:id',async(req,res)=>{
    const result=await db.collection('resources').deleteOne({_id:req.params.id});
    if(result.deletedCount)await db.collection('resourceMedia').deleteMany({resourceId:req.params.id});
    res.status(result.deletedCount?200:404).json(result.deletedCount?{ok:true}:{error:'Resource not found.'});
  });
  app.get('/api/admin/co-partners',async(_req,res)=>{
    await ensureDefaultCoPartners(db);
    const items=await db.collection('coPartners').find({}).sort({displayOrder:1,createdAt:1}).toArray();
    res.json({items:items.map(coPartnerRecord)});
  });
  app.post('/api/admin/co-partners',uploadImage,async(req,res)=>{
    const data=parseData(req),item=prepareCoPartner(data),image=req.file&&(await prepareImages([req.file]))[0];
    if(image)item.imageId=image.id;
    const fields=validateCoPartner(item);
    if(Object.keys(fields).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields});
    await db.collection('coPartners').insertOne({_id:item.id,...item});
    if(image)await db.collection('coPartnerMedia').insertOne({_id:image.id,partnerId:item.id,bytes:image.bytes,mime:image.mime});
    res.status(201).json(item);
  });
  app.put('/api/admin/co-partners/:id',uploadImage,async(req,res)=>{
    const previous=await db.collection('coPartners').findOne({_id:req.params.id});
    if(!previous)return res.status(404).json({error:'Co-partner not found.'});
    const data=parseData(req);
    if(data.updatedAt!==previous.updatedAt)return res.status(409).json({error:'This co-partner changed since you opened it. Reload and try again.'});
    const item=prepareCoPartner(data,previous),image=req.file&&(await prepareImages([req.file]))[0],oldImageId=previous.imageId;
    if(image){item.imageId=image.id;item.image='';}
    const fields=validateCoPartner(item);
    if(Object.keys(fields).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields});
    await db.collection('coPartners').replaceOne({_id:req.params.id},{_id:item.id,...item});
    if(image)await db.collection('coPartnerMedia').insertOne({_id:image.id,partnerId:item.id,bytes:image.bytes,mime:image.mime});
    if(oldImageId&&oldImageId!==item.imageId)await db.collection('coPartnerMedia').deleteOne({_id:oldImageId});
    res.json(item);
  });
  app.delete('/api/admin/co-partners/:id',async(req,res)=>{
    const result=await db.collection('coPartners').deleteOne({_id:req.params.id});
    if(result.deletedCount)await db.collection('coPartnerMedia').deleteMany({partnerId:req.params.id});
    res.status(result.deletedCount?200:404).json(result.deletedCount?{ok:true}:{error:'Co-partner not found.'});
  });
  app.get('/api/admin/listings',async(req,res)=>{
    let records=await readListings(db);
    const counts={total:records.length};
    for(const [label,key,value] of [['active','adminStatus','Active'],['inactive','adminStatus','Inactive'],['pending','approvalStatus','Pending'],['available','type','Properties Available'],['required','type','Properties Required'],['sold','dealStatus','Sold'],['rented','dealStatus','Rented'],['leased','dealStatus','Leased'],['fulfilled','dealStatus','Requirement Fulfilled'],['archived','adminStatus','Archived']])counts[label]=records.filter(item=>item[key]===value).length;
    const locations=[...new Set(records.map(item=>item.city).filter(Boolean))].sort();
    records=filterRecords(records,req.query);
    for(const key of ['adminStatus','approvalStatus','publicationStatus','dealStatus'])if(req.query[key])records=records.filter(item=>item[key]===req.query[key]);
    records.sort((a,b)=>(req.query.sort==='oldest'?1:-1)*a.createdAt.localeCompare(b.createdAt));
    const page=Math.max(1,Number(req.query.page)||1),limit=12,pageItems=records.slice((page-1)*limit,page*limit);
    const items=await Promise.all(pageItems.map(async item=>({...item,notification:await db.collection('notifications').findOne({listingId:item.id},{projection:{_id:0,status:1,attempts:1,error:1}})})));
    res.json({items,total:records.length,page,limit,counts,locations,mailConfigured:Boolean(mailConfigured()),whatsappConfigured:Boolean(whatsappNumber())});
  });
  app.get('/api/admin/listings/:id',async(req,res)=>{const item=await findListing(db,req.params.id);if(!item)return res.status(404).json({error:'Listing not found.'});res.json(item);});
  app.post('/api/admin/listings',upload,async(req,res)=>{
    const item=prepareRecord(parseData(req)),errors=validate(item);
    if(Object.keys(errors).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields:errors});
    await persist(db,item,await prepareImages(req.files));res.status(201).json(item);
  });
  app.put('/api/admin/listings/:id',upload,async(req,res)=>{
    const previous=await findListing(db,req.params.id);if(!previous)return res.status(404).json({error:'Listing not found.'});
    const data=parseData(req);if(data.updatedAt!==previous.updatedAt)return res.status(409).json({error:'This listing changed since you opened it. Reload before saving.'});
    const item=prepareRecord(data,previous),errors=validate(item);if(Object.keys(errors).length)return res.status(422).json({error:'Please correct the highlighted fields.',fields:errors});
    if((await findListing(db,req.params.id))?.updatedAt!==previous.updatedAt)return res.status(409).json({error:'This listing changed since you opened it. Reload before saving.'});
    await persist(db,item,await prepareImages(req.files));res.json(item);
  });
  app.post('/api/admin/listings/:id/duplicate',async(req,res)=>{
    const source=await findListing(db,req.params.id);if(!source)return res.status(404).json({error:'Listing not found.'});
    const item=prepareRecord({...source,title:source.title+' (copy)',adminStatus:'Inactive',publicationStatus:'Draft',featured:false,images:[]});
    const stored=await db.collection('propertyMedia').find({_id:{$in:source.images}}).toArray();
    const images=stored.map(media=>({id:randomUUID(),bytes:Buffer.from(media.bytes?.buffer||media.bytes),mime:media.mime}));
    await persist(db,item,images);res.status(201).json(item);
  });
  app.post('/api/admin/listings/:id/retry-email',async(req,res)=>{await db.collection('notifications').updateMany({listingId:req.params.id},{$set:{status:'pending',attempts:0,nextAttempt:new Date(0)},$unset:{error:''}});res.json({ok:true});});
  app.delete('/api/admin/listings/:id',async(req,res)=>{const deleted=await deleteListing(db,req.params.id);res.status(deleted?200:404).json(deleted?{ok:true}:{error:'Listing not found.'});});

  app.get('/api/health',async(_req,res)=>{
    await db.database.command({ping:1});
    res.json({ok:true});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found.'}));
  app.use('/admin',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  if(existsSync(frontendDist)){
    app.use(express.static(frontendDist));
    app.get('/{*path}',(_req,res)=>res.sendFile('index.html',{root:frontendDist}));
  }
  app.use((error,_req,res,_next)=>{
    if(error instanceof multer.MulterError)return res.status(422).json({error:'Upload up to 10 JPEG, PNG or WebP images, at most 8 MB each.',fields:{images:'Check image count and sizes.'}});
    if(error.status)return res.status(error.status).json({error:error.message,fields:error.fields});
    console.error('Prism request failed:',error.code||error.name);
    res.status(500).json({error:'The request could not be completed. Please retry.'});
  });
  return app;
}

function filterRecords(records,query){
  const keyword=clean(query.q).toLowerCase(),location=clean(query.location).toLowerCase();
  return records.filter(item=>(!keyword||[item.title,item.reference,item.location,item.city,item.district,item.description].join(' ').toLowerCase().includes(keyword))&&(!location||[item.location,item.city,item.district].join(' ').toLowerCase().includes(location))&&(!query.type||item.type===query.type)&&(!query.propertyType||item.propertyType===query.propertyType)&&(!query.transaction||item.transaction===clean(query.transaction))&&(query.urgent!=='true'||item.urgent)&&(!query.minArea||item.area>=Number(query.minArea))&&(!query.maxArea||item.area<=Number(query.maxArea))&&(!query.areaUnit||item.areaUnit===query.areaUnit));
}

function resourceRecord(document){
  const item={...document};delete item._id;return item;
}

function prepareResource(data={},previous=null){
  const now=new Date().toISOString(),id=previous?.id||randomUUID(),title=clean(data.title),type=clean(data.type);
  const slugBase=clean(data.slug)||title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')||id;
  const imageId=previous&&!data.removeImage&&data.imageId===previous.imageId?previous.imageId:'';
  return {id,slug:previous?.slug||(slugBase+'-'+id.slice(0,8)),type,title,description:clean(data.description),content:clean(data.content),url:clean(data.url),image:clean(data.image),imageId,category:clean(data.category)||type,date:clean(data.date)||now.slice(0,10),author:clean(data.author),status:data.status==='Published'?'Published':'Draft',featured:data.featured===true,webinarStatus:type==='Webinars'&&data.webinarStatus==='Upcoming'?'Upcoming':'',createdAt:previous?.createdAt||now,updatedAt:new Date(Math.max(Date.now(),Date.parse(previous?.updatedAt||0)+1)).toISOString()};
}

function validateResource(item){
  const fields={};
  if(!['Blogs','Webinars','Videos'].includes(item.type))fields.type='Choose Blogs, Webinars or Videos.';
  if(!item.title||item.title.length>180)fields.title='Enter a title up to 180 characters.';
  if(item.description.length>1000)fields.description='Use no more than 1,000 characters.';
  if(item.content.length>30000)fields.content='Use no more than 30,000 characters.';
  if(item.type==='Videos'&&!item.url)fields.url='Add the video link.';
  for(const key of ['url','image'])if(item[key]){try{if(new URL(item[key]).protocol!=='https:')throw Error();}catch{fields[key]='Use a valid HTTPS URL.';}}
  if(item.date&&!/^\d{4}-\d{2}-\d{2}$/.test(item.date))fields.date='Use a valid date.';
  return fields;
}

const defaultCoPartners=[
  {_id:'default-prince-nx',id:'default-prince-nx',title:'Prince NX',description:'Books & Stationery Partner',image:'/images/co-patners/WhatsApp Image 2026-09-28 at 8.04.09 PM.jpeg',imageId:'',displayOrder:0},
  {_id:'default-eduvate',id:'default-eduvate',title:'Eduvate',description:'K-12 Techno Services & Curriculum Partner',image:'/images/co-patners/WhatsApp Image 2026-09-28 at 9.59.50 PM.jpeg',imageId:'',displayOrder:1},
];

async function ensureDefaultCoPartners(db){
  const migration='003-default-co-partners';
  if(await db.collection('migrations').findOne({name:migration}))return;
  const now=new Date().toISOString();
  if(await db.collection('coPartners').countDocuments()===0){
    for(const item of defaultCoPartners)await db.collection('coPartners').updateOne({_id:item._id},{$setOnInsert:{...item,createdAt:now,updatedAt:now}},{upsert:true});
  }
  try{await db.collection('migrations').insertOne({name:migration,appliedAt:new Date()});}catch(error){if(error.code!==11000)throw error;}
}

function coPartnerRecord(document){
  const item={...document};delete item._id;return item;
}

function prepareCoPartner(data={},previous=null){
  const now=new Date().toISOString(),id=previous?.id||randomUUID();
  return {id,title:clean(data.title),description:clean(data.description),image:previous?.image||'',imageId:previous?.imageId||'',displayOrder:Number.isFinite(Number(data.displayOrder))?Number(data.displayOrder):0,createdAt:previous?.createdAt||now,updatedAt:new Date(Math.max(Date.now(),Date.parse(previous?.updatedAt||0)+1)).toISOString()};
}

function validateCoPartner(item){
  const fields={};
  if(item.title.length<2||item.title.length>120)fields.title='Enter a title from 2 to 120 characters.';
  if(item.description.length>500)fields.description='Use no more than 500 characters.';
  if(!item.image&&!item.imageId)fields.image='Upload a co-partner image.';
  if(!Number.isSafeInteger(item.displayOrder)||item.displayOrder<0||item.displayOrder>9999)fields.displayOrder='Use a display order from 0 to 9999.';
  return fields;
}

export function parseData(req){
  try{const value=typeof req.body?.data==='string'?JSON.parse(req.body.data):req.body;if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
  catch{throw Object.assign(Error('Invalid form data.'),{status:400});}
}

function prepareRecord(data,previous=null,isPublic=false){
  const id=previous?.id||randomUUID();
  const item={...defaults,...previous,id,slug:previous?.slug||id,reference:previous?.reference||'PP-'+randomBytes(6).toString('hex').toUpperCase(),createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date(Math.max(Date.now(),Date.parse(previous?.updatedAt||0)+1)).toISOString()};
  for(const key of textFields)if(data[key]!==undefined)item[key]=clean(data[key]);
  for(const key of Object.keys(options))if(data[key]!==undefined)item[key]=clean(data[key]);
  item.area=Number(data.area??item.area);
  for(const key of ['urgent','featured','keepCompletedVisible','consent','authorization'])if(data[key]!==undefined)item[key]=data[key]===true;
  item.displayOrder=Number(data.displayOrder??item.displayOrder);
  item.images=Array.isArray(data.images)?data.images.filter(mediaId=>previous?.images.includes(mediaId)):previous?.images||[];
  item.listingDate=item.listingDate||new Date().toISOString().slice(0,10);
  if(isPublic)Object.assign(item,{approvalStatus:'Pending',adminStatus:'Inactive',publicationStatus:'Draft',dealStatus:'Open',featured:false,keepCompletedVisible:false,displayOrder:0,internalNotes:'',video:'',images:[]});
  return item;
}

export async function prepareImages(files=[]){
  const result=[];
  for(const file of files){
    try{
      const image=sharp(file.buffer,{limitInputPixels:24000000,animated:false}),meta=await image.metadata();
      if(!['jpeg','png','webp'].includes(meta.format))throw Error();
      result.push({id:randomUUID(),bytes:await image.rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer(),mime:'image/webp'});
    }catch{throw Object.assign(Error('One of the images is invalid. Use JPEG, PNG or WebP images under 24 megapixels.'),{status:422,fields:{images:'Invalid image content.'}});}
  }
  return result;
}

async function persist(db,item,images=[],submissionKey,notify=false){
  if(item.images.length+images.length>10)throw Object.assign(Error('Use no more than 10 images.'),{status:422});
  item.images=[...new Set([...item.images,...images.map(image=>image.id)])];
  await saveListing(db,item,submissionKey);
  if(images.length)await db.collection('propertyMedia').insertMany(images.map(image=>({_id:image.id,listingId:item.id,bytes:image.bytes,mime:image.mime})));
  await db.collection('propertyMedia').deleteMany({listingId:item.id,_id:{$nin:item.images}});
  if(notify)await db.collection('notifications').updateOne({listingId:item.id},{$setOnInsert:{_id:randomUUID(),listingId:item.id,status:'pending',attempts:0,nextAttempt:new Date(0),createdAt:new Date()}},{upsert:true});
}

async function submitted(res,item,db,status){
  const notification=(await db.collection('notifications').findOne({listingId:item.id}))?.status||'pending';
  return res.status(status).json({reference:item.reference,status:'Pending Admin Review',notification:mailConfigured()?notification:'awaiting_configuration',whatsappUrl:whatsappLink(item)});
}
