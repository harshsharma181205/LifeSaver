export function createReviewSession() {
  return { active: null, reviewedIds: [], round: 1 };
}

export function getReadyRequests(session, queue) {
  return queue.filter(request => !session.reviewedIds.includes(request.request_id)
    && request.request_id !== session.active?.request_id
    && ['Pending', 'Processing'].includes(request.status) && request.remaining_units > 0);
}

export function startNextReview(session, queue) {
  // Active review ko nayi Emergency bhi interrupt nahi karegi.
  if (session.active) return session;
  const next = getReadyRequests(session, queue)[0];
  if (!next) return session;
  return { ...session, active: { ...next } };
}

export function finishReview(session) {
  if (!session.active) return session;
  // Review complete hona blood fulfillment nahi hai.
  const reviewedIds = session.reviewedIds.includes(session.active.request_id)
    ? [...session.reviewedIds] : [...session.reviewedIds, session.active.request_id];
  return { ...session, active: null, reviewedIds };
}

export function startNewReviewRound(session) {
  if (session.active) throw new Error('Finish the active review before starting a new round.');
  return { active: null, reviewedIds: [], round: session.round + 1 };
}
