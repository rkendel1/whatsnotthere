function replayPayload(report) {
  return {
    format: 'xray.replay.v1',
    generatedAt: new Date().toISOString(),
    source: report.pageProjection || null,
    ghostData: report.ghostData || null,
    datasets: report.structuredExtraction?.datasets || [],
  };
}

export function buildOfflineReplay(report) {
  const encoded = JSON.stringify(replayPayload(report)).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X-Ray Offline Reconstruction</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui;color:#172033;background:#f5f6fa}*{box-sizing:border-box}body{margin:0}header{padding:24px 30px;background:#101828;color:#fff}header h1{margin:0;font-size:22px}header p{margin:6px 0 0;color:#aeb8cc}main{padding:22px 30px}.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}input,select,button{font:inherit;border:1px solid #ccd2dd;border-radius:8px;padding:9px 11px;background:white}input{min-width:300px}.stats{color:#667085;font-size:13px}.notice{padding:10px 12px;background:#eef1ff;color:#4050a8;border-radius:8px;margin-bottom:14px;font-size:13px}.table{overflow:auto;max-height:65vh;border:1px solid #e0e4eb;border-radius:10px;background:white}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:9px 11px;border-bottom:1px solid #edf0f4;text-align:left;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}th{position:sticky;top:0;background:#f3f5f8;cursor:pointer}.machine{background:#fff8e7}.tag{font-size:9px;color:#9a6700;margin-left:5px}.empty{padding:40px;text-align:center;color:#667085}</style></head>
<body><header><h1>X-Ray Reconstruction</h1><p>Portable application data view · works without the original website</p></header><main>
<div class="tools"><select id="dataset"></select><input id="search" type="search" placeholder="Search reconstructed records…"><label><input id="hidden" type="checkbox" checked> Show what wasn’t rendered</label><span class="stats" id="stats"></span></div>
<div class="notice" id="notice"></div><div class="table" id="view"></div></main>
<script id="xray-data" type="application/json">${encoded}</script><script>
const replay=JSON.parse(document.getElementById('xray-data').textContent);const picker=document.getElementById('dataset'),search=document.getElementById('search'),hidden=document.getElementById('hidden'),view=document.getElementById('view'),stats=document.getElementById('stats'),notice=document.getElementById('notice');let sortField=null,sortDirection=1;
const flat=(object,prefix='',result={})=>{for(const[key,value]of Object.entries(object||{})){const path=prefix?prefix+'.'+key:key;if(value&&typeof value==='object'&&!Array.isArray(value))flat(value,path,result);else result[path]=Array.isArray(value)?value.map(v=>typeof v==='object'?JSON.stringify(v):v).join(', '):value}return result};
const label=value=>String(value).replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_.-]+/g,' ').replace(/\\b\\w/g,c=>c.toUpperCase());
replay.datasets.forEach((dataset,index)=>{const option=document.createElement('option');option.value=index;option.textContent=label(dataset.name)+' ('+dataset.observedItems+' records)';picker.append(option)});
function render(){const dataset=replay.datasets[Number(picker.value)||0];if(!dataset){view.innerHTML='<div class="empty">No datasets reconstructed.</div>';return}const rows=dataset.items.map(flat);const visible=new Set(dataset.presentation?.visibleFields||[]),machine=new Set(dataset.presentation?.machineOnlyFields||[]);let columns=[...new Set(rows.flatMap(Object.keys))];if(!hidden.checked&&visible.size)columns=columns.filter(field=>visible.has(field));const query=search.value.trim().toLowerCase();let filtered=rows.filter(row=>!query||Object.values(row).some(value=>String(value??'').toLowerCase().includes(query)));if(sortField)filtered.sort((a,b)=>String(a[sortField]??'').localeCompare(String(b[sortField]??''),undefined,{numeric:true})*sortDirection);stats.textContent=filtered.length+' of '+rows.length+' records · '+columns.length+' fields';notice.textContent=(visible.size||0)+' fields matched the rendered page · '+(machine.size||0)+' observed only in machine data';const table=document.createElement('table'),head=table.createTHead().insertRow();columns.forEach(field=>{const th=document.createElement('th');th.textContent=label(field)+(machine.has(field)?' · machine-only':'');if(machine.has(field))th.className='machine';th.onclick=()=>{sortDirection=sortField===field?-sortDirection:1;sortField=field;render()};head.append(th)});const body=table.createTBody();filtered.forEach(row=>{const tr=body.insertRow();columns.forEach(field=>{const td=tr.insertCell();td.textContent=row[field]??'—';td.title=String(row[field]??'');if(machine.has(field))td.className='machine'})});view.replaceChildren(table)}
[picker,hidden].forEach(element=>element.addEventListener('change',render));search.addEventListener('input',render);render();
</script></body></html>`;
}

export function downloadOfflineReplay(report) {
  const blob = new Blob([buildOfflineReplay(report)], { type: 'text/html' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = 'xray-reconstruction.html';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
}
