// Names are display labels, not role credentials. Only metadata-free legacy
// roots fall back to the old labels; observation never migrates session data.
export const LEGACY_LEAD_TITLE = /^Codex Lead (\d+)$/;
const LEGACY_RELAY_TITLES = new Set(['Codex Relay', 'Codex 协作']);

export function coordinatorRoleForSession(session, metadata) {
  if (!session || session.parentSessionId) return '';
  if (metadata != null) return ['lead', 'relay'].includes(metadata.role) ? metadata.role : '';
  const title = session.projections?.values?.title || '';
  return LEGACY_RELAY_TITLES.has(title) ? 'relay' : LEGACY_LEAD_TITLE.test(title) ? 'lead' : '';
}

export function normalizeLeadName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Lead name must be 1–200 characters, not blank, and contain no control characters. Custom Unicode names are supported.');
  }
  return value.trim();
}
