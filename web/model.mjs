const ecosystems = new Set(['Packagist','npm','PyPI']);
const composerName = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const npmName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;
const pythonName = /^[a-z0-9][a-z0-9_.-]*$/i;
const semver = /^v?\d+(?:\.\d+){0,3}(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i;
const pythonVersion = /^v?(?:\d+!)?\d+(?:\.\d+)*(?:[-_.]?(?:a|b|rc|alpha|beta|pre|preview|c)[-_.]?\d*)?(?:-\d+|[-_.]?(?:post|rev|r)[-_.]?\d*)?(?:[-_.]?dev[-_.]?\d*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;
export const LIMIT = 2500;
export const MAX_BYTES = 4 * 1024 ** 2;

function normalize(ecosystem, name, version) {
  if (!ecosystems.has(ecosystem) || typeof name !== 'string' || typeof version !== 'string') return null;
  if (name.length > 214 || version.length > 128) return null;
  if (ecosystem === 'PyPI') {
    if (!pythonName.test(name) || !pythonVersion.test(version)) return null;
    name = name.toLowerCase().replace(/[-_.]+/g, '-');
  } else {
    if (!(ecosystem === 'npm' ? npmName : composerName).test(name) || !semver.test(version)) return null;
    if (ecosystem === 'Packagist') name = name.toLowerCase();
  }
  version = version.replace(/^v(?=\d)/i, '');
  return { key: [ecosystem,name,version].join('\0'), ecosystem, name, version };
}

const entries = obj => obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.entries(obj) : [];

export function parseInventory(text, file = '') {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('The manifest exceeds the 4 MiB limit.');
  const content = text.replace(/^\ufeff/, '').trim();
  if (!content) throw new Error('The manifest is empty.');
  const rows = new Map();
  let skipped = 0, duplicate = 0, format;
  function add(ecosystem, name, version, scope) {
    const row = normalize(ecosystem, name, version);
    if (!row) { skipped++; return; }
    if (rows.has(row.key)) { 
      duplicate++;
      if (scope === 'Main') rows.get(row.key).scope = scope;
      return;
    }
    if (rows.size >= LIMIT) throw new Error('More than 2,500 exact packages. Split the inventory before including more.');
    rows.set(row.key, { ...row, scope });
  }
  if (content.startsWith('{') || /\.(?:json|lock)$/i.test(file)) {
    let obj;
    try { obj = JSON.parse(content); }
    catch { throw new Error('The manifest is not valid JSON. This tool accepts the JSON formats listed above and pinned requirements text.'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Expected a lockfile or manifest JSON object.');
    if (Array.isArray(obj.packages) || Array.isArray(obj['packages-dev'])) {
      format = 'Composer lockfile';
      for (const [section, scope] of [['packages','Main'],['packages-dev','Dev']]) {
        for (const p of Array.isArray(obj[section]) ? obj[section] : []) add('Packagist', p?.name, p?.version, scope);
      }
    } else if (file === 'Pipfile.lock' || (obj._meta && (obj.default || obj.develop))) {
      format = 'Pipfile lockfile';
      for (const [section, items] of entries(obj)) {
        if (section === '_meta') continue;
        for (const [name, record] of entries(items)) {
          add('PyPI', name, typeof record?.version === 'string' && record.version.startsWith('==') ? record.version.slice(2) : null, section === 'default' ? 'Main' : section === 'develop' ? 'Dev' : 'Other');
        }
      }
    } else if (obj.lockfileVersion != null) {
      format = 'npm lockfile';
      if (obj.packages && typeof obj.packages === 'object') {
        for (const [path, record] of entries(obj.packages)) {
          if (!path) continue;
          const name = record?.name || /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path)?.[1];
          add('npm', name, record?.link ? null : record?.version, record?.dev ? 'Dev' : 'Main');
        }
      } else {
        const pending = entries(obj.dependencies);
        for (let i=0; i<pending.length; i++) {
          const [name, record] = pending[i];
          const alias = typeof record?.version === 'string' ? /^npm:(.+)@([^@]+)$/.exec(record.version) : null;
          add('npm', alias?.[1] ?? name, alias?.[2] ?? record?.version, record?.dev ? 'Dev' : 'Main');
          pending.push(...entries(record?.dependencies));
          if (pending.length > 100_000) throw new Error('The npm lockfile has too many nested entries.');
        }
      }
    } else if (obj.require || obj['require-dev'] || file === 'composer.json') {
      format = 'Composer manifest';
      for (const [section, scope] of [['require','Main'],['require-dev','Dev']]) {
        for (const [name, version] of entries(obj[section])) add('Packagist', name, version, scope);
      }
    } else if (obj.dependencies || obj.devDependencies || obj.optionalDependencies || file === 'package.json') {
      format = 'npm manifest';
      for (const [section, scope] of [['dependencies','Main'],['optionalDependencies','Optional'],['devDependencies','Dev']]) {
        for (const [name, version] of entries(obj[section])) {
          const alias = typeof version === 'string' ? /^npm:(.+)@([^@]+)$/.exec(version) : null;
          add('npm', alias?.[1] ?? name, alias?.[2] ?? version, scope);
        }
      }
    } else throw new Error('The JSON does not match a supported Composer, npm, or Pipfile format.');
  } else {
    format = 'Pinned Python requirements';
    for (const row of content.replace(/\\[ \t]*\r?\n/g,' ').split(/\r?\n/)) {
      const line = row.replace(/(^|\s)#.*$/, '').trim();
      if (!line || /^--hash\b/.test(line)) continue;
      const pin = /^([a-z\d][a-z\d_.-]*)(?:\[[^\]]+\])?\s*==\s*([^\s;]+)(?:\s+(?:--hash|#).*|\s*;.*)?$/i.exec(line);
      add('PyPI', pin?.[1], pin?.[2], 'Pinned');
    }
  }
  const packages = [...rows.values()].sort((a,b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version,'en',{numeric:true}));
  return { format, skipped, duplicate, packages };
}

export function plainVersion(value) {
  const match = /^v?(\d+(?:\.\d+){0,3})$/.exec(value ?? '');
  return match ? [...match[1].split('.').map(Number),0,0,0].slice(0,4) : null;
}

export function comparePlain(a,b) {
  const left = plainVersion(a), right = plainVersion(b);
  if (!left || !right) return null;
  for (let i=0;i<4;i++) { if (left[i] !== right[i]) return Math.sign(left[i]-right[i]); }
  return 0;
}

export function vulnURL(id) {
  return 'https://osv.dev/vulnerability/' + encodeURIComponent(id);
}

// Group by ecosystem and package name so multiple installed versions remain visible.
export function compareInventories(current, baseline) {
  const group = rows => {
    const result = new Map();
    for (const row of rows) {
      const key = row.ecosystem + '\0' + row.name;
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(row);
    }
    return result;
  };
  const before = group(baseline), after = group(current);
  const changes = new Map(), removed = [];
  for (const row of current) {
    const previous = before.get(row.ecosystem + '\0' + row.name);
    changes.set(row.key, !previous ? 'added' : previous.some(item => item.version === row.version) ? 'unchanged' : 'changed');
  }
  for (const row of baseline) {
    const versions = after.get(row.ecosystem + '\0' + row.name);
    if (!versions?.some(item => item.version === row.version)) {
      removed.push({ ecosystem: row.ecosystem, name: row.name, version: row.version,
        status: versions ? 'version removed' : 'package removed' });
    }
  }
  return { changes, removed };
}
