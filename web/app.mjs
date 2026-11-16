import { parseInventory, MAX_BYTES, comparePlain, plainVersion, vulnURL } from './model.mjs';

const $ = id => document.getElementById(id);
const batchURL = 'https://api.osv.dev/v1/querybatch';
const pageSize = 30;
let inventory, page = 0, scanTask, releaseTasks = new Map(), scanAt;
const selected = new Set(), results = new Map(), releases = new Map();

function node(tag, content, className) {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  if (className) el.className = className;
  return el;
}
function report(id, text, error = false) {
  $(id).textContent = text;
  $(id).dataset.error = String(error);
}
async function fetchJSON(url, signal, body) {
  const r = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    method: body ? 'POST' : 'GET',
    headers: body ? {'Content-Type':'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'omit',
  });
  if (!r.ok) throw new Error(r.status === 429 ? 'Rate limited. Try checking smaller groups.' : 'Service returned HTTP ' + r.status + '.');
  return r.json();
}

function openInventory(next) {
  scanTask?.abort();
  scanTask = null;
  for (const task of releaseTasks.values()) task.abort();
  releaseTasks = new Map();
  selected.clear();
  results.clear();
  releases.clear();
  scanAt = null;
  inventory = next;
  page = 0;
  for (const row of next.packages) selected.add(row.key);
  $('filter').value = '';
  $('finding').value = '';
  $('inventory').hidden = !next.packages.length;
  $('inventory-count').textContent = next.packages.length + ' exact versions';
  report('open-status', next.format + ' · ' + next.packages.length + ' exact entries · ' + next.duplicate + ' duplicates joined · ' + next.skipped + ' non-exact or unsupported entries skipped.', !next.packages.length);
  report('scan-status','Ready. The selected rows below are the request preview.');
  render();
}

function load(text, name) {
  try { openInventory(parseInventory(text, name)); }
  catch (error) { report('open-status', error.message, true); }
}

function filteredRows() {
  const tokens = $('filter').value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const finding = $('finding').value;
  return (inventory?.packages ?? []).filter(row => {
    const status = !results.has(row.key) ? 'unchecked' : results.get(row.key).length ? 'vulnerable' : 'checked';
    return (!finding || finding === status) && tokens.every(token => (row.ecosystem+' '+row.name+' '+row.version+' '+row.scope).toLowerCase().includes(token));
  });
}

function setControls() {
  $('scan').disabled = !selected.size || !!scanTask;
  $('scan').textContent = 'Check ' + selected.size + ' selected on OSV';
  $('cancel').hidden = !scanTask;
}

function render() {
  if (!inventory) return;
  const rows = filteredRows();
  const pages = Math.ceil(rows.length / pageSize);
  page = Math.min(page, Math.max(0,pages-1));
  const shown = rows.slice(page*pageSize,(page+1)*pageSize);
  $('filtered-count').textContent = rows.length + ' shown by filter · ' + selected.size + ' selected';
  $('select-filtered').disabled = !rows.length;
  $('deselect-filtered').disabled = !rows.length;
  $('rows').replaceChildren(...shown.map(renderRow));
  if (!shown.length) {
    const empty = node('td','No packages match those filters.');
    empty.colSpan = 4;
    const tr = node('tr');
    tr.append(empty);
    $('rows').append(tr);
  }
  $('pagination').hidden = pages < 2;
  $('page').textContent = 'Page ' + (page+1) + ' of ' + pages;
  $('previous').disabled = page === 0;
  $('next').disabled = page+1 >= pages;
  setControls();
}

function renderRow(row) {
  const tr = node('tr'), choice = node('td'), info = node('td'), findings = node('td'), latest = node('td');
  const checkbox = node('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(row.key);
  checkbox.setAttribute('aria-label','Include ' + row.name + ' ' + row.version + ' in OSV checks');
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(row.key); else selected.delete(row.key);
    $('filtered-count').textContent = filteredRows().length + ' shown by filter · ' + selected.size + ' selected';
    setControls();
  });
  choice.append(checkbox);
  info.append(node('strong',row.name),node('span',row.ecosystem + ' · ' + row.version + ' · ' + row.scope,'muted'));
  const records = results.get(row.key);
  if (records?.length) {
    const details = node('details');
    details.append(node('summary', records.length + (records.length === 1 ? ' advisory' : ' advisories')));
    const list = node('ul',undefined,'list');
    for (const item of records) {
      const a = node('a',item);
      a.href = vulnURL(item);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const li = node('li');
      li.append(a);
      list.append(li);
    }
    details.append(list);
    findings.append(node('span','OSV match','badge warn'),details);
  } else findings.textContent = records ? 'No OSV match' : 'Unchecked';
  const release = releases.get(row.key);
  if (release?.version) {
    const compare = comparePlain(row.version,release.version);
    latest.append(node('strong',release.version),node('span',compare === -1 ? 'A newer numeric release exists' : 'Registry release', compare === -1 ? 'badge warn':'muted'));
  } else {
    const button = node('button',release ? 'Retry release check' : 'Check release');
    button.disabled = releaseTasks.has(row.key);
    if (button.disabled) button.textContent = 'Checking…';
    button.title = 'Send this package name to ' + (row.ecosystem === 'Packagist' ? 'Packagist' : 'deps.dev');
    button.addEventListener('click',()=>checkRelease(row));
    latest.append(button);
    if (release?.error) latest.append(node('span',release.error,'muted'));
  }
  tr.append(choice,info,findings,latest);
  return tr;
}

async function checkRelease(row) {
  const task = new AbortController();
  releaseTasks.set(row.key,task);
  render();
  try {
    let version;
    if (row.ecosystem === 'Packagist') {
      const path = row.name.split('/').map(encodeURIComponent).join('/');
      const data = await fetchJSON('https://packagist.org/packages/' + path + '.json',task.signal);
      const history = Object.values(data?.package?.versions ?? {});
      version = history.map(record=>record.version).filter(ver=>plainVersion(ver)).sort((a,b)=>comparePlain(b,a))[0];
    } else {
      const service = row.ecosystem === 'npm' ? 'npm' : 'pypi';
      const data = await fetchJSON('https://api.deps.dev/v3/systems/' + service + '/packages/' + encodeURIComponent(row.name),task.signal);
      version = data?.versions?.find(record=>record.isDefault)?.versionKey?.version;
    }
    if (typeof version !== 'string' || !version) throw new Error('Registry release unavailable.');
    if (!task.signal.aborted) releases.set(row.key,{version});
  } catch (error) {
    if (!task.signal.aborted) releases.set(row.key,{error:error.name === 'TimeoutError' ? 'Release check timed out.' : error.message});
  } finally {
    if (releaseTasks.get(row.key) === task) {
      releaseTasks.delete(row.key);
      render();
    }
  }
}

async function batch(group, signal) {
  const found = new Map(group.map(row=>[row.key,new Set()]));
  let queue = group.map(row=>({row,query:{package:{name:row.name,ecosystem:row.ecosystem},version:row.version}}));
  for (let iteration=0; queue.length; iteration++) {
    if (iteration === 15) throw new Error('OSV pagination exceeded the request limit.');
    const data = await fetchJSON(batchURL,signal,{queries:queue.map(item=>item.query)});
    if (!Array.isArray(data?.results) || data.results.length !== queue.length) throw new Error('OSV returned an unexpected batch response.');
    const next = [];
    for (let i=0; i<queue.length; i++) {
      const {row,query} = queue[i], result = data.results[i];
      if (!result || typeof result !== 'object') throw new Error('OSV returned an invalid result.');
      for (const advisory of result.vulns ?? []) {
        if (typeof advisory?.id === 'string' && advisory.id.length <= 200) found.get(row.key).add(advisory.id);
      }
      if (result.next_page_token) next.push({row,query:{...query,page_token:result.next_page_token}});
    }
    queue = next;
  }
  return found;
}
async function scan() {
  if (scanTask || !selected.size) return;
  const rows = inventory.packages.filter(row=>selected.has(row.key));
  const task = new AbortController();
  scanTask = task;
  scanAt = new Date().toISOString();
  let checked = 0;
  setControls();
  try {
    for (let i=0;i<rows.length;i+=75) {
      report('scan-status','Checking ' + checked + ' of ' + rows.length + ' selected package versions…');
      const found = await batch(rows.slice(i,i+75),task.signal);
      if (task.signal.aborted || scanTask !== task) return;
      for (const [key,value] of found) results.set(key,[...value].sort());
      checked += found.size;
      render();
    }
    const matches = rows.filter(row=>results.get(row.key)?.length).length;
    report('scan-status','Checked ' + checked + ' selected versions · ' + matches + ' with OSV matches.');
  } catch (error) {
    if (scanTask !== task) return;
    const message = task.signal.aborted ? 'Check cancelled.' : error.name==='TimeoutError' ? 'OSV timed out.' : error.message;
    report('scan-status',message+' Finished '+checked+' of '+rows.length+' selected versions.', !task.signal.aborted);
  } finally {
    if (scanTask === task) { scanTask = null; setControls(); }
  }
}

function exportReport() {
  const blob = new Blob([JSON.stringify({
    format: inventory.format, scannedAt: scanAt, skipped: inventory.skipped,
    packages: inventory.packages.map(({key,...row})=>({...row,advisories:results.get(key) ?? null,registryRelease:releases.get(key)?.version ?? null})),
  },null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = node('a');
  a.href = url;
  a.download = 'dependency-xray-report.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
let fileRead = 0;
$('file').addEventListener('change',async event=>{
  const file = event.target.files[0], attempt = ++fileRead;
  if (!file) return;
  if (file.size > MAX_BYTES) { report('open-status','The manifest exceeds the 4 MiB limit.',true); return; }
  try { const text = await file.text(); if (attempt === fileRead) load(text,file.name); }
  catch { if (attempt === fileRead) report('open-status','The file could not be read.',true); }
});
$('paste').addEventListener('submit',event=>{event.preventDefault();fileRead++;load(event.currentTarget.elements.text.value);});
$('sample').addEventListener('click',()=>{
  fileRead++;
  openInventory({format:'Curated sample',skipped:0,duplicate:0,packages:[
    {ecosystem:'npm',name:'lodash',version:'4.17.20',scope:'Main'},
    {ecosystem:'Packagist',name:'guzzlehttp/guzzle',version:'6.5.5',scope:'Main'},
    {ecosystem:'PyPI',name:'urllib3',version:'1.26.4',scope:'Pinned'},
  ].map(row=>({...row,key:[row.ecosystem,row.name,row.version].join('\0')}))});
});
$('scan').addEventListener('click',scan);
$('cancel').addEventListener('click',()=>scanTask?.abort());
$('export').addEventListener('click',exportReport);
for (const id of ['filter','finding']) $(id).addEventListener('input',()=>{page=0;render();});
$('select-filtered').addEventListener('click',()=>{for (const row of filteredRows()) selected.add(row.key);render();});
$('deselect-filtered').addEventListener('click',()=>{for (const row of filteredRows()) selected.delete(row.key);render();});
$('previous').addEventListener('click',()=>{if(page){page--;render();}});
$('next').addEventListener('click',()=>{page++;render();});
