import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewSession, getReadyRequests, startNextReview, finishReview,
  startNewReviewRound } from '../src/services/providerReviewSession.js';

const normal = { request_id: 1, status: 'Pending', urgency_level: 'Normal', remaining_units: 13, position: 1 };
const emergency = { request_id: 2, status: 'Processing', urgency_level: 'Emergency', remaining_units: 5, position: 1 };
const nextNormal = { request_id: 3, status: 'Pending', urgency_level: 'Normal', remaining_units: 10, position: 2 };

test('new review sessions are isolated and begin in round one', () => {
  const first = createReviewSession();
  assert.deepEqual(first, { active: null, reviewedIds: [], round: 1 });
  assert.notEqual(first.reviewedIds, createReviewSession().reviewedIds);
});

test('dispatch uses first ready server row rather than sorting again', () => {
  const queue = [normal, emergency];
  const session = startNextReview(createReviewSession(), queue);
  assert.deepEqual(session.active, normal);
  assert.notEqual(session.active, normal);
  assert.deepEqual(queue, [normal, emergency]);
});

test('active Normal review is not preempted when new Emergency arrives', () => {
  const active = startNextReview(createReviewSession(), [normal]);
  assert.equal(startNextReview(active, [emergency, normal]), active);
  assert.equal(active.active.request_id, normal.request_id);
  assert.deepEqual(getReadyRequests(active, [emergency, normal]), [emergency]);
});

test('next dispatch re-evaluates refreshed server priority after finishing review', () => {
  const active = startNextReview(createReviewSession(), [normal]);
  const finished = finishReview(active);
  const next = startNextReview(finished, [emergency, normal, nextNormal]);
  assert.equal(next.active.request_id, emergency.request_id);
  assert.deepEqual(next.reviewedIds, [normal.request_id]);
  assert.equal(normal.status, 'Pending');
  assert.equal(normal.remaining_units, 13);
});

test('queue refresh cannot clear active review if its row becomes closed or omitted', () => {
  const active = startNextReview(createReviewSession(), [normal]);
  assert.equal(startNextReview(active, []), active);
  assert.equal(startNextReview(active, [{ ...normal, status: 'Cancelled' }, emergency]), active);
  assert.equal(active.active.status, 'Pending');
  assert.equal(finishReview(active).active, null);
});

test('finishing review records ID without changing clinical data or prior session', () => {
  const queue = Object.freeze([Object.freeze({ ...normal })]);
  const active = startNextReview(createReviewSession(), queue);
  Object.freeze(active.active);
  Object.freeze(active.reviewedIds);
  Object.freeze(active);
  const finished = finishReview(active);
  assert.deepEqual(finished, { active: null, reviewedIds: [normal.request_id], round: 1 });
  assert.equal(active.active.request_id, normal.request_id);
  assert.deepEqual(active.reviewedIds, []);
  assert.deepEqual(queue[0], normal);
});

test('ready requests exclude active and already reviewed IDs without mutating order', () => {
  const session = { active: emergency, reviewedIds: [normal.request_id], round: 4 };
  const queue = [emergency, normal, nextNormal];
  assert.deepEqual(getReadyRequests(session, queue), [nextNormal]);
  assert.deepEqual(queue, [emergency, normal, nextNormal]);
  assert.equal(session.round, 4);
});

test('request reviewed this round cannot immediately dispatch again', () => {
  const finished = finishReview(startNextReview(createReviewSession(), [normal]));
  assert.equal(startNextReview(finished, [normal]), finished);
  assert.deepEqual(getReadyRequests(finished, [normal]), []);
});

test('closed and fully supplied requests are not eligible for future dispatch', () => {
  const queue = [{ ...normal, status: 'Cancelled' }, { ...emergency, status: 'Fulfilled' },
    { ...nextNormal, remaining_units: 0 }];
  const session = createReviewSession();
  assert.deepEqual(getReadyRequests(session, queue), []);
  assert.equal(startNextReview(session, queue), session);
});

test('empty queue and finishing without active review are harmless no-ops', () => {
  const session = createReviewSession();
  assert.equal(startNextReview(session, []), session);
  assert.equal(finishReview(session), session);
});

test('new round is rejected while a review is active', () => {
  const active = startNextReview(createReviewSession(), [normal]);
  assert.throws(() => startNewReviewRound(active), /Finish the active review/);
  assert.equal(active.round, 1);
  assert.equal(active.active.request_id, normal.request_id);
});

test('new round clears review history and restores still-open requests', () => {
  const finished = finishReview(startNextReview(createReviewSession(), [normal]));
  const newRound = startNewReviewRound(finished);
  assert.deepEqual(newRound, { active: null, reviewedIds: [], round: 2 });
  assert.deepEqual(finished.reviewedIds, [normal.request_id]);
  assert.equal(startNextReview(newRound, [normal]).active.request_id, normal.request_id);
});

test('repeated finish never duplicates review IDs', () => {
  const finished = finishReview(startNextReview(createReviewSession(), [normal]));
  assert.equal(finishReview(finished), finished);
  assert.deepEqual(finished.reviewedIds, [normal.request_id]);
  const existing = { ...finished, active: { ...normal } };
  assert.deepEqual(finishReview(existing).reviewedIds, [normal.request_id]);
});

test('review completion leaves Processing and partial fulfillment unchanged', () => {
  const active = startNextReview(createReviewSession(), [emergency]);
  const finished = finishReview(active);
  assert.equal(emergency.status, 'Processing');
  assert.equal(emergency.remaining_units, 5);
  assert.ok(!('status' in finished));
  assert.ok(!('remaining_units' in finished));
});

test('new-round counter advances independently of clinical request data', () => {
  let session = createReviewSession();
  for (let i = 0; i < 3; i++) session = startNewReviewRound(session);
  assert.equal(session.round, 4);
  assert.deepEqual(session.reviewedIds, []);
  assert.equal(normal.remaining_units, 13);
});
