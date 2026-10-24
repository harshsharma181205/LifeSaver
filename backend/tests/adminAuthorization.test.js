const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const jwt=require('jsonwebtoken');
const {randomBytes}=require('node:crypto');
const pool=require('../db');
const original={execute:pool.execute,listen:express.application.listen,port:process.env.PORT,secret:process.env.JWT_SECRET,expiry:process.env.JWT_EXPIRES_IN};
const secret=randomBytes(32).toString('hex');
let server,base,queries=0;
before(async()=>{
  process.env.JWT_SECRET=secret;process.env.JWT_EXPIRES_IN='1h';
  pool.execute=async()=>{queries++;throw new Error('Reports must not run for clients');};
  express.application.listen=function(...args){server=original.listen.apply(this,args);return server;};
  process.env.PORT='0';try{require('../index');}finally{express.application.listen=original.listen;}
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  pool.execute=original.execute;express.application.listen=original.listen;
  for(const [key,value]of [['PORT',original.port],['JWT_SECRET',original.secret],['JWT_EXPIRES_IN',original.expiry]]){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }await pool.end();
});
const paths=['dashboard','reports/requests','reports/donors','reports/inventory','reports/donations','reports/allocations'];
for(const path of paths){
  for(const role of [null,'donor','recipient','blood_bank','admin']){
    test(path+' denies '+(role||'unauthenticated')+' cross-user report access',async()=>{
      const headers=role?{Authorization:'Bearer '+jwt.sign({user_id:1,user_type:role},secret,{algorithm:'HS256',expiresIn:'1h'})}:{};
      const response=await fetch(base+'/api/admin/'+path,{headers});
      assert.equal(response.status,role&&role!=='admin'?403:401);
      assert.deepEqual(Object.keys(await response.json()),['message']);assert.equal(queries,0);
    });
  }
}
test('report query and body cannot authorize a client',async()=>{
  const response=await fetch(base+'/api/admin/reports/inventory?user_type=admin&bank_id=2',
    {headers:{Authorization:'Bearer '+jwt.sign({user_id:1,user_type:'blood_bank'},secret,{expiresIn:'1h'})}});
  assert.equal(response.status,403);assert.equal(queries,0);
});
