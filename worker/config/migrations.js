import { V1_FIELD_RENAMES, V1_RULE_FIELD_RENAMES, V1_MATCHER_TYPE_RENAMES, V1_MATCHER_BODY_RENAMES, isLegacyV1Config } from './v1.js';
import { mergeWithDefaults } from '../config.js';

export function migrate(input) {
  if (!isLegacyV1Config(input)) return { config: mergeWithDefaults(input ?? {}) };
  const intermediate = { ...input, version: 2 };
  if (Array.isArray(input.rules)) intermediate.rules = input.rules.map(migrateRule);
  return { config: mergeWithDefaults(intermediate) };
}

function migrateRule(rule) {
  if (!rule || typeof rule !== 'object') return rule;
  const out = { ...rule };
  applyRenames(out, V1_FIELD_RENAMES);
  applyRenames(out, V1_RULE_FIELD_RENAMES);
  for (const key of ['source', 'destination', 'match']) {
    if (out[key] && typeof out[key] === 'object') out[key] = migrateMatcher(out[key]);
  }
  return out;
}

function migrateMatcher(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  if ('kind' in out) {
    if (!('type' in out)) out.type = out.kind;
    delete out.kind;
  }
  if (out.type in V1_MATCHER_TYPE_RENAMES) out.type = V1_MATCHER_TYPE_RENAMES[out.type];
  applyRenames(out, V1_MATCHER_BODY_RENAMES);
  if (Array.isArray(out.matches)) out.matches = out.matches.map(migrateMatcher);
  if (out.match && typeof out.match === 'object') out.match = migrateMatcher(out.match);
  return out;
}

function applyRenames(obj, table) {
  for (const [legacy, modern] of Object.entries(table)) {
    if (!(legacy in obj)) continue;
    if (!(modern in obj)) obj[modern] = obj[legacy];
    delete obj[legacy];
  }
}
