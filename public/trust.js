// Trust store for paired devices.
//
// What "trust" means here: the user has previously accepted a pair
// request from a device with this pubkey, and ticked "Trust always."
// Future pair requests from the same key auto-accept silently (with a
// toast). Without a trust entry, the user sees a prompt — Accept / Deny —
// every time. Same shape as Bluetooth's bonded-devices list or iOS's
// "Always allow" per-app permissions.
//
// State model: pubkey → { label, firstPairedAt, lastSeenAt }. Pubkey is
// the continuity primitive (matches across sessions); label is what to
// show the user. Both come signed from the other device's discovery ad.
//
// Persistence: localStorage. Cleared = lose all auto-accept memory;
// future pair requests prompt again. Safe failure mode.

const STORAGE_KEY = 'better-robotics:trust:v1';

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _save(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch {}
}

export function isTrusted(pubkey) {
  if (!pubkey) return false;
  return !!_load()[pubkey];
}
// Alias — semantic clarity at the call site. Trust today means
// auto-accept; future revisions might split (e.g. trusted-but-prompt).
export const isAutoAccept = isTrusted;

export function getTrust(pubkey) {
  if (!pubkey) return null;
  return _load()[pubkey] || null;
}

// Find any trust entry matching this label — for "identity-changed"
// detection. Returns the first match (one device per label is the
// expected case in v1). Returns { pubkey, label, ...meta } or null.
export function findByLabel(label) {
  if (!label) return null;
  const store = _load();
  for (const [pubkey, meta] of Object.entries(store)) {
    if (meta && meta.label === label) return { pubkey, ...meta };
  }
  return null;
}

// Bind trust. Called only after an out-of-band confirmation (QR scan,
// successful pair handshake). Updates lastSeenAt on re-trust without
// resetting firstPairedAt — the relationship is older than the
// reconfirmation.
export function trust(pubkey, label) {
  if (!pubkey) return;
  const store = _load();
  const now = Date.now();
  const existing = store[pubkey];
  store[pubkey] = {
    label: label || (existing && existing.label) || 'Device',
    firstPairedAt: existing ? existing.firstPairedAt : now,
    lastSeenAt: now,
  };
  _save(store);
}

// Touch lastSeenAt without changing trust. Cheap to call from discovery
// listeners — quietly tracks recency for "Last seen 2h ago" hints.
export function touch(pubkey) {
  if (!pubkey) return;
  const store = _load();
  if (!store[pubkey]) return;
  store[pubkey].lastSeenAt = Date.now();
  _save(store);
}

export function untrust(pubkey) {
  if (!pubkey) return;
  const store = _load();
  delete store[pubkey];
  _save(store);
}

// Three-state classifier — not used for the discovery list anymore (which
// is now uniformly tappable; trust is decided at the prompt step), but
// retained for the prompt UX so we can render "you've connected before"
// vs "first time" vs "identity changed since last time" hints.
export function classify(ad) {
  const data = (ad && ad.data) || {};
  const pubkey = data._pubkey;
  const label  = data.label;
  if (!pubkey) return { state: 'unknown', pubkey: null, label, trust: null };
  if (isTrusted(pubkey)) {
    return { state: 'trusted', pubkey, label, trust: getTrust(pubkey) };
  }
  const byLabel = findByLabel(label);
  if (byLabel && byLabel.pubkey !== pubkey) {
    return { state: 'identity-changed', pubkey, label, trust: byLabel };
  }
  return { state: 'unknown', pubkey, label, trust: null };
}
