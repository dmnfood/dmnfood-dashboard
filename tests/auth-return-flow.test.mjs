import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildLoginUrl, getSafeReturnTo, validSession } from '../dashboard/js/auth-session.js';

const clientSource = await readFile(new URL('../dashboard/js/firebase-client.js', import.meta.url), 'utf8');
const loginSource = (await readFile(new URL('../dashboard/loginpage.html', import.meta.url), 'utf8'))
    .match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const rootHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const rootSource = rootHtml.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const withoutImports = source => source.replace(/^\s*import\s+[\s\S]*?;\r?$/gm, '');
const quiet = { info() {}, error() {} };

function element() {
    return { style: {}, classList: { add() {}, remove() {} }, value: '', checked: false, children: [],
        setAttribute() {}, addEventListener() {}, showModal() {},
        append(...children) { this.children.push(...children); }, focus() {} };
}

function protectedPage() {
    const redirects = [], dialogs = [], events = {};
    let authCallback, profileCallback, session = null;
    const auth = { currentUser: null };
    const context = vm.createContext({
        console: quiet, URL, buildLoginUrl, validSession,
        clearSession() {}, readSession: () => session, saveSession() {}, LOGOUT_KEY: 'logout',
        getApps: () => [], getApp() {}, initializeApp() {}, getAuth: () => auth, getFirestore() {},
        getDoc() {}, doc() {}, browserLocalPersistence: {}, browserSessionPersistence: {}, setPersistence() {},
        signOut: async () => { auth.currentUser = null; },
        onAuthStateChanged: (_, callback) => { authCallback = callback; },
        onSnapshot: (_, callback) => { profileCallback = callback; return () => {}; },
        setInterval: () => 1, clearInterval() {},
        document: { createElement: element, getElementById: () => null, addEventListener() {}, body: { append: node => dialogs.push(node) } },
        window: { location: { pathname: '/orders', search: '?order=mail-01', hash: '#review', replace: url => redirects.push(url) }, addEventListener: (name, handler) => { events[name] = handler; } },
    });
    vm.runInContext(withoutImports(clientSource).replace(/^export /gm, '') + '\nglobalThis.client = { requireApprovedActiveUser, isApprovedActiveProfile };', context);
    return { redirects, dialogs, events, context,
        requireUser: () => context.client.requireApprovedActiveUser(),
        authenticate(user, currentSession) { auth.currentUser = user; session = currentSession; authCallback(user); },
        profile: value => profileCallback({ exists: () => true, data: () => value }),
        expire() { session = { ...session, expiresAt: 0 }; },
    };
}

test('an unauthenticated order link redirects to login with the exact selected order', async () => {
    const page = protectedPage();
    const result = page.requireUser();
    page.authenticate(null, null);
    assert.equal(await result, null);
    await Promise.resolve();
    assert.deepEqual(page.redirects, ['/?next=%2Forders%3Forder%3Dmail-01%23review']);
});

function rootEntry(search = '') {
    const redirects = [];
    const context = vm.createContext({ URLSearchParams, buildLoginUrl, getSafeReturnTo,
        window: { location: { search, replace: url => redirects.push(url) } },
    });
    vm.runInContext(withoutImports(rootSource), context);
    return redirects;
}

test('the root HTML entry preserves the selected order through the full login redirect chain', async () => {
    assert.doesNotMatch(rootHtml, /http-equiv\s*=\s*["']refresh["']/i);
    assert.match(rootHtml, /<a href="\/dashboard\/loginpage\.html">/);
    const target = '/orders?order=notification-check#review';
    const guardUrl = new URL(buildLoginUrl(target), 'https://company.example');
    const rootRedirects = rootEntry(guardUrl.search);
    assert.deepEqual(rootRedirects, ['/dashboard/loginpage.html?next=%2Forders%3Forder%3Dnotification-check%23review']);
    const loginUrl = new URL(rootRedirects[0], guardUrl.origin);
    const page = loginPage(loginUrl.searchParams.get('next'));
    await page.context.window.handleLogin();
    assert.deepEqual(page.redirects, [target]);
});

test('the root HTML entry keeps direct login simple and validates any return target', () => {
    assert.deepEqual(rootEntry(), ['/dashboard/loginpage.html']);
    assert.deepEqual(rootEntry('?unrelated=value'), ['/dashboard/loginpage.html']);
    assert.deepEqual(rootEntry('?next='), ['/dashboard/loginpage.html']);
    for (const target of ['https://evil.example/orders', '//evil.example/orders', '/?next=/orders', '/ignored/../orders']) {
        assert.deepEqual(rootEntry('?next=' + encodeURIComponent(target)), ['/dashboard/loginpage.html?next=%2Fhome']);
    }
});

test('an expired approved session locks the page and resumes at the same order after login', async () => {
    const page = protectedPage();
    const result = page.requireUser();
    const now = Date.now();
    page.authenticate({ uid: 'manager-1' }, { uid: 'manager-1', startedAt: now - 1000, expiresAt: now + 3600000, remember: false });
    page.profile({ role: 'manager', approvalStatus: 'approved', isActive: true });
    assert.equal((await result).role, 'manager');
    page.expire();
    page.events.focus();
    await Promise.resolve();
    assert.equal(page.dialogs.length, 1);
    assert.deepEqual(page.redirects, []);
    page.dialogs[0].children[1].onclick();
    assert.deepEqual(page.redirects, ['/?next=%2Forders%3Forder%3Dmail-01%23review']);
});

function loginPage(next, { profile = { role: 'manager', approvalStatus: 'approved', isActive: true }, valid = true } = {}) {
    const redirects = [], elements = new Map();
    let authCallback, signedOut = false;
    const user = { uid: 'manager-1', email: 'manager@example.test' };
    const auth = { currentUser: user };
    const getElement = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    getElement('email').value = user.email;
    getElement('password').value = 'test-password';
    const context = vm.createContext({
        console: quiet, URLSearchParams, getSafeReturnTo,
        auth, db: {}, beginLoginSession() {}, configureLoginPersistence: async () => {},
        hasValidLoginSession: () => valid,
        loadUserProfile: async () => profile,
        isApprovedActiveProfile: value => value?.role === 'manager' && value.approvalStatus === 'approved' && value.isActive === true,
        profileAccessMessage: () => '승인 대기',
        onAuthStateChanged: (_, callback) => { authCallback = callback; },
        signInWithEmailAndPassword: async () => ({ user }),
        signOut: async () => { signedOut = true; auth.currentUser = null; },
        document: { getElementById: getElement, querySelectorAll: () => [], addEventListener() {}, activeElement: null },
        window: { location: { search: '?next=' + encodeURIComponent(next), replace: url => redirects.push(url) } },
    });
    vm.runInContext(withoutImports(loginSource), context);
    return { redirects, context, user, signedOut: () => signedOut, authState: () => authCallback(user) };
}

test('password login and an existing approved session both open the requested order', async () => {
    for (const flow of ['password', 'existing']) {
        const page = loginPage('/orders?order=mail-01');
        if (flow === 'password') await page.context.window.handleLogin();
        else await page.authState();
        assert.deepEqual(page.redirects, ['/orders?order=mail-01'], flow);
    }
});

test('login rejects external destinations and still denies unapproved or expired accounts', async () => {
    const external = loginPage('https://evil.example/orders');
    await external.authState();
    assert.deepEqual(external.redirects, ['/home']);
    const pending = loginPage('/orders?order=mail-01', { profile: { role: 'manager', approvalStatus: 'pending', isActive: false } });
    await pending.context.window.handleLogin();
    assert.deepEqual(pending.redirects, []);
    assert.equal(pending.signedOut(), true);
    const expired = loginPage('/orders?order=mail-01', { valid: false });
    await expired.authState();
    assert.deepEqual(expired.redirects, []);
    assert.equal(expired.signedOut(), true);
});
