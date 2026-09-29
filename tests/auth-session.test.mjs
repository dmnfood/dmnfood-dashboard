import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_KEY, validSession, readSession, saveSession, clearSession } from '../dashboard/js/auth-session.js';
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
