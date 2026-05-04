export const V1_FIELD_RENAMES = Object.freeze({
  website: 'source',
  resource: 'destination',
});

export const V1_RULE_FIELD_RENAMES = Object.freeze({
  strip_referrer_on_navigation: 'strip_referrer',
});

export const V1_MATCHER_TYPE_RENAMES = Object.freeze({
  all_of: 'and',
  any_of: 'or',
});

export const V1_MATCHER_BODY_RENAMES = Object.freeze({
  terms: 'matches',
  term: 'match',
});

export function isLegacyV1Config(input) {
  return input?.version === 1;
}
