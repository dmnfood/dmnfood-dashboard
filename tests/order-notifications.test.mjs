import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createOrderNoticeTracker, isOrderNoticeUnseen, normalizeOrderNotice,
    orderNotificationHref, readOrderNoticeSeen, serializeOrderNoticeSeen,
} from '../dashboard/js/order-notification-utils.js';

const order = (id, revision = 1) => ({ id, revision });

test('historical cache and initial server results never create new arrival alerts', () => {
    const tracker = createOrderNoticeTracker();
    assert.deepEqual(tracker.update([order('a')], { fromCache: true }), []);
    assert.deepEqual(tracker.update([order('a'), order('b')]), []);
    assert.deepEqual(tracker.update([order('a'), order('b'), order('c')]), [order('c')]);
    assert.deepEqual(tracker.update([order('a'), order('b'), order('c')]), []);
});

test('pending local writes wait for server confirmation and revisions alert once', () => {
    const tracker = createOrderNoticeTracker();
    tracker.update([order('a')]);
    assert.deepEqual(tracker.update([order('a'), order('b')], { hasPendingWrites: true }), []);
    assert.deepEqual(tracker.update([order('a'), order('b')]), [order('b')]);
    assert.deepEqual(tracker.update([order('a', 2), order('b')]), [order('a', 2)]);
    assert.deepEqual(tracker.update([]), []);
    assert.deepEqual(tracker.update([order('a', 2), order('b')]), []);
});

test('offline snapshots cannot announce arrivals until their server result is received', () => {
    const tracker = createOrderNoticeTracker();
    tracker.update([]);
    assert.deepEqual(tracker.update([order('a')], { fromCache: true }), []);
    assert.deepEqual(tracker.update([order('a')]), [order('a')]);
});

test('seen state is scoped to an order revision and cannot approve or clear pending orders', () => {
    const original = [order('a'), order('b', 3)];
    const seen = readOrderNoticeSeen(serializeOrderNoticeSeen(new Map([['a', 1], ['b', 2]])));
    assert.equal(isOrderNoticeUnseen(original[0], seen), false);
    assert.equal(isOrderNoticeUnseen(original[1], seen), true);
    assert.equal(original.length, 2);
    assert.equal(isOrderNoticeUnseen(order('a', 2), seen), true);
    assert.deepEqual(readOrderNoticeSeen('not json'), new Map());
    assert.deepEqual(readOrderNoticeSeen('{"version":1,"seen":[["bad",-1],["ok",2],["bad2","3"]]}'), new Map([['ok', 2]]));
});

test('order links keep arbitrary identifiers inside a query value and reject paths', () => {
    const id = '<img onerror=alert(1)>?redirect=https://evil.example';
    assert.equal(orderNotificationHref(id), '/orders');
    const queryId = 'quote"&next=evil#fragment';
    const url = new URL(orderNotificationHref(queryId), 'https://dashboard.example');
    assert.equal(url.pathname, '/orders');
    assert.equal(url.searchParams.get('order'), queryId);
    assert.equal(url.searchParams.has('next'), false);
    assert.equal(url.hash, '');
    assert.equal(orderNotificationHref('../escape'), '/orders');
});

test('incomplete pending records remain visible without invented customer or receive time', () => {
    assert.deepEqual(normalizeOrderNotice('a', { status: 'pending_review' }), {
        id: 'a', revision: 1, customerName: '거래처 확인 필요', sourceChannel: '', receivedAt: null, isTest: false,
    });
    assert.equal(normalizeOrderNotice('a', { status: 'approved' }), null);
    assert.equal(normalizeOrderNotice('a', { status: 'pending_review', receivedAt: { seconds: 100 } }).receivedAt, 100000);
    assert.equal(normalizeOrderNotice('a', { status: 'pending_review', receivedAt: { toMillis() { throw new Error(); } } }).receivedAt, null);
    assert.equal(normalizeOrderNotice('test', { status: 'pending_review', isTest: true }).isTest, true);
    assert.equal(normalizeOrderNotice('real', { status: 'pending_review', isTest: 'true' }).isTest, false);
});
