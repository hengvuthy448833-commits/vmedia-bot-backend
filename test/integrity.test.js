import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_RETENTION_SECONDS, alertEligible, classifyIntegrity,
  cleanIntegrityPayload, ingestKey, integrityConfig, integrityConfigErrors,
  integrityEventKey, releaseAlert, reserveAlert, sourceFingerprint,
} from '../lib/integrity.js';

const RELEASE = '1'.repeat(64);
const BUILD = '2'.repeat(64);
const RUNTIME = '3'.repeat(64);

function setValidEnv() {
  process.env.INTEGRITY_ENABLED = 'true';
  process.env.INTEGRITY_HMAC_KEY = 'unit-test-key-that-is-at-least-32-characters';
  process.env.TELEGRAM_ADMIN_CHAT_ID = '123456789';
  process.env.EXPECTED_RELEASE_IDS = RELEASE;
  process.env.EXPECTED_BUILD_HASHES = BUILD;
  process.env.EXPECTED_APP_VERSIONS = '1.1.0';
  process.env.REQUIRE_PYARMOR = 'true';
  process.env.ALERT_COOLDOWN_SECONDS = '3600';
  process.env.ALERT_GLOBAL_LIMIT_PER_HOUR = '20';
}

function approvedPayload(overrides = {}) {
  return cleanIntegrityPayload({
    event: 'heartbeat',
    app_version: '1.1.0',
    release_id: RELEASE,
    build_hash: BUILD,
    runtime_hash: RUNTIME,
    frozen: true,
    pyarmor: true,
    engine_version: '2026.07.04',
    platform: 'windows',
    ...overrides,
  });
}

test('valid server configuration is ready', () => {
  setValidEnv();
  const config = integrityConfig();
  assert.deepEqual(integrityConfigErrors(config), []);
  assert.equal(config.expectedReleaseIds.has(RELEASE), true);
  assert.equal(config.alertGlobalLimitPerHour, 20);
});

test('missing allowlists and short HMAC fail closed', () => {
  setValidEnv();
  process.env.INTEGRITY_HMAC_KEY = 'short';
  process.env.EXPECTED_RELEASE_IDS = '';
  const errors = integrityConfigErrors(integrityConfig());
  assert.equal(errors.includes('invalid_hmac_key'), true);
  assert.equal(errors.includes('missing_release_allowlist'), true);
});

test('approved protected frozen release is informational', () => {
  setValidEnv();
  const result = classifyIntegrity(approvedPayload(), integrityConfig());
  assert.deepEqual(result, { severity: 'info', reasons: [] });
});

test('unknown or unprotected release is high severity', () => {
  setValidEnv();
  const payload = approvedPayload({
    release_id: 'a'.repeat(64),
    build_hash: 'b'.repeat(64),
    frozen: false,
    pyarmor: false,
  });
  const result = classifyIntegrity(payload, integrityConfig());
  assert.equal(result.severity, 'high');
  assert.deepEqual(result.reasons, [
    'unknown_release_id',
    'unknown_build_hash',
    'pyarmor_runtime_missing',
    'not_frozen',
  ]);
});

test('boolean strings cannot impersonate frozen or PyArmor state', () => {
  const payload = approvedPayload({ frozen: 'true', pyarmor: 'true' });
  assert.equal(payload.frozen, false);
  assert.equal(payload.pyarmor, false);
});

test('alerts require anomaly, Telegram linkage, and prior activation', () => {
  const reasons = ['unknown_build_hash'];
  assert.equal(alertEligible({}, reasons), false);
  assert.equal(alertEligible({ telegramUserId: '42' }, reasons), false);
  assert.equal(alertEligible({ telegramUserId: '42', activatedAt: 1 }, []), false);
  assert.equal(alertEligible({ telegramUserId: '42', activatedAt: 1 }, reasons), true);
});

test('source address is stored only as a stable HMAC pseudonym', () => {
  const key = 'unit-test-key-that-is-at-least-32-characters';
  const first = sourceFingerprint('203.0.113.9', key);
  const again = sourceFingerprint('203.0.113.9', key);
  const other = sourceFingerprint('203.0.113.10', key);
  assert.equal(first.length, 20);
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.equal(first.includes('203'), false);
});

test('event retention and ingest keys are bounded', () => {
  assert.equal(EVENT_RETENTION_SECONDS, 90 * 24 * 60 * 60);
  assert.match(ingestKey('a'.repeat(32), 'heartbeat'),
    /^dramadrop:integrity:ingest:[a-f0-9]{32}$/);
  assert.match(integrityEventKey('a'.repeat(32), 123),
    /^dramadrop:integrity:event:a{32}:123:[a-f0-9]{16}$/);
});

test('alert reservation supplies cooldown and global budget atomically', async () => {
  setValidEnv();
  let call;
  const redis = {
    async eval(...args) {
      call = args;
      return 1;
    },
  };
  const config = integrityConfig();
  const allowed = await reserveAlert(
    redis, 'a'.repeat(32), ['unknown_build_hash'], config, 3_600_000,
  );
  assert.equal(allowed, true);
  assert.equal(call[1], 2);
  assert.match(call[2], /^dramadrop:integrity:alert:[a-f0-9]{32}$/);
  assert.equal(call[3], 'dramadrop:integrity:budget:1');
  assert.equal(call[4], '3600');
  assert.equal(call[5], '20');
});

test('failed alert delivery releases cooldown and budget reservation', async () => {
  let call;
  const redis = {
    async eval(...args) {
      call = args;
      return 1;
    },
  };
  const released = await releaseAlert(
    redis, 'a'.repeat(32), ['unknown_build_hash'], 3_600_000,
  );
  assert.equal(released, true);
  assert.equal(call[1], 2);
  assert.match(call[2], /^dramadrop:integrity:alert:[a-f0-9]{32}$/);
  assert.equal(call[3], 'dramadrop:integrity:budget:1');
});
