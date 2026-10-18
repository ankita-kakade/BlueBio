const express=require('express'),{Pool}=require('pg'),path=require('path'),crypto=require('crypto');
const db=new Pool({connectionString:process.env.DATABASE_URL}),ML=process.env.ML_URL||'http://ml:8000';
const PARAMS={sst:{label:'Sea surface temperature',unit:'°C'},salinity:{label:'Salinity',unit:'PSU'},
 chlorophyll:{label:'Chlorophyll-a',unit:'mg/m³'},oxygen:{label:'Dissolved oxygen',unit:'mg/L'}};
const q=(s,a)=>db.query(s,a).then(r=>r.rows),app=express(),PUB=path.join(__dirname,'public');
const h=f=>(a,b)=>f(a,b).catch(e=>b.status(500).json({error:e.message}));
const months=async()=>(await q("select distinct to_char(month,'YYYY-MM') m from ocean_obs order by 1")).map(r=>r.m);
const R="select id,name,ST_Y(ST_Centroid(geom)) lat,ST_X(ST_Centroid(geom)) lon from regions order by lat desc";

// ---------- authentication (no extra dependencies; users live in PostGIS database) ----------
let SECRET;const WEEK=7*864e5;
const b64=s=>Buffer.from(s).toString('base64url'),mac=s=>crypto.createHmac('sha256',SECRET).update(s).digest('base64url');
const hash=(p,s=crypto.randomBytes(16).toString('hex'))=>s+':'+crypto.scryptSync(p,s,64).toString('hex');
const verify=(p,st)=>{const [s,k]=st.split(':'),a=Buffer.from(hash(p,s).split(':')[1],'hex'),b=Buffer.from(k,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const user=req=>{const c=/(?:^|;\s*)bb=([^;]+)/.exec(req.headers.cookie||'');if(!c)return null;
 const [p,s]=c[1].split('.');if(!s||mac(p)!==s)return null;try{const u=JSON.parse(Buffer.from(p,'base64url'));return u.exp>Date.now()?u:null}catch{return null}};
const login=(res,u)=>{const p=b64(JSON.stringify({id:u.id,name:u.name,email:u.email,exp:Date.now()+WEEK}));
 res.setHeader('Set-Cookie',`bb=${p}.${mac(p)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${WEEK/1000}`)};
const tries=new Map(),limited=req=>{const k=req.ip,n=(tries.get(k)||[]).filter(t=>Date.now()-t<9e5);n.push(Date.now());tries.set(k,n);return n.length>15};

app.use(express.json());
app.post('/api/auth/register',h(async(req,res)=>{if(limited(req))return res.status(429).json({error:'Too many attempts. Try again later.'});
 const {name='',email='',password=''}=req.body,e=email.trim().toLowerCase();
 if(!name.trim()||!/^\S+@\S+\.\S+$/.test(e))return res.status(400).json({error:'Enter your name and a valid email.'});
 if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});
 try{const [u]=await q('insert into users(name,email,pw) values($1,$2,$3) returning id,name,email',[name.trim(),e,hash(password)]);login(res,u);res.json({ok:true})}
 catch(x){if(x.code==='23505')return res.status(409).json({error:'An account with this email already exists.'});throw x}}));
app.post('/api/auth/login',h(async(req,res)=>{if(limited(req))return res.status(429).json({error:'Too many attempts. Try again later.'});
 const e=(req.body.email||'').trim().toLowerCase(),[u]=await q('select * from users where email=$1',[e]);
 if(!u||!verify(req.body.password||'',u.pw))return res.status(401).json({error:'Incorrect email or password.'});login(res,u);res.json({ok:true})}));
app.post('/api/auth/logout',(_,res)=>{res.setHeader('Set-Cookie','bb=; HttpOnly; Path=/; Max-Age=0');res.json({ok:true})});
app.get('/api/auth/me',(req,res)=>{const u=user(req);u?res.json({name:u.name,email:u.email}):res.status(401).json({error:'Login required'})});
app.use('/api',(req,res,next)=>user(req)?next():res.status(401).json({error:'Login required'}));

// ---------- pages: the dashboard is only served to signed-in users ----------
app.get(['/','/dashboard.html'],(req,res)=>user(req)?res.sendFile(path.join(PUB,'dashboard.html')):res.redirect('/login.html'));
app.get('/login.html',(req,res)=>user(req)?res.redirect('/'):res.sendFile(path.join(PUB,'login.html')));
app.use(express.static(PUB,{index:false}));

// ---------- data API (unchanged) ----------
app.get('/api/meta',h(async(_,r)=>r.json({regions:await q(R),months:await months(),params:PARAMS})));
app.get('/api/zones',h(async(_,r)=>r.json({type:'FeatureCollection',features:(await q("select id,name,ST_AsGeoJSON(geom)::json g from regions")).map(x=>({type:'Feature',properties:{name:x.name},geometry:x.g}))})));
app.get('/api/map',h(async(req,res)=>{const m=(await months())[+req.query.m],p=PARAMS[req.query.param]?req.query.param:'sst';
 res.json(await q(`select r.id,r.name,ST_Y(ST_Centroid(r.geom)) lat,ST_X(ST_Centroid(r.geom)) lon,o.value,
  exists(select 1 from anomalies a where a.region_id=r.id and a.param=$2 and to_char(a.month,'YYYY-MM')=$1) anomaly
  from regions r join ocean_obs o on o.region_id=r.id and to_char(o.month,'YYYY-MM')=$1 and o.param=$2`,[m,p]))}));
app.get('/api/region/:id',h(async(req,res)=>{const id=req.params.id,ms=await months(),ix=m=>ms.indexOf(m);
 const env={};Object.keys(PARAMS).forEach(p=>env[p]=ms.map(()=>null));
 (await q("select to_char(month,'YYYY-MM') m,param,value from ocean_obs where region_id=$1",[id])).forEach(o=>{if(env[o.param])env[o.param][ix(o.m)]=Math.round(o.value*100)/100});
 
const J="from fish_obs f join regions r on ST_Intersects(f.geom,r.geom) where r.id=$1";

 const total=ms.map(()=>0);(await q(`select to_char(obs_date,'YYYY-MM') m,count(*)::int n ${J} group by 1`,[id])).forEach(o=>{if(ix(o.m)>=0)total[ix(o.m)]=o.n});
 const species={};(await q(`select species,count(*)::int n ${J} group by 1 order by 2 desc limit 6`,[id])).forEach(o=>species[o.species]=o.n);

const an=(await q("select to_char(month,'YYYY-MM') month_key,param,value,expected,z,severity from anomalies where region_id=$1 order by month",[id])).map(a=>({...a,month:a.month_key,i:ix(a.month_key)}));

 res.json({env,catch:{species,total},anomalies:an,insights:await q("select type,text from insights where region_id=$1",[id])})}));
app.post('/api/refresh',h(async(_,r)=>r.json(await (await fetch(ML+'/run',{method:'POST'})).json())));
app.get('/api/status',h(async(_,r)=>r.json(await (await fetch(ML+'/status')).json())));

(async()=>{await q('create table if not exists users(id serial primary key,name text not null,email text unique not null,pw text not null,created timestamptz default now())');
 await q('create table if not exists app_secret(k int primary key,v text)');
 await q('insert into app_secret values(1,$1) on conflict do nothing',[crypto.randomBytes(32).toString('hex')]);
 SECRET=(await q('select v from app_secret where k=1'))[0].v;
 app.listen(3000,()=>console.log('BlueBio running on :3000'))})().catch(e=>{console.error(e);process.exit(1)});
