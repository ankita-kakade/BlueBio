const $=s=>document.querySelector(s),api=u=>fetch(u).then(r=>{if(r.status===401){location.href='/login.html';throw 0}return r.json()});Chart.defaults.font.family='Inter,sans-serif';Chart.defaults.color='#3d6578';
let meta,map,layer=L.layerGroup(),charts={},cache={},S={region:'mumbai',param:'sst',m:0};
const fv=v=>v==null?'–':v.toFixed(2),ramp=t=>`hsl(${210-210*t},75%,48%)`,fmt=(p,v)=>fv(v)+' '+meta.params[p].unit;
async function init(){$('#logout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST'});location.href='/login.html'};

$('#report').onclick=async()=>{
 const element=document.body;
 const options={
  margin:10,
  filename:'BlueBio_Report.pdf',
  image:{type:'jpeg',quality:0.95},
  html2canvas:{scale:2,useCORS:true},
  jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}
 };
 await html2pdf().set(options).from(element).save();
};

fetch('/api/auth/me').then(r=>r.json()).then(u=>$('#user').textContent=u.name);meta=await api('/api/meta');if(!meta.months.length){$('#kpis').innerHTML='<div class="card wide">No data yet. Run the pipeline (see README), then reload.</div>';return}S.m=meta.months.length-1;
 $('#region').innerHTML=meta.regions.map(r=>`<option value="${r.id}">${r.name}</option>`).join('');
 $('#params').innerHTML=Object.entries(meta.params).map(([k,v])=>`<button data-p="${k}">${v.label}</button>`).join('');
 $('#month').max=S.m;$('#month').value=S.m;
 map=L.map('map',{maxBounds:[[15.2,71.6],[20.6,74.6]],minZoom:6}).setView([17.9,73.0],7);
 L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);layer.addTo(map);api('/api/zones').then(z=>L.geoJSON(z,{style:{color:'#0e7490',weight:1,fillOpacity:.06}}).addTo(map));
 $('#region').onchange=e=>{S.region=e.target.value;refresh()};
 $('#month').oninput=e=>{S.m=+e.target.value;refresh()};
 $('#params').onclick=e=>{if(e.target.dataset.p){S.param=e.target.dataset.p;refresh()}};

refresh()}

async function refresh(){const P=meta.params[S.param];
 $('#region').value=S.region;$('#mlabel').textContent=meta.months[S.m];
 document.querySelectorAll('#params button').forEach(b=>b.classList.toggle('on',b.dataset.p===S.param));
 const pts=await api(`/api/map?m=${S.m}&param=${S.param}`);
 const vals=pts.map(p=>p.value),mn=Math.min(...vals),mx=Math.max(...vals);
 $('#lmin').textContent=mn.toFixed(1);$('#lmax').textContent=mx.toFixed(1);layer.clearLayers();
 pts.forEach(p=>{const t=mx>mn?(p.value-mn)/(mx-mn):.5;
  if(p.anomaly)L.marker([p.lat,p.lon],{icon:L.divIcon({className:'',html:'<div class="ring"></div>',iconSize:[34,34],iconAnchor:[17,17]}),interactive:false}).addTo(layer);
  L.circleMarker([p.lat,p.lon],{radius:14,fillColor:ramp(t),fillOpacity:.9,color:p.id===S.region?'#083344':'#fff',weight:p.id===S.region?4:2})
   .bindTooltip(`<b>${p.name}</b><br>${P.label}: ${fmt(S.param,p.value)}${p.anomaly?'<br>Anomaly detected':''}`)
   .on('click',()=>{S.region=p.id;refresh()}).addTo(layer)});
 const d=cache[S.region]||(cache[S.region]=await api('/api/region/'+S.region));
 $('#kpis').innerHTML=Object.entries(meta.params).map(([k,v])=>{const bad=d.anomalies.some(a=>a.param===k&&a.i===S.m);
  return `<div class="kpi ${bad?'bad':''}"><small>${v.label}</small><b>${fv(d.env[k][S.m])}</b><small>${v.unit}${bad?' · anomaly':''}</small></div>`}).join('')
  +`<div class="kpi"><small>Fish records</small><b>${d.catch.total[S.m].toLocaleString()}</b><small>records this month</small></div>`;
 const accent='#0e7490',an=d.anomalies.filter(a=>a.param===S.param);
 const mk=(id,type,data,opt)=>{charts[id]&&charts[id].destroy();charts[id]=new Chart($(id),{type,data,options:{responsive:true,plugins:{legend:{display:false}},...opt}})};
 $('#t1').textContent=`${P.label} (${P.unit}) · ${meta.regions.find(r=>r.id===S.region).name}`;
 mk('#c1','line',{labels:meta.months,datasets:[{data:d.env[S.param],borderColor:accent,backgroundColor:'#0e749022',fill:true,tension:.3,pointRadius:0},
  {data:d.env[S.param].map((v,i)=>an.some(a=>a.i===i)?v:null),showLine:false,pointRadius:7,backgroundColor:'#c2410c'},
  {data:d.env[S.param].map((v,i)=>i===S.m?v:null),showLine:false,pointRadius:5,backgroundColor:'#083344'}]});
 const sp=Object.entries(d.catch.species);
 mk('#c2','bar',{labels:sp.map(s=>s[0]),datasets:[{data:sp.map(s=>s[1]),backgroundColor:accent}]},{indexAxis:'y'});
 mk('#c3','line',{labels:meta.months,datasets:[{data:d.catch.total,borderColor:'#083344',tension:.3,pointRadius:0}]});
 $('#atable').innerHTML='<tr><th>Month</th><th>Parameter</th><th>Observed</th><th>Expected</th><th>Severity</th></tr>'+
  (d.anomalies.length?d.anomalies.map(a=>`<tr><td>${a.month}</td><td>${meta.params[a.param].label}</td><td>${fmt(a.param,a.value)}</td><td>${fmt(a.param,a.expected)}</td><td><span class="tag ${a.severity==='High'?'h':''}">${a.severity}</span></td></tr>`).join(''):'<tr><td colspan="5">No anomalies found for this district.</td></tr>');
 $('#ins').innerHTML=d.insights.map(i=>`<li class="${i.type}">${i.text}</li>`).join('')}
init();
