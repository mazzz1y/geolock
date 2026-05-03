import { formatMatcherTrace, formatIps, formatHit } from './trace-format.js';
import { elem } from './dom.js';

export function buildTraceView(payload) {
  const text = formatText(payload);
  const json = formatJson(payload);

  const wrap = elem('div', { class: 'trace-view' });

  const toolbar = elem('div', { class: 'trace-toolbar' });
  const btnText = elem('button', { class: 'view-toggle active', type: 'button' }, 'Text');
  const btnJson = elem('button', { class: 'view-toggle', type: 'button' }, 'JSON');
  const btnCopy = elem('button', {
    class: 'copy-icon-btn',
    type: 'button',
    title: 'Copy',
    'aria-label': 'Copy',
  }, copyIcon());

  toolbar.append(btnText, btnJson, btnCopy);

  const body = elem('pre', { class: 'trace-body' }, text);

  let mode = 'text';
  const setMode = next => {
    mode = next;
    btnText.classList.toggle('active', mode === 'text');
    btnJson.classList.toggle('active', mode === 'json');
    body.textContent = mode === 'text' ? text : json;
  };

  btnText.addEventListener('click', e => { e.preventDefault(); setMode('text'); });
  btnJson.addEventListener('click', e => { e.preventDefault(); setMode('json'); });
  btnCopy.addEventListener('click', async e => {
    e.preventDefault();
    const content = mode === 'text' ? text : json;
    try {
      await navigator.clipboard.writeText(content);
      btnCopy.classList.add('copied');
      btnCopy.disabled = true;
      setTimeout(() => { btnCopy.classList.remove('copied'); btnCopy.disabled = false; }, 1200);
    } catch { /* clipboard denied */ }
  });

  wrap.append(toolbar, body);
  return wrap;
}

function formatText(p) {
  const lines = [];
  if (p.page) lines.push(`Page:     ${p.page}`);
  if (p.resource) lines.push(`Resource: ${p.resource}`);
  if (p.verdict) lines.push(`Verdict:  ${p.verdict.toUpperCase()}`);
  const rule = p.matchedRule;
  if (rule) {
    lines.push(`Rule:     #${rule.index + 1}${rule.name ? ` (${rule.name})` : ''}${rule.direction ? ` [${rule.direction}]` : ''}`);
  } else if (p.mode === 'full') {
    lines.push('Rule:     (none — default action)');
  }
  if (p.contexts && p.mode === 'full') {
    lines.push(`Website:  host=${p.contexts.website?.host ?? '?'} ips=${formatIps(p.contexts.website?.ips)}`);
    lines.push(`Resource: host=${p.contexts.resource?.host ?? '?'} ips=${formatIps(p.contexts.resource?.ips)}`);
  }

  if (lines.length) lines.push('');

  const steps = p.trace ?? [];
  if (p.mode === 'matched-only') {
    const matched = rule ? steps.find(s => s.ruleIndex === rule.index) : null;
    if (matched) appendStepMatchersOnly(lines, matched, rule?.direction);
  } else {
    for (const step of steps) {
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

function appendStepMatchersOnly(lines, step, direction) {
  if (direction === 'reverse') {
    if (step.reverseWebsiteTrace) lines.push(...formatMatcherTrace(step.reverseWebsiteTrace, 0));
    if (step.reverseResourceTrace) lines.push(...formatMatcherTrace(step.reverseResourceTrace, 0));
  } else {
    if (step.websiteTrace) lines.push(...formatMatcherTrace(step.websiteTrace, 0));
    if (step.resourceTrace) lines.push(...formatMatcherTrace(step.resourceTrace, 0));
  }
}

function formatJson(p) {
  const out = {};
  if (p.page) out.page = p.page;
  if (p.resource) out.resource = p.resource;
  if (p.verdict) out.verdict = p.verdict;
  if (p.matchedRule) out.matchedRule = p.matchedRule;
  if (p.contexts && p.mode === 'full') out.contexts = p.contexts;
  if (p.mode === 'matched-only' && p.matchedRule) {
    const matched = (p.trace ?? []).find(s => s.ruleIndex === p.matchedRule.index);
    out.trace = matched ? [matched] : [];
  } else {
    out.trace = p.trace ?? [];
  }
  return JSON.stringify(out, null, 2);
}

function copyIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const r = document.createElementNS(ns, 'rect');
  r.setAttribute('x', '9'); r.setAttribute('y', '9');
  r.setAttribute('width', '13'); r.setAttribute('height', '13'); r.setAttribute('rx', '2');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
  svg.append(r, p);
  return svg;
}
