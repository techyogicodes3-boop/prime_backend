import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../app.js';

const cursor=items=>({
  sort(){return this},
  skip(){return this},
  limit(){return this},
  async toArray(){return items},
});

const db={
  collection(){
    return {
      find(){return cursor([])},
      async findOne(){return null},
      async countDocuments(){return 0},
    };
  },
};

test('public property and material records need no login or origin allowlist',async t=>{
  const server=createApp(db).listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {port}=server.address();
  const options={headers:{Origin:'https://end-user.example'}};

  for(const path of ['/api/properties?featured=true&limit=3','/api/materials?home=true&limit=8']){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,options);
    assert.equal(response.status,200,path);
    assert.equal(response.headers.get('access-control-allow-origin'),'https://end-user.example');
  }
});

test('admin records still require admin authentication',async t=>{
  const server=createApp(db).listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {port}=server.address();
  const response=await fetch(`http://127.0.0.1:${port}/api/admin/listings`,{headers:{Origin:'https://prismedu.in'}});

  assert.equal(response.status,401);
  assert.deepEqual(await response.json(),{error:'Please sign in.'});
});
