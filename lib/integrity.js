import crypto from 'node:crypto';

export const EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[0-9A-Za-z._-]{1,32}$/;
const EVENT_RE = /^[a-z0-9_-]{1,32}$/;

function csvSet(name, pattern) {
  return new Set(String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => pattern.test(item)));
}

function envBool(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envInt(name, fallback, minimum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

export function integrityConfig() {
  return {
    enabled: envBool('INTEGRITY_ENABLED', true),
    hmacKey: String(process.env.INTEGRITY_HMAC_KEY || '').trim(),
    adminChatId: String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim(),
    expectedReleaseIds: csvSet('EXPECTED_RELEASE_IDS', SHA256_RE),
    expectedBuildHashes: csvSet('EXPECTED_BUILD_HASHES', SHA256_RE),
    expectedAppVersions: csvSet('EXPECTED_APP_VERSIONS', VERSION_RE),
    requirePyarmor: envBool('REQUIRE_PYARMOR', true),
    alertCooldownSeconds: envInt('ALERT_COOLDOWN_SECONDS', 3600, 60),
    alertGlobalLimitPerHour: envInt('ALERT_GLOBAL_LIMIT_PER_HOUR', 20, 1),
  };
}

export function integrityConfigErrors(config = integrityConfig()) {
  const errors = [];
  if (!config.enabled) errors.push('integrity_disabled');
  if (config.hmacKey.length < 32) errors.push('invalid_hmac_key');
  if (!/^-?\d+$/.test(config.adminChatId)) errors.push('invalid_admin_chat_id');
  if (!config.expectedReleaseIds.size) errors.push('missing_release_allowlist');
  if (!config.expectedBuildHashes.size) errors.push('missing_build_allowlist');
  if (!config.expectedAppVersions.size) errors.push('missing_version_allowlist');
  return errors;
}

function cleanHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return SHA256_RE.test(hash) ? hash : '';
}

export function cleanIntegrityPayload(data = {}) {
  const eventValue = String(data.event || 'heartbeat').trim().toLowerCase();
  return {
    event: EVENT_RE.test(eventValue) ? eventValue : 'invalid',
    appVersion: String(data.app_version || '').trim().slice(0, 32),
    releaseId: cleanHash(data.release_id),
    buildHash: cleanHash(data.build_hash),
    runtimeHash: cleanHash(data.runtime_hash),
    frozen: data.frozen === true,
    pyarmor: data.pyarmor === true,
    engineVersion: String(data.engine_version || '').trim().slice(0, 32),
    platform: String(data.platform || '').trim().toLowerCase().slice(0, 24),
  };
}

export function classifyIntegrity(payload, config = integrityConfig()) {
  const reasons = [];
  if (!config.expectedAppVersions.has(payload.appVersion.toLowerCase())) {
    reasons.push('unexpected_app_version');
  }
  if (!config.expectedReleaseIds.has(payload.releaseId)) {
    reasons.push('unknown_release_id');
  }
  if (!config.expectedBuildHashes.has(payload.buildHash)) {
    reasons.push('unknown_build_hash');
  }
  if (config.requirePyarmor && !payload.pyarmor) {
    reasons.push('pyarmor_runtime_missing');
  }
  if (!payload.frozen) reasons.push('not_frozen');
  return { severity: reasons.length ? 'high' : 'info', reasons };
}

export function alertEligible(record, reasons) {
  return Boolean(reasons.length && record?.telegramUserId && record?.activatedAt);
}

export function sourceFingerprint(address, hmacKey) {
  return crypto.createHmac('sha256', hmacKey)
    .update(String(address || 'unknown').trim().toLowerCase())
    .digest('hex').slice(0, 20);
}

export function integrityEventKey(deviceId, now = Date.now()) {
  const suffix = crypto.randomBytes(8).toString('hex');
  return `dramadrop:integrity:event:${deviceId}:${now}:${suffix}`;
}

export function ingestKey(deviceId, event) {
  const digest = crypto.createHash('sha256')
    .update(`${deviceId}:${event}`).digest('hex').slice(0, 32);
  return `dramadrop:integrity:ingest:${digest}`;
}

const ALERT_RESERVATION_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local count = tonumber(redis.call('GET', KEYS[2]) or '0')
if count >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[1]))
local updated = redis.call('INCR', KEYS[2])
if updated == 1 then redis.call('EXPIRE', KEYS[2], 7200) end
return 1
`;

function alertKeys(deviceId, reasons, now) {
  const reasonKey = [...new Set(reasons)].sort().join(',');
  const digest = crypto.createHash('sha256')
    .update(`${deviceId}:${reasonKey}`).digest('hex').slice(0, 32);
  return {
    cooldownKey: `dramadrop:integrity:alert:${digest}`,
    budgetKey: `dramadrop:integrity:budget:${Math.floor(now / 1000 / 3600)}`,
  };
}

export async function reserveAlert(redis, deviceId, reasons, config, now = Date.now()) {
  const { cooldownKey, budgetKey } = alertKeys(deviceId, reasons, now);
  const result = await redis.eval(
    ALERT_RESERVATION_LUA,
    2,
    cooldownKey,
    budgetKey,
    String(config.alertCooldownSeconds),
    String(config.alertGlobalLimitPerHour),
  );
  return Number(result) === 1;
}

const ALERT_RELEASE_LUA = `
if redis.call('DEL', KEYS[1]) == 0 then return 0 end
local count = tonumber(redis.call('GET', KEYS[2]) or '0')
if count <= 1 then redis.call('DEL', KEYS[2]) else redis.call('DECR', KEYS[2]) end
return 1
`;

export async function releaseAlert(redis, deviceId, reasons, now = Date.now()) {
  const { cooldownKey, budgetKey } = alertKeys(deviceId, reasons, now);
  const result = await redis.eval(
    ALERT_RELEASE_LUA, 2, cooldownKey, budgetKey,
  );
  return Number(result) === 1;
}
