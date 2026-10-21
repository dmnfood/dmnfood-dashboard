import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_KEY, validSession, readSession, saveSession, clearSession, getSafeReturnTo, buildLoginUrl } from '../dashboard/js/auth-session.js';
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: undefined });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: undefined });

function storage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('default login lasts eight hours and is kept only in tab storage', t => {
    t.mock.property(globalThis, 'sessionStorage', storage());
    t.mock.property(globalThis, 'localStorage', storage());
    const session = saveSession('worker', false);
    assert.equal(session.expiresAt - session.startedAt, 8 * 3600000);
    assert.equal(localStorage.getItem(SESSION_KEY), null);
    assert.deepEqual(readSession('worker'), session);
    assert.equal(validSession(session, 'worker', session.expiresAt), false);
    assert.equal(validSession(session, 'other'), false);
    assert.equal(validSession({ ...session, expiresAt: session.expiresAt + 1 }, 'worker'), false);
});

test('remember login lasts seven days; changing policy and sign-out clear old storage', t => {
    t.mock.property(globalThis, 'sessionStorage', storage());
    t.mock.property(globalThis, 'localStorage', storage());
    const session = saveSession('manager', true);
    assert.equal(session.expiresAt - session.startedAt, 7 * 86400000);
    assert.equal(sessionStorage.getItem(SESSION_KEY), null);
    assert.equal(validSession(readSession('manager'), 'manager'), true);
    saveSession('manager', false);
    assert.equal(localStorage.getItem(SESSION_KEY), null);
    clearSession();
    assert.equal(readSession('manager'), null);
    sessionStorage.setItem(SESSION_KEY, 'broken');
    assert.equal(readSession('manager'), null);
});

test('order approval destinations retain the selected order through a login round trip', () => {
    const target = '/orders?order=mail-20261021-01#review';
    assert.equal(getSafeReturnTo(target), target);
    const loginUrl = new URL(buildLoginUrl(target), 'https://company.example');
    assert.equal(loginUrl.pathname, '/');
    assert.equal(loginUrl.searchParams.get('next'), target);
    assert.equal(getSafeReturnTo(loginUrl.searchParams.get('next')), target);
    assert.equal(getSafeReturnTo('/dashboard/orders.html?order=abc_123'), '/dashboard/orders.html?order=abc_123');
    assert.equal(getSafeReturnTo('/home'), '/home');
    assert.equal(getSafeReturnTo('/haccp-heating?date=2026-10-21'), '/haccp-heating?date=2026-10-21');
});

test('return links reject external URLs, login loops, hidden paths, and normalization tricks', () => {
    for (const target of [
        undefined, null, '', 'https://evil.example/orders', 'https://company.example/orders',
        '//evil.example/orders', '///evil.example/orders', 'javascript:alert(1)',
        '/\\evil.example/orders', '/orders\\@evil.example', '/orders\n', '/orders?order=a\rb',
        '/orders?order=a b', '/%2forders', '/%5cevil.example/orders', '/%6frders',
        '/ignored/../orders', '/ignored/%2e%2e/orders', '/orders/../orders',
        '/?next=/orders', '/dashboard/loginpage.html?next=/orders', '/api/orders',
        '/unknown', '/orders-other', '/orders/'
    ]) assert.equal(getSafeReturnTo(target), '/home', String(target));
    assert.equal(getSafeReturnTo('/unknown', '/orders'), '/orders');
    assert.equal(getSafeReturnTo('/unknown', '//evil.example'), '/home');
    assert.equal(getSafeReturnTo('/orders?order=' + 'x'.repeat(4096)), '/home');
});

test('login URL construction encodes only one destination and constrains the login page', () => {
    const target = '/orders?order=needs%20review&channel=mail#details';
    const directLogin = buildLoginUrl(target, '/dashboard/loginpage.html');
    assert.equal(new URL(directLogin, 'https://company.example').searchParams.get('next'), target);
    assert.equal(buildLoginUrl('//evil.example'), '/?next=%2Fhome');
    assert.equal(buildLoginUrl('/orders', '//evil.example'), '/?next=%2Forders');
    assert.equal(buildLoginUrl('/orders', '/?next=https://evil.example'), '/?next=%2Forders');
});
