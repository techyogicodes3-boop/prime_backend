import {MongoClient} from 'mongodb';

const DATABASE_NAME='prism';
let connectionPromise;

export async function openDatabase(uri=process.env.MONGODB_URI){
  if(!uri||!/^mongodb(?:\+srv)?:\/\//.test(uri))throw Error('Set a valid MONGODB_URI in .env.');
  if(!connectionPromise)connectionPromise=connect(uri).catch(error=>{connectionPromise=null;throw error;});
  return connectionPromise;
}

async function connect(uri){
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:12000,maxPoolSize:20});
  try{
    await client.connect();
    const database=client.db(DATABASE_NAME);
    const store={client,database,collection:name=>database.collection(name),close:()=>client.close()};
    await ensureIndexes(store);
    return store;
  }catch(error){
    await client.close();
    throw error;
  }
}

async function ensureIndexes(db){
  await Promise.all([
    db.collection('admins').createIndex({username:1},{unique:true}),
    db.collection('users').createIndex({email:1},{unique:true}),
    db.collection('sessions').createIndex({tokenHash:1},{unique:true}),
    db.collection('sessions').createIndex({expiresAt:1},{expireAfterSeconds:0}),
    db.collection('properties').createIndex({slug:1},{unique:true}),
    db.collection('properties').createIndex({reference:1},{unique:true}),
    db.collection('properties').createIndex({submissionKey:1},{unique:true,sparse:true}),
    db.collection('propertyMedia').createIndex({listingId:1}),
    db.collection('notifications').createIndex({listingId:1}),
    db.collection('materials').createIndex({creationKey:1},{unique:true,sparse:true}),
    db.collection('materialMedia').createIndex({listingId:1}),
    db.collection('resources').createIndex({slug:1},{unique:true}),
    db.collection('resources').createIndex({status:1,type:1,date:-1}),
    db.collection('resourceMedia').createIndex({resourceId:1}),
    db.collection('coPartners').createIndex({displayOrder:1,createdAt:1}),
    db.collection('coPartnerMedia').createIndex({partnerId:1}),
    db.collection('enquiries').createIndex({createdAt:-1}),
    db.collection('enquiries').createIndex({status:1,createdAt:-1}),
    db.collection('migrations').createIndex({name:1},{unique:true}),
  ]);
}

const cleanDocument=document=>{
  if(!document)return null;
  const item={...document},_id=item._id;
  delete item._id;
  delete item.submissionKey;
  return {...item,id:item.id||String(_id)};
};

export async function readListings(db){
  return (await db.collection('properties').find({}).toArray()).map(cleanDocument);
}

export async function findListing(db,id){
  return cleanDocument(await db.collection('properties').findOne({$or:[{_id:id},{slug:id},{reference:id}]}));
}

export async function findListingBySubmissionKey(db,submissionKey){
  return cleanDocument(await db.collection('properties').findOne({submissionKey}));
}

export async function saveListing(db,item,submissionKey){
  const update={$set:{...item,id:item.id}};
  if(submissionKey)update.$setOnInsert={submissionKey};
  await db.collection('properties').updateOne({_id:item.id},update,{upsert:true});
  return item;
}

export async function deleteListing(db,id){
  const result=await db.collection('properties').deleteOne({_id:id});
  if(result.deletedCount){
    await Promise.all([
      db.collection('propertyMedia').deleteMany({listingId:id}),
      db.collection('notifications').deleteMany({listingId:id}),
    ]);
  }
  return Boolean(result.deletedCount);
}
