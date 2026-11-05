// k6 smoke for a small business: login once per VU, then poll the schedule
// board and health like a manager/staff with the app open.
//
//   k6 run -e BASE_URL=https://dev.lunchlineup.com \
//          -e LOGIN_IDENTIFIER=... -e LOGIN_PASSWORD=... -e TENANT_SLUG=... \
//          tests/load/small-business-smoke.k6.js
//
// Credentials come only from the environment; nothing is hard-coded.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost').replace(/\/+$/, '');
const IDENTIFIER = __ENV.LOGIN_IDENTIFIER || '';
const PASSWORD = __ENV.LOGIN_PASSWORD || '';
const TENANT_SLUG = __ENV.TENANT_SLUG || '';
const LOGIN_PATH = __ENV.LOGIN_PATH || '/api/v2/auth/password/verify';
const HEALTH_PATH = __ENV.HEALTH_PATH || '/api/health';
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '2m';
// Deliberately conservative defaults: 50 VUs, one board read per ~3-6s each.
const THINK_MIN_S = Number(__ENV.THINK_MIN_S || 3);
const THINK_MAX_S = Number(__ENV.THINK_MAX_S || 6);

const loginFailed = new Rate('login_failed');

export const options = {
  scenarios: {
    small_business: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    login_failed: ['rate<0.02'],
    'http_req_duration{name:health}': ['p(95)<300'],
    'http_req_duration{name:schedule_board}': ['p(95)<1500', 'p(99)<3000'],
    'http_req_duration{name:login}': ['p(95)<2000'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  if (!IDENTIFIER || !PASSWORD) {
    throw new Error('Set LOGIN_IDENTIFIER and LOGIN_PASSWORD (and TENANT_SLUG if required).');
  }
  const health = http.get(`${BASE_URL}${HEALTH_PATH}`, { tags: { name: 'health' } });
  if (health.status !== 200) throw new Error(`Health check failed with ${health.status}; aborting.`);
}

function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function login() {
  const body = { identifier: IDENTIFIER.toLowerCase().trim(), password: PASSWORD };
  if (TENANT_SLUG) body.tenantSlug = TENANT_SLUG;
  const res = http.post(`${BASE_URL}${LOGIN_PATH}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    tags: { name: 'login' },
  });
  const ok = check(res, { 'login 200': (r) => r.status === 200 });
  loginFailed.add(!ok);
  return ok;
}

export default function () {
  // k6 keeps a cookie jar per VU, so the session cookie from login is reused.
  if (!login()) {
    sleep(10);
    return;
  }
  const view = ['day', 'week'][Math.floor(Math.random() * 2)];
  for (let i = 0; i < 20; i += 1) {
    const date = isoDate(Math.floor(Math.random() * 7));
    const board = http.get(`${BASE_URL}/api/v2/schedule-board?date=${date}&view=${view}`, { tags: { name: 'schedule_board' } });
    check(board, {
      'board 200': (r) => r.status === 200,
      'board is json': (r) => (r.headers['Content-Type'] || '').includes('json'),
    });
    if (i % 5 === 0) {
      const health = http.get(`${BASE_URL}${HEALTH_PATH}`, { tags: { name: 'health' } });
      check(health, { 'health 200': (r) => r.status === 200 });
    }
    sleep(THINK_MIN_S + Math.random() * (THINK_MAX_S - THINK_MIN_S));
  }
}
