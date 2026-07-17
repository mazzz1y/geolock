import { normalizeMatcher, serializeMatcher, convertType, TYPE_LABELS, ALL_TYPES } from './matcher-tree.js';
import { parseGeositeRef, formatGeositeRef } from '../../lib/geosite-ref.js';
import { parseCidr, parseIp } from '../../lib/ip.js';
import { buildTraceView } from '../lib/trace-view.js';
import { elem } from '../lib/dom.js';

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
  renderRemoteTimestamps(reply.remoteLastAppliedAt);
  renderRemoteError(reply.errors?.remote);
}

function renderRemoteTimestamps(appliedAt) {
  const node = $('remote-last-fetched');
  if (!node) return;
  node.textContent = appliedAt ? `Last applied ${new Date(appliedAt).toLocaleString()}` : '';
}

function renderRemoteError(error) {
  const node = $('remote-error');
  if (!node) return;
  node.textContent = error ? `Last update error: ${error}` : '';
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
  $('dns-timeout').value = String(dns.timeout_ms ?? 5000);
  $('dns-match-strategy').value = dns.match_strategy === 'all' ? 'all' : 'first';
}

function readDnsForm() {
  const dns = currentConfig?.dns ?? {};
  const numberOr = (id, fallback) => {
    const raw = $(id).value.trim();
    return raw === '' ? fallback : Number(raw);
  };
  return {
    cache_ttl_seconds: numberOr('dns-ttl', dns.cache_ttl_seconds ?? 300),
    negative_cache_ttl_seconds: numberOr('dns-neg-ttl', dns.negative_cache_ttl_seconds ?? 30),
    timeout_ms: numberOr('dns-timeout', dns.timeout_ms ?? 5000),
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
  const enabledToggle = elem('input', { type: 'checkbox', checked: rule.enabled, 'aria-label': `Enable rule ${rule.name || index + 1}` });
  enabledToggle.addEventListener('change', () => updateRule(index, { enabled: enabledToggle.checked }));

  const actionLabel = elem('span', { class: rule.action === 'block' ? 'action-block' : 'action-allow' }, rule.action.toUpperCase());
  const isolate = rule.mode === 'isolate';
  const isolateBadge = isolate ? elem('span', { class: 'rule-badge', title: 'Matches when source XOR destination is in the match' }, 'isolate') : null;
  const biBadge = !isolate && rule.bidirectional
    ? elem('span', { class: 'rule-badge', title: 'Fires in both directions' }, 'bidirectional')
    : null;
  const stripBadge = rule.strip_referrer
    ? elem('span', { class: 'rule-badge', title: 'Strip Referrer on top-level navigations that match this rule' }, 'strip-referrer')
    : null;

  const actions = elem('div', { class: 'rule-actions' },
    button('Up', () => moveRule(index, -1), { disabled: index === 0 }),
    button('Down', () => moveRule(index, 1), { disabled: index === currentConfig.rules.length - 1 }),
    button('Edit', () => openRuleEditor(index)),
    button('Clone', () => cloneRule(index)),
    button('Delete', () => deleteRule(index), { class: 'danger' }),
  );

  const summaryText = isolate
    ? `ISOLATE ${describeMatcher(rule.match)}`
    : (rule.bidirectional
      ? `SRC ${describeMatcher(rule.source)} ↔ DST ${describeMatcher(rule.destination)}`
      : `SRC ${describeMatcher(rule.source)} → DST ${describeMatcher(rule.destination)}`);

  card.append(
    elem('div', { class: 'rule-header' },
      enabledToggle,
      elem('span', { class: 'rule-name' }, rule.name || `Rule ${index + 1}`),
      actionLabel,
      isolateBadge,
      biBadge,
      stripBadge,
      actions,
    ),
    elem('div', { class: 'rule-summary' }, summaryText),
  );
  return card;
}

function describeMatcher(matcher) {
  if (!matcher) return '?';
  switch (matcher.type) {
    case 'any': return 'ANY';
    case 'geosite': return `geosite:${matcher.tag}${matcher.attr ? '@' + matcher.attr : ''}`;
    case 'geoip':   return `geoip:${matcher.tag}`;
    case 'ruleset': return `ruleset:${matcher.tag}`;
    case 'domain':  return `domain:/${matcher.regex}/`;
    case 'url':     return `url:/${matcher.regex}/`;
    case 'ip':      return `ip:${matcher.cidr}`;
    case 'and':  return `(${matcher.matches.map(describeMatcher).join(' AND ')})`;
    case 'or':  return `(${matcher.matches.map(describeMatcher).join(' OR ')})`;
    case 'not':     return `NOT ${describeMatcher(matcher.match)}`;
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
    renderAll();
    return false;
  }
  currentConfig = reply.config;
  lastRenderedJson = JSON.stringify(currentConfig, null, 2);
  renderAll();
  return true;
}

function openRuleEditor(index) {
  const isNew = index === -1;
  const existing = isNew ? null : structuredClone(currentConfig.rules[index]);
  const initialMode = existing?.mode === 'isolate' ? 'isolate' : 'flow';

  $('rule-dialog-title').textContent = isNew ? 'New rule' : 'Edit rule';
  $('rule-name').value = existing?.name ?? '';
  $('rule-enabled').checked = existing ? existing.enabled !== false : true;
  $('rule-action').value = existing?.action ?? 'block';
  $('rule-strip-referrer').checked = existing?.strip_referrer === true;
  $('rule-bidirectional').checked = existing?.bidirectional === true;
  $('rule-type').value = initialMode;
  $('rule-error').textContent = '';

  const flowSourceInitial = existing?.mode === 'isolate' ? { type: 'any' } : (existing?.source ?? { type: 'any' });
  const flowDestinationInitial = existing?.mode === 'isolate' ? { type: 'any' } : (existing?.destination ?? { type: 'any' });
  const isolateMatchInitial = existing?.mode === 'isolate' ? (existing?.match ?? { type: 'any' }) : { type: 'any' };

  const sourceEditor = mountMatcherEditor($('rule-source'), flowSourceInitial);
  const destinationEditor = mountMatcherEditor($('rule-destination'), flowDestinationInitial);
  const matchEditor = mountMatcherEditor($('rule-match'), isolateMatchInitial);

  const updateVisibility = () => {
    const isolate = $('rule-type').value === 'isolate';
    const isBlock = $('rule-action').value === 'block';
    $('rule-flow-fieldsets').hidden = isolate;
    $('rule-flow-destination-fieldset').hidden = isolate;
    $('rule-isolate-fieldset').hidden = !isolate;
    $('rule-bidirectional-row').hidden = isolate;
    $('rule-bidirectional-hint').hidden = isolate;
    $('rule-type-hint-flow').hidden = isolate;
    $('rule-type-hint-isolate').hidden = !isolate;
    $('rule-strip-referrer-row').hidden = !isBlock;
    $('rule-strip-referrer-hint').hidden = !isBlock;
  };
  updateVisibility();
  $('rule-action').onchange = updateVisibility;
  $('rule-type').onchange = updateVisibility;

  $('rule-save').onclick = async event => {
    event.preventDefault();
    const isolate = $('rule-type').value === 'isolate';
    const action = $('rule-action').value;
    const stripFlag = action === 'block' && $('rule-strip-referrer').checked;
    let rule;
    try {
      rule = isolate
      ? {
          name: $('rule-name').value.trim(),
          enabled: $('rule-enabled').checked,
          mode: 'isolate',
          match: matchEditor.read(),
          action,
          strip_referrer: stripFlag,
        }
      : {
          name: $('rule-name').value.trim(),
          enabled: $('rule-enabled').checked,
          bidirectional: $('rule-bidirectional').checked,
          source: sourceEditor.read(),
          destination: destinationEditor.read(),
          action,
          strip_referrer: stripFlag,
        };
    } catch (error) {
      $('rule-error').textContent = error.message;
      return;
    }

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

  const typeSelect = elem('select', {});
  for (const type of ALL_TYPES) {
    typeSelect.appendChild(elem('option', { value: type }, TYPE_LABELS[type] ?? type));
  }
  typeSelect.value = node.type;
  typeSelect.addEventListener('change', () => {
    const next = convertType(node, typeSelect.value);
    Object.keys(node).forEach(key => delete node[key]);
    Object.assign(node, next);
    if (!Array.isArray(node.children)) node.children = [];
    rerender();
  });

  headerRow.appendChild(typeSelect);
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
    headerRow.replaceChildren(typeSelect);
    body.replaceChildren();

    if (node.type === 'any') return;

    if (node.type === 'geosite') {
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

    if (node.type === 'geoip') {
      leafInput({
        placeholder: 'country code (e.g. CN)',
        value: typeof node.tag === 'string' ? node.tag : '',
        onChange: input => { node.tag = input.value.trim().toLowerCase(); },
      });
      return;
    }

    if (node.type === 'ruleset') {
      const names = Object.keys(currentConfig?.data_sources?.rulesets ?? {});
      if (names.length > 0) {
        const select = elem('select', { 'aria-label': 'Rule-set name' });
        if (node.tag && !names.includes(node.tag)) {
          select.appendChild(elem('option', { value: node.tag }, node.tag));
        }
        for (const name of names) select.appendChild(elem('option', { value: name }, name));
        if (!node.tag) node.tag = select.value;
        else select.value = node.tag;
        select.addEventListener('change', () => { node.tag = select.value; });
        headerRow.appendChild(select);
      } else {
        leafInput({
          placeholder: 'rule-set name',
          value: typeof node.tag === 'string' ? node.tag : '',
          onChange: input => { node.tag = input.value.trim(); },
        });
      }
      return;
    }

    if (node.type === 'domain') {
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

    if (node.type === 'url') {
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

    if (node.type === 'ip') {
      validatedLeaf({
        placeholder: 'CIDR (e.g. 10.0.0.0/8 or 2001:db8::/32)',
        value: node.cidr ?? '',
        onChange: input => { node.cidr = input.value.trim(); },
        validate: value => (!value || parseCidr(value)) ? '' : 'invalid CIDR',
      });
      return;
    }

    if (node.type === '__advanced__') {
      const area = elem('textarea', { rows: 6, spellcheck: false });
      area.value = node.json ?? '{}';
      area.addEventListener('input', () => { node.json = area.value; });
      body.appendChild(area);
      return;
    }

    if (node.type === 'and' || node.type === 'or') {
      if (!Array.isArray(node.children)) node.children = [];
      headerRow.appendChild(button('+ Add term', () => {
        node.children.push(normalizeMatcher({ type: 'any' }));
        rerender();
      }, { class: 'matcher-add-term' }));
      const childrenWrap = elem('div', { class: 'matcher-children matcher-nested' });
      node.children.forEach((child, index) => childrenWrap.appendChild(renderChild(child, index)));
      body.append(childrenWrap);
      return;
    }

    if (node.type === 'not') {
      if (!Array.isArray(node.children) || node.children.length === 0) {
        node.children = [normalizeMatcher({ type: 'any' })];
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
        button('↑', () => swap(index, index - 1), { disabled: index === 0, 'aria-label': 'Move term up' }),
        button('↓', () => swap(index, index + 1), { disabled: index === list.length - 1, 'aria-label': 'Move term down' }),
        button('✕', () => { list.splice(index, 1); rerender(); }, { 'aria-label': 'Remove term' }),
      ),
    );
  }

  return { element: root, read: () => serializeMatcher(node) };
}

const RULESET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function renderDataCard(status, errors, updating = {}) {
  const allBtn = $('data-update-all');
  const anyUpdating = !!(updating.geoip || updating.geosite || (updating.rulesets ?? []).length > 0);
  allBtn.disabled = anyUpdating;
  allBtn.textContent = anyUpdating ? 'Updating…' : 'Update all';

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

  renderRulesets(status, errors, updating);
}

function renderRulesets(status, errors, updating) {
  const host = $('data-rulesets');
  host.replaceChildren();
  const rulesets = currentConfig?.data_sources?.rulesets ?? {};
  const names = Object.keys(rulesets);
  const statusByName = new Map((status?.rulesets ?? []).map(item => [item.name, item]));
  const updatingNames = new Set(updating?.rulesets ?? []);
  for (const name of names) {
    host.appendChild(renderRulesetRow(
      name,
      rulesets[name] ?? {},
      statusByName.get(name),
      errors?.rulesets?.[name],
      updatingNames.has(name),
    ));
  }
  host.appendChild(renderRulesetDraftRow());
}

function renderRulesetDraftRow() {
  const row = elem('div', { class: 'data-row', id: 'ruleset-draft' });
  row.append(
    elem('div', { class: 'row' },
      elem('input', {
        type: 'text',
        id: 'ruleset-draft-name',
        class: 'ruleset-name-input',
        placeholder: 'name (e.g. ads)',
        autocomplete: 'off',
        spellcheck: false,
      }),
      validatedInput({
        type: 'url',
        id: 'ruleset-draft-url',
        placeholder: 'rule-set .srs URL (https)',
        validate: value => value === '' || isHttpsUrl(value),
        message: 'Must be an https URL',
      }),
      elem('div', { class: 'row-actions' },
        button('Add', saveRulesetDraft),
      ),
    ),
    elem('div', { class: 'meta', id: 'ruleset-draft-error', 'aria-live': 'polite' }),
  );
  return row;
}

async function saveRulesetDraft() {
  const errorNode = $('ruleset-draft-error');
  errorNode.className = 'meta error';
  const name = $('ruleset-draft-name').value.trim();
  const url = $('ruleset-draft-url').value.trim();
  if (!name || name.length > 64 || !RULESET_NAME_RE.test(name)) {
    errorNode.textContent = 'Name must match [a-z0-9][a-z0-9_-]* (max 64 chars)';
    return;
  }
  if (currentConfig?.data_sources?.rulesets?.[name]) {
    errorNode.textContent = 'A rule-set with this name already exists';
    return;
  }
  if (url && !isHttpsUrl(url)) {
    errorNode.textContent = 'URL must be https';
    return;
  }
  errorNode.textContent = '';
  const ok = await mutate(next => {
    next.data_sources.rulesets = {
      ...(next.data_sources.rulesets ?? {}),
      [name]: { url, sha256_url: '', auto_update: true, interval_hours: 24 },
    };
  });
  if (ok) await refreshData();
  else errorNode.textContent = 'Invalid values';
}

function renderRulesetRow(name, source, meta, error, isUpdating) {
  const row = elem('div', { class: 'data-row', 'data-ruleset': name });
  row.append(
    elem('div', { class: 'row' },
      elem('span', { class: 'data-title' }, name),
      validatedInput({
        type: 'url',
        placeholder: 'rule-set .srs URL (https)',
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
        placeholder: 'optional SHA-256 sum URL',
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
        elem('span', { id: `data-ruleset-${name}-status`, class: 'status-text muted', 'aria-live': 'polite' }),
        button('Save', () => saveRuleset(name)),
        button(isUpdating ? 'Updating…' : 'Update', () => triggerDataUpdate(`ruleset:${name}`), {
          disabled: isUpdating || !source.url,
          title: source.url ? '' : 'Set a URL first',
        }),
        button('✕', () => removeRuleset(name), { class: 'danger', 'aria-label': `Remove rule-set ${name}` }),
        isUpdating ? elem('span', { class: 'spinner', 'aria-label': 'updating' }) : null,
      ),
    ),
    describeRulesetStatus(meta, error, isUpdating),
  );
  return row;
}

function describeRulesetStatus(meta, error, isUpdating) {
  const props = { class: 'meta', 'aria-live': 'polite' };
  if (isUpdating) return elem('div', props, 'Downloading…');
  if (error) return elem('div', { ...props, class: 'meta error' }, `Error: ${error}`);
  if (meta?.error) return elem('div', { ...props, class: 'meta error' }, `Error: ${meta.error}`);
  if (!meta || !meta.savedAt) return elem('div', props, 'Not loaded');
  const when = new Date(meta.savedAt).toLocaleString();
  const verified = meta.shaVerified ? ' · sha verified' : '';
  const entries = meta.builtAt ? ` · ${meta.entryCount} entries` : '';
  return elem('div', props, `Loaded ${when}${entries}${verified}`);
}

function readRulesetForm(name) {
  const host = document.querySelector(`[data-ruleset="${CSS.escape(name)}"]`);
  const existing = currentConfig?.data_sources?.rulesets?.[name] ?? {};
  return {
    ...existing,
    url: host.querySelector('[data-field="url"]').value.trim(),
    sha256_url: host.querySelector('[data-field="sha256_url"]').value.trim(),
    auto_update: host.querySelector('[data-field="auto_update"]').checked,
    interval_hours: Number(host.querySelector('[data-field="interval_hours"]').value) || 24,
  };
}

async function saveRuleset(name) {
  const form = readRulesetForm(name);
  const ok = await mutate(next => {
    next.data_sources.rulesets = { ...(next.data_sources.rulesets ?? {}), [name]: form };
  });
  if (ok) flashStatus(`data-ruleset-${name}-status`, 'Saved', 'ok', 2000);
  else setStatus(`data-ruleset-${name}-status`, 'Invalid values', 'error');
}

async function removeRuleset(name) {
  if (!confirm(`Remove rule-set "${name}"?`)) return;
  await mutate(next => {
    if (next.data_sources.rulesets) delete next.data_sources.rulesets[name];
  });
  await refreshData();
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
    for (const name of Object.keys(next.data_sources.rulesets ?? {})) {
      next.data_sources.rulesets[name] = readRulesetForm(name);
    }
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
  const reply = await send({ kind: 'data.update', target });
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
  $('rule-cancel').addEventListener('click', () => $('rule-dialog').close());
  $('test-run').addEventListener('click', runTester);
  $('test-clear').addEventListener('click', () => {
    $('test-source').value = '';
    $('test-destination').value = '';
    $('test-destination-ip').value = '';
    $('test-destination-ip').dispatchEvent(new Event('input'));
    $('test-output').replaceChildren();
  });
  attachValidator(
    $('test-destination-ip'),
    $('test-destination-ip-hint'),
    { validate: parseIp, message: 'invalid IP' },
  );
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
  const sourceUrl = $('test-source').value.trim();
  const destinationUrl = $('test-destination').value.trim();
  const destinationIp = $('test-destination-ip').value.trim();
  const output = $('test-output');
  if (!destinationUrl) {
    output.replaceChildren(elem('span', { class: 'muted' }, 'Provide a destination URL'));
    return;
  }
  output.replaceChildren(elem('span', { class: 'muted' }, 'Evaluating…'));
  const reply = await send({ kind: 'tester.evaluate', sourceUrl, destinationUrl, destinationIp });
  if (!reply?.ok) {
    output.replaceChildren(elem('span', { class: 'error' }, `Error: ${reply?.error ?? 'unknown'}`));
    return;
  }
  const result = reply.result;
  const view = buildTraceView({
    source: sourceUrl || '',
    destination: destinationUrl || '',
    verdict: result.verdict,
    matchedRule: result.matchedRule,
    trace: result.trace ?? [],
    contexts: result.contexts,
    mode: 'full',
  });
  output.replaceChildren(view);
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

const flashStatusTimers = new Map();

function setStatus(id, text, kind) {
  if (flashStatusTimers.has(id)) {
    clearTimeout(flashStatusTimers.get(id));
    flashStatusTimers.delete(id);
  }
  const node = $(id);
  node.textContent = text;
  node.className = `status-text ${kind}`;
}

function flashStatus(id, text, kind, ms) {
  setStatus(id, text, kind);
  flashStatusTimers.set(id, setTimeout(() => {
    setStatus(id, '', 'muted');
    flashStatusTimers.delete(id);
  }, ms));
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

function button(label, onClick, props = {}) {
  return elem('button', { type: 'button', ...props, onclick: onClick }, label);
}

function attachValidator(input, hint, { validate, message }) {
  if (!input || !hint) return;
  const update = () => {
    const value = input.value.trim();
    const ok = !value || validate(value);
    input.classList.toggle('invalid', !ok);
    hint.textContent = ok ? '' : message;
  };
  input.addEventListener('input', update);
  input.addEventListener('blur', update);
  update();
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

init().catch(error => {
  const node = document.getElementById('status-line');
  if (node) node.textContent = `Initialization failed: ${error?.message ?? error}`;
});
