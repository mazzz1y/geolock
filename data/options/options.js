import { normalizeMatcher, serializeMatcher, convertKind, KIND_LABELS, ALL_KINDS } from './matcher-tree.js';
import { parseGeositeRef, formatGeositeRef } from '../../lib/geosite-ref.js';
import { parseCidr } from '../../lib/ip.js';

const $ = id => document.getElementById(id);
const send = message => browser.runtime.sendMessage(message);
const isHttpsUrl = value => !value || /^https:\/\//.test(value.trim());

let currentConfig = null;
let currentRemoteSettings = null;
let suppressNextRender = false;
let lastRenderedJson = '';

async function init() {
  await refreshConfig();
  await refreshRemoteSettings();
  await refreshData();
  bindStaticEvents();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.remote_config) {
      currentRemoteSettings = changes.remote_config.newValue ?? defaultRemoteForm();
      renderRemoteCard();
    }
    if (changes.config) {
      currentConfig = changes.config.newValue;
      if (suppressNextRender) {
        suppressNextRender = false;
        updateJsonOutOfSync();
        return;
      }
      renderAll();
    }
  });
  browser.runtime.onMessage.addListener(message => {
    if (message?.kind === 'event:data.changed') refreshData();
  });
}

function defaultRemoteForm() {
  return { url: '', auto_update: true, interval_hours: 24 };
}

async function refreshRemoteSettings() {
  const reply = await send({ kind: 'remote.get' });
  currentRemoteSettings = reply?.ok ? reply.settings : defaultRemoteForm();
  renderRemoteCard();
}

async function refreshConfig() {
  const reply = await send({ kind: 'config.get' });
  if (!reply?.ok) {
    $('status-line').textContent = 'Failed to load configuration';
    return;
  }
  currentConfig = reply.config;
  renderAll();
}

async function refreshData() {
  const reply = await send({ kind: 'data.status' });
  if (!reply?.ok) return;
  renderDataCard(reply.status, reply.errors, reply.updating);
  renderRemoteTimestamps(reply.remoteLastCheckedAt, reply.remoteLastAppliedAt);
}

function renderRemoteTimestamps(checkedAt, appliedAt) {
  const node = $('remote-last-fetched');
  if (!node) return;
  const parts = [];
  if (checkedAt) parts.push(`Last checked ${new Date(checkedAt).toLocaleString()}`);
  if (appliedAt && appliedAt !== checkedAt) parts.push(`last applied ${new Date(appliedAt).toLocaleString()}`);
  node.textContent = parts.join('; ');
}

function renderAll() {
  if (!currentConfig) return;
  $('status-line').textContent = `${currentConfig.rules.length} rule(s); default ${currentConfig.default_action}`;
  renderRules();
  renderRemoteCard();
  renderDnsCard();
  $('default-action').value = currentConfig.default_action;
  renderJsonCard();
}

function renderDnsCard() {
  const dns = currentConfig.dns ?? {};
  $('dns-ttl').value = String(dns.cache_ttl_seconds ?? 300);
  $('dns-neg-ttl').value = String(dns.negative_cache_ttl_seconds ?? 30);
  $('dns-timeout').value = String(dns.timeout_ms ?? 1500);
  $('dns-match-strategy').value = dns.match_strategy === 'all' ? 'all' : 'first';
}

function readDnsForm() {
  return {
    cache_ttl_seconds: Number($('dns-ttl').value),
    negative_cache_ttl_seconds: Number($('dns-neg-ttl').value),
    timeout_ms: Number($('dns-timeout').value),
    match_strategy: $('dns-match-strategy').value === 'all' ? 'all' : 'first',
  };
}

function updateJsonOutOfSync() {
  const editor = $('json-editor');
  if (!editor) return;
  const expected = JSON.stringify(currentConfig, null, 2);
  if (editor.value === lastRenderedJson || editor.value === expected) {
    editor.value = expected;
    lastRenderedJson = expected;
    setStatus('json-status', '', 'muted');
    return;
  }
  setStatus('json-status', 'Out of sync — click Revert to refresh', 'muted');
}

function renderRules() {
  const list = $('rules-list');
  list.replaceChildren();
  if (currentConfig.rules.length === 0) {
    list.appendChild(elem('p', { class: 'muted' }, 'No rules — add one below'));
    return;
  }
  currentConfig.rules.forEach((rule, index) => list.appendChild(renderRule(rule, index)));
}

function renderRule(rule, index) {
  const card = elem('div', { class: `rule ${rule.enabled ? '' : 'disabled'}` });
  const enabledToggle = elem('input', { type: 'checkbox', checked: rule.enabled });
  enabledToggle.addEventListener('change', () => updateRule(index, { enabled: enabledToggle.checked }));

  const actionLabel = elem('span', { class: rule.action === 'block' ? 'action-block' : 'action-allow' }, rule.action.toUpperCase());
  const biBadge = rule.bidirectional ? elem('span', { class: 'rule-badge', title: 'Fires in both directions' }, '↔ bidirectional') : null;

  const actions = elem('div', { class: 'rule-actions' },
    button('Up', () => moveRule(index, -1), { disabled: index === 0 }),
    button('Down', () => moveRule(index, 1), { disabled: index === currentConfig.rules.length - 1 }),
    button('Edit', () => openRuleEditor(index)),
    button('Clone', () => cloneRule(index)),
    button('Delete', () => deleteRule(index), { class: 'danger' }),
  );

  card.append(
    elem('div', { class: 'rule-header' },
      enabledToggle,
      elem('span', { class: 'rule-name' }, rule.name || `Rule ${index + 1}`),
      actionLabel,
      biBadge,
      actions,
    ),
    elem('div', { class: 'rule-summary' },
      rule.bidirectional
        ? `IF website ${describeMatcher(rule.website)} ↔ resource ${describeMatcher(rule.resource)} → ${rule.action.toUpperCase()}`
        : `IF website ${describeMatcher(rule.website)} AND resource ${describeMatcher(rule.resource)} → ${rule.action.toUpperCase()}`,
    ),
  );
  return card;
}

function describeMatcher(matcher) {
  if (!matcher) return '?';
  switch (matcher.kind) {
    case 'any': return 'ANY';
    case 'geosite': return `geosite:${matcher.tag}${matcher.attr ? '@' + matcher.attr : ''}`;
    case 'geoip':   return `geoip:${matcher.tag}`;
    case 'domain':  return `domain:/${matcher.regex}/`;
    case 'url':     return `url:/${matcher.regex}/`;
    case 'ip':      return `ip:${matcher.cidr}`;
    case 'all_of':  return `(${matcher.terms.map(describeMatcher).join(' AND ')})`;
    case 'any_of':  return `(${matcher.terms.map(describeMatcher).join(' OR ')})`;
    case 'not':     return `NOT ${describeMatcher(matcher.term)}`;
    default: return JSON.stringify(matcher);
  }
}

function mutate(mutator) {
  const next = structuredClone(currentConfig);
  mutator(next);
  return persist(next);
}

function updateRule(index, patch) {
  return mutate(next => { next.rules[index] = { ...next.rules[index], ...patch }; });
}

function moveRule(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= currentConfig.rules.length) return;
  return mutate(next => {
    const [item] = next.rules.splice(index, 1);
    next.rules.splice(target, 0, item);
  });
}

function cloneRule(index) {
  return mutate(next => {
    const original = next.rules[index];
    next.rules.splice(index + 1, 0, { ...structuredClone(original), name: `${original.name || 'Rule'} (copy)` });
  });
}

function deleteRule(index) {
  if (!confirm('Delete this rule?')) return;
  return mutate(next => { next.rules.splice(index, 1); });
}

async function persist(config) {
  suppressNextRender = true;
  const reply = await send({ kind: 'config.save', config });
  if (!reply?.ok) {
    suppressNextRender = false;
    const detail = (reply?.errors ?? []).map(error => `${error.path}: ${error.message}`).join('; ');
    showCardBanner('rules-card', `Save failed: ${detail || reply?.error || 'unknown error'}`, 'error');
    return false;
  }
  currentConfig = reply.config;
  lastRenderedJson = JSON.stringify(currentConfig, null, 2);
  renderAll();
  return true;
}

function openRuleEditor(index) {
  const isNew = index === -1;
  const rule = isNew
    ? { name: '', enabled: true, bidirectional: false, website: { kind: 'any' }, resource: { kind: 'any' }, action: 'block' }
    : structuredClone(currentConfig.rules[index]);

  $('rule-dialog-title').textContent = isNew ? 'New rule' : 'Edit rule';
  $('rule-name').value = rule.name;
  $('rule-enabled').checked = rule.enabled !== false;
  $('rule-bidirectional').checked = rule.bidirectional === true;
  $('rule-action').value = rule.action;
  $('rule-error').textContent = '';

  const websiteEditor = mountMatcherEditor($('rule-website'), rule.website);
  const resourceEditor = mountMatcherEditor($('rule-resource'), rule.resource);

  $('rule-save').onclick = async event => {
    event.preventDefault();
    rule.name = $('rule-name').value.trim();
    rule.enabled = $('rule-enabled').checked;
    rule.bidirectional = $('rule-bidirectional').checked;
    rule.action = $('rule-action').value;
    rule.website = websiteEditor.read();
    rule.resource = resourceEditor.read();

    const next = structuredClone(currentConfig);
    if (isNew) next.rules.push(rule);
    else next.rules[index] = rule;
    const validation = await send({ kind: 'config.validate', config: next });
    if (!validation?.ok || !validation.validation.ok) {
      const errors = validation?.validation?.errors ?? [];
      $('rule-error').textContent = errors.map(error => `${error.path}: ${error.message}`).join('; ') || 'Invalid rule';
      return;
    }
    $('rule-dialog').close();
    await persist(next);
  };

  $('rule-dialog').showModal();
}

function mountMatcherEditor(host, initial) {
  host.replaceChildren();
  const node = normalizeMatcher(initial);
  const editor = createMatcherEditor(node);
  host.appendChild(editor.element);
  return editor;
}

function createMatcherEditor(node) {
  const root = elem('div', { class: 'matcher-node' });
  const headerRow = elem('div', { class: 'matcher-row' });
  const body = elem('div', { class: 'matcher-body' });

  const kindSelect = elem('select', {});
  for (const kind of ALL_KINDS) {
    kindSelect.appendChild(elem('option', { value: kind }, KIND_LABELS[kind] ?? kind));
  }
  kindSelect.value = node.kind;
  kindSelect.addEventListener('change', () => {
    const next = convertKind(node, kindSelect.value);
    Object.keys(node).forEach(key => delete node[key]);
    Object.assign(node, next);
    if (!Array.isArray(node.children)) node.children = [];
    rerender();
  });

  headerRow.appendChild(kindSelect);
  root.append(headerRow, body);
  rerender();

  function leafInput(opts) {
    const input = elem('input', { type: 'text', ...opts });
    input.addEventListener('input', () => opts.onChange(input));
    headerRow.appendChild(input);
    return input;
  }

  function validatedLeaf(opts) {
    const hint = elem('span', { class: 'inline-validation error' });
    const input = leafInput({
      ...opts,
      onChange: el => {
        opts.onChange(el);
        const result = opts.validate(el.value);
        hint.textContent = result || '';
        el.classList.toggle('invalid', !!result);
      },
    });
    const initial = opts.validate(input.value);
    hint.textContent = initial || '';
    input.classList.toggle('invalid', !!initial);
    body.appendChild(hint);
  }

  function rerender() {
    headerRow.replaceChildren(kindSelect);
    body.replaceChildren();

    if (node.kind === 'any') return;

    if (node.kind === 'geosite') {
      leafInput({
        placeholder: 'tag or tag@attr (e.g. google or google@cn)',
        value: formatGeositeRef(node),
        onChange: input => {
          const ref = parseGeositeRef(input.value);
          if (ref) {
            node.tag = ref.tag;
            if (ref.attr) node.attr = ref.attr; else delete node.attr;
          } else {
            node.tag = '';
            delete node.attr;
          }
        },
      });
      return;
    }

    if (node.kind === 'geoip') {
      leafInput({
        placeholder: 'country code (e.g. CN)',
        value: typeof node.tag === 'string' ? node.tag : '',
        onChange: input => { node.tag = input.value.trim().toLowerCase(); },
      });
      return;
    }

    if (node.kind === 'domain') {
      validatedLeaf({
        placeholder: 'regex (e.g. \\.example\\.com$)',
        value: node.regex ?? '',
        onChange: input => { node.regex = input.value; },
        validate: value => {
          if (!value) return '';
          try { new RegExp(value); return ''; }
          catch (error) { return `invalid regex: ${error.message}`; }
        },
      });
      return;
    }

    if (node.kind === 'url') {
      validatedLeaf({
        placeholder: 'regex against full URL (e.g. ^https://example\\.com/api/)',
        value: node.regex ?? '',
        onChange: input => { node.regex = input.value; },
        validate: value => {
          if (!value) return '';
          try { new RegExp(value); return ''; }
          catch (error) { return `invalid regex: ${error.message}`; }
        },
      });
      return;
    }

    if (node.kind === 'ip') {
      validatedLeaf({
        placeholder: 'CIDR (e.g. 10.0.0.0/8 or 2001:db8::/32)',
        value: node.cidr ?? '',
        onChange: input => { node.cidr = input.value.trim(); },
        validate: value => (!value || parseCidr(value)) ? '' : 'invalid CIDR',
      });
      return;
    }

    if (node.kind === '__advanced__') {
      const area = elem('textarea', { rows: 6, spellcheck: false });
      area.value = node.json ?? '{}';
      area.addEventListener('input', () => { node.json = area.value; });
      body.appendChild(area);
      return;
    }

    if (node.kind === 'all_of' || node.kind === 'any_of') {
      if (!Array.isArray(node.children)) node.children = [];
      headerRow.appendChild(button('+ Add term', () => {
        node.children.push(normalizeMatcher({ kind: 'any' }));
        rerender();
      }, { class: 'matcher-add-term' }));
      const childrenWrap = elem('div', { class: 'matcher-children matcher-nested' });
      node.children.forEach((child, index) => childrenWrap.appendChild(renderChild(child, index)));
      body.append(childrenWrap);
      return;
    }

    if (node.kind === 'not') {
      if (!Array.isArray(node.children) || node.children.length === 0) {
        node.children = [normalizeMatcher({ kind: 'any' })];
      }
      const wrap = elem('div', { class: 'matcher-children matcher-nested' });
      wrap.appendChild(createMatcherEditor(node.children[0]).element);
      body.appendChild(wrap);
    }
  }

  function renderChild(childNode, index) {
    const list = node.children;
    const swap = (a, b) => { [list[a], list[b]] = [list[b], list[a]]; rerender(); };
    return elem('div', { class: 'matcher-child' },
      createMatcherEditor(childNode).element,
      elem('div', { class: 'matcher-child-controls' },
        button('↑', () => swap(index, index - 1), { disabled: index === 0 }),
        button('↓', () => swap(index, index + 1), { disabled: index === list.length - 1 }),
        button('✕', () => { list.splice(index, 1); rerender(); }),
      ),
    );
  }

  return { element: root, read: () => serializeMatcher(node) };
}

function renderDataCard(status, errors, updating = {}) {
  const allBtn = $('data-update-all');
  const anyUpdating = !!(updating.geoip || updating.geosite);
  allBtn.disabled = anyUpdating;
  allBtn.textContent = anyUpdating ? 'Updating…' : 'Update all now';

  for (const kind of ['geoip', 'geosite']) {
    const host = $(`data-${kind}`);
    host.replaceChildren();
    const isUpdating = !!updating[kind];
    const source = currentConfig?.data_sources?.[kind] ?? {};

    host.append(
      elem('div', { class: 'row' },
        elem('span', { class: 'data-title' }, kind),
        validatedInput({
          type: 'url',
          placeholder: `${kind}.dat URL (https)`,
          value: source.url ?? '',
          validate: isHttpsUrl,
          message: 'Must be an https URL',
          'data-field': 'url',
        }),
      ),
      elem('div', { class: 'row' },
        elem('span', { class: 'data-title muted' }, 'sha256'),
        validatedInput({
          type: 'url',
          placeholder: 'optional SHA-256 sum URL (e.g. .../geoip.dat.sha256sum)',
          value: source.sha256_url ?? '',
          validate: isHttpsUrl,
          message: 'Must be an https URL or empty',
          spellcheck: false,
          'data-field': 'sha256_url',
        }),
      ),
      elem('div', { class: 'row spaced' },
        labelInline('Auto-update', elem('input', {
          type: 'checkbox',
          checked: source.auto_update ?? true,
          'data-field': 'auto_update',
        })),
        labelInline('Interval (h)', elem('input', {
          type: 'number',
          min: '1',
          class: 'num-fixed',
          value: String(source.interval_hours ?? 24),
          'data-field': 'interval_hours',
        })),
        elem('div', { class: 'row-actions' },
          elem('span', { id: `data-${kind}-status`, class: 'status-text muted', 'aria-live': 'polite' }),
          button('Save', () => saveDataSource(kind)),
          button(isUpdating ? 'Updating…' : 'Update', () => triggerDataUpdate(kind), {
            disabled: isUpdating || !source.url,
            title: source.url ? '' : 'Set a URL first',
          }),
          isUpdating ? elem('span', { class: 'spinner', 'aria-label': 'updating' }) : null,
        ),
      ),
      describeStatus(status?.[kind], errors?.[kind], isUpdating),
    );
  }
}

function readDataSourceForm(kind) {
  const host = $(`data-${kind}`);
  const existing = currentConfig?.data_sources?.[kind] ?? {};
  return {
    ...existing,
    url: host.querySelector('[data-field="url"]').value.trim(),
    sha256_url: host.querySelector('[data-field="sha256_url"]').value.trim(),
    auto_update: host.querySelector('[data-field="auto_update"]').checked,
    interval_hours: Number(host.querySelector('[data-field="interval_hours"]').value) || 24,
  };
}

async function saveDataSource(kind) {
  const ok = await mutate(next => { next.data_sources[kind] = readDataSourceForm(kind); });
  if (ok) flashStatus(`data-${kind}-status`, 'Saved', 'ok', 2000);
  else setStatus(`data-${kind}-status`, 'Invalid values', 'error');
}

async function saveAllDataSources() {
  const ok = await mutate(next => {
    next.data_sources.geoip = readDataSourceForm('geoip');
    next.data_sources.geosite = readDataSourceForm('geosite');
  });
  if (ok) flashStatus('data-save-all-status', 'Saved', 'ok', 2000);
  else setStatus('data-save-all-status', 'Invalid values', 'error');
}

function describeStatus(meta, error, isUpdating) {
  const props = { class: 'meta', 'aria-live': 'polite' };
  if (isUpdating) return elem('div', props, 'Downloading…');
  if (error) return elem('div', { ...props, class: 'meta error' }, `Error: ${error}`);
  if (!meta) return elem('div', props, 'Not loaded');
  const when = meta.savedAt ? new Date(meta.savedAt).toLocaleString() : '—';
  const verified = meta.shaVerified ? ' · sha verified' : '';
  return elem('div', props, `Loaded ${when} · ${meta.tagCount} tags · ${meta.entryCount} entries${verified}`);
}

function labelInline(text, child) {
  const label = elem('label', { class: 'inline' });
  if (child.type === 'checkbox') label.append(child, document.createTextNode(text));
  else label.append(document.createTextNode(text), child);
  return label;
}

async function triggerDataUpdate(target) {
  const updatePromise = send({ kind: 'data.update', target });
  setTimeout(refreshData, 50);
  const reply = await updatePromise;
  if (!reply?.ok) showCardBanner('data-card', `Update failed: ${reply?.error ?? 'unknown'}`, 'error');
  await refreshData();
}

function renderRemoteCard() {
  const remote = currentRemoteSettings ?? defaultRemoteForm();
  $('remote-url').value = remote.url;
  $('remote-auto').checked = !!remote.auto_update;
  $('remote-interval').value = String(remote.interval_hours);
}

function renderJsonCard() {
  const json = JSON.stringify(currentConfig, null, 2);
  $('json-editor').value = json;
  lastRenderedJson = json;
  setStatus('json-status', '', 'muted');
}

function readRemoteForm() {
  return {
    url: $('remote-url').value.trim(),
    auto_update: $('remote-auto').checked,
    interval_hours: Number($('remote-interval').value) || 24,
  };
}

function bindStaticEvents() {
  $('rule-add').addEventListener('click', () => openRuleEditor(-1));
  $('test-run').addEventListener('click', runTester);
  $('data-update-all').addEventListener('click', () => triggerDataUpdate('all'));
  $('data-save-all').addEventListener('click', saveAllDataSources);

  $('remote-save').addEventListener('click', async () => {
    const reply = await send({ kind: 'remote.save', settings: readRemoteForm() });
    if (reply?.ok) {
      currentRemoteSettings = reply.settings;
      flashStatus('remote-status', 'Saved', 'ok', 2000);
    } else {
      const detail = (reply?.errors ?? []).map(item => `${item.path}: ${item.message}`).join('; ');
      setStatus('remote-status', detail || 'Invalid values', 'error');
    }
  });

  $('dns-save').addEventListener('click', async () => {
    const ok = await mutate(next => { next.dns = readDnsForm(); });
    if (ok) flashStatus('dns-status', 'Saved', 'ok', 2000);
    else setStatus('dns-status', 'Invalid values', 'error');
  });

  $('dns-clear-cache').addEventListener('click', async () => {
    const reply = await send({ kind: 'dns.clearCache' });
    if (reply?.ok) flashStatus('dns-status', 'Cache cleared', 'ok', 2000);
    else setStatus('dns-status', `Error: ${reply?.error ?? 'unknown'}`, 'error');
  });

  $('remote-fetch').addEventListener('click', async () => {
    const form = readRemoteForm();
    if (!form.url) { setStatus('remote-status', 'URL is empty', 'error'); return; }
    const stored = currentRemoteSettings ?? defaultRemoteForm();
    const dirty = form.url !== stored.url
      || form.auto_update !== stored.auto_update
      || form.interval_hours !== stored.interval_hours;
    if (dirty) {
      const saveReply = await send({ kind: 'remote.save', settings: form });
      if (!saveReply?.ok) {
        const detail = (saveReply?.errors ?? []).map(item => `${item.path}: ${item.message}`).join('; ');
        setStatus('remote-status', detail || 'Invalid values', 'error');
        return;
      }
      currentRemoteSettings = saveReply.settings;
    }
    setStatus('remote-status', 'Fetching…', 'muted');
    const reply = await send({ kind: 'config.fetchRemote' });
    if (!reply?.ok) {
      setStatus('remote-status', `Error: ${reply?.error ?? 'unknown'}`, 'error');
      return;
    }
    flashStatus('remote-status', 'Applied', 'ok', 2500);
  });

  $('default-action').addEventListener('change', event => {
    mutate(next => { next.default_action = event.target.value; });
  });

  $('export-config').addEventListener('click', exportConfig);
  $('import-config').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importConfig);
  $('reset-config').addEventListener('click', async () => {
    if (confirm('Reset configuration to empty defaults?')) await send({ kind: 'config.reset' });
  });

  $('json-apply').addEventListener('click', applyJson);
  $('json-revert').addEventListener('click', renderJsonCard);
}

async function runTester() {
  const websiteUrl = $('test-website').value.trim();
  const resourceUrl = $('test-resource').value.trim();
  const resourceIp = $('test-ip').value.trim();
  const output = $('test-output');
  if (!resourceUrl) {
    output.replaceChildren(elem('span', { class: 'muted' }, 'Provide a resource URL'));
    return;
  }
  output.replaceChildren(elem('span', { class: 'muted' }, 'Evaluating…'));
  const reply = await send({ kind: 'tester.evaluate', websiteUrl, resourceUrl, resourceIp });
  if (!reply?.ok) {
    output.replaceChildren(elem('span', { class: 'error' }, `Error: ${reply?.error ?? 'unknown'}`));
    return;
  }
  output.replaceChildren(elem('pre', { class: 'tester-pre' }, formatTesterResult(reply.result)));
}

function formatTesterResult(result) {
  const lines = [`Verdict: ${result.verdict.toUpperCase()}`];
  lines.push(result.matchedRule
    ? `Matched rule: #${result.matchedRule.index + 1}${result.matchedRule.name ? ` (${result.matchedRule.name})` : ''}${result.matchedRule.direction ? ` [${result.matchedRule.direction}]` : ''}`
    : 'No rule matched; default action applied');
  if (result.contexts) {
    lines.push(`Website:  host=${result.contexts.website?.host ?? '?'} ips=${formatIps(result.contexts.website?.ips)}`);
    lines.push(`Resource: host=${result.contexts.resource?.host ?? '?'} ips=${formatIps(result.contexts.resource?.ips)}`);
  }
  if (result.trace?.length) {
    lines.push('Trace:');
    for (const step of result.trace) {
      const biTag = step.bidirectional ? ' bidirectional' : '';
      lines.push(`  rule #${step.ruleIndex + 1} (${step.ruleName || '-'}) action=${step.action}${biTag} -> website=${formatHit(step.websiteHit)}, resource=${formatHit(step.resourceHit)}`);
      if (step.websiteTrace) lines.push('    website matcher:', ...formatMatcherTrace(step.websiteTrace, 6));
      if (step.resourceTrace) lines.push('    resource matcher:', ...formatMatcherTrace(step.resourceTrace, 6));
      if (step.bidirectional && step.reverseWebsiteHit !== null) {
        lines.push(`    reverse pass (swapped) -> website=${formatHit(step.reverseWebsiteHit)}, resource=${formatHit(step.reverseResourceHit)}`);
        if (step.reverseWebsiteTrace) lines.push('      website matcher:', ...formatMatcherTrace(step.reverseWebsiteTrace, 8));
        if (step.reverseResourceTrace) lines.push('      resource matcher:', ...formatMatcherTrace(step.reverseResourceTrace, 8));
      }
    }
  }
  return lines.join('\n');
}

function formatIps(ips) {
  return Array.isArray(ips) && ips.length ? ips.join(', ') : 'unresolved';
}

function formatHit(value) {
  if (value === undefined) return '—';
  if (value === null) return 'n/a';
  return value ? 'HIT' : 'miss';
}

function formatMatcherTrace(node, indent) {
  if (!node) return [];
  const pad = ' '.repeat(indent);
  const lines = [`${pad}${describeTraceNode(node)}`];
  const children = node.terms ?? (node.term ? [node.term] : []);
  for (const child of children) {
    if (child) lines.push(...formatMatcherTrace(child, indent + 2));
  }
  return lines;
}

function describeTraceNode(node) {
  const verdict = node.hit === null ? '[?]' : node.hit ? '[+]' : '[-]';
  const note = node.note ? ` (${node.note})` : '';
  switch (node.kind) {
    case 'any': return `${verdict} any`;
    case 'geosite': return `${verdict} geosite:${node.tag || '?'}${node.attr ? '@' + node.attr : ''} host=${node.host || '?'}${note}`;
    case 'geoip':   return `${verdict} geoip:${node.tag || '?'} ips=${formatIps(node.ips)}${note}`;
    case 'domain':  return `${verdict} domain:/${node.regex}/ host=${node.host || '?'}${note}`;
    case 'ip':      return `${verdict} ip:${node.cidr} ips=${formatIps(node.ips)}${note}`;
    case 'all_of':  return `${verdict} AND${note}`;
    case 'any_of':  return `${verdict} OR${note}`;
    case 'not':     return `${verdict} NOT${note}`;
    default:        return `${verdict} ${node.kind}${note}`;
  }
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(currentConfig, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = elem('a', { href: url, download: 'geolock-config.json' });
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importConfig(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const validation = await send({ kind: 'config.validate', config: parsed });
    if (!validation?.ok || !validation.validation.ok) {
      const errors = validation?.validation?.errors ?? [];
      showCardBanner('json-card', `Import failed: ${errors.map(e => `${e.path}: ${e.message}`).join('; ') || 'invalid'}`, 'error');
      return;
    }
    const incoming = validation.normalized;
    if (!confirm(`Import ${file.name}?\n\n${describeImportDiff(currentConfig, incoming)}\n\nThis replaces the current configuration.`)) return;
    const reply = await send({ kind: 'config.save', config: incoming });
    if (!reply?.ok) {
      const detail = (reply?.errors ?? []).map(item => `${item.path}: ${item.message}`).join('; ');
      showCardBanner('json-card', `Import failed: ${detail || reply?.error || 'invalid'}`, 'error');
    } else {
      showCardBanner('json-card', `Imported ${file.name}`, 'ok', 3000);
    }
  } catch (error) {
    showCardBanner('json-card', `Import failed: ${error.message}`, 'error');
  } finally {
    event.target.value = '';
  }
}

function describeImportDiff(current, incoming) {
  const lines = [`• Rules: ${current?.rules?.length ?? 0} → ${incoming.rules.length}`];
  if (current?.default_action !== incoming.default_action) {
    lines.push(`• Default action: ${current?.default_action} → ${incoming.default_action}`);
  }
  for (const kind of ['geoip', 'geosite']) {
    const a = current?.data_sources?.[kind]?.url ?? '';
    const b = incoming.data_sources?.[kind]?.url ?? '';
    if (a !== b) lines.push(`• ${kind} URL: ${a || '(empty)'} → ${b || '(empty)'}`);
  }
  return lines.length === 1 && current?.rules?.length === incoming.rules.length ? 'No changes detected' : lines.join('\n');
}

async function applyJson() {
  try {
    const parsed = JSON.parse($('json-editor').value);
    const reply = await send({ kind: 'config.save', config: parsed });
    if (!reply?.ok) {
      const detail = (reply?.errors ?? []).map(item => `${item.path}: ${item.message}`).join('; ');
      setStatus('json-status', `Invalid: ${detail || reply?.error}`, 'error');
      return;
    }
    flashStatus('json-status', 'Applied', 'ok', 2000);
  } catch (error) {
    setStatus('json-status', `Parse error: ${error.message}`, 'error');
  }
}

function setStatus(id, text, kind) {
  const node = $(id);
  node.textContent = text;
  node.className = `status-text ${kind}`;
}

function flashStatus(id, text, kind, ms) {
  setStatus(id, text, kind);
  setTimeout(() => setStatus(id, '', 'muted'), ms);
}

const cardBannerTimers = new Map();

function showCardBanner(cardId, text, kind = 'error', autoHideMs = 6000) {
  const card = $(cardId);
  if (!card) return;
  let banner = card.querySelector(':scope > .card-banner');
  if (!banner) {
    banner = elem('div', { class: 'card-banner' });
    card.insertBefore(banner, card.firstChild);
  }
  banner.textContent = text;
  banner.className = `card-banner banner ${kind}`;
  if (cardBannerTimers.has(cardId)) clearTimeout(cardBannerTimers.get(cardId));
  if (autoHideMs > 0) {
    cardBannerTimers.set(cardId, setTimeout(() => {
      banner.remove();
      cardBannerTimers.delete(cardId);
    }, autoHideMs));
  }
}

function elem(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function button(label, onClick, props = {}) {
  return elem('button', { ...props, onclick: onClick }, label);
}

function validatedInput({ validate, message, ...inputProps }) {
  const wrap = elem('div', { class: 'validated' });
  const input = elem('input', inputProps);
  const hint = elem('div', { class: 'validation-message error' });
  const update = () => {
    const ok = !validate || validate(input.value);
    wrap.classList.toggle('invalid', !ok);
    hint.textContent = ok ? '' : (message ?? 'Invalid value');
  };
  input.addEventListener('input', update);
  input.addEventListener('blur', update);
  update();
  wrap.append(input, hint);
  return wrap;
}

init();
