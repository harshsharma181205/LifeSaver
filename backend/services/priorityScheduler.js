const priorities = { Emergency: 0, Normal: 1 };
const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
// Yeh review reminder hai, medical deadline nahi.
const LONG_WAIT_THRESHOLD_SECONDS = 24 * 60 * 60;

function invalidData() {
  const error = new Error('Provider queue contains inconsistent data.');
  error.code = 'SCHEDULER_DATA_ERROR';
  throw error;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

function arrivalTime(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : Infinity;
  if (typeof value !== 'string') return Infinity;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i);
  if (!parts) return Infinity;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return Infinity;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Infinity;
}

function compareRequests(left, right) {
  if (!left || !right || !Object.hasOwn(priorities, left.urgency_level) ||
      !Object.hasOwn(priorities, right.urgency_level) ||
      !positiveInt(left.request_id) || !positiveInt(right.request_id)) invalidData();
  const leftPriority = priorities[left.urgency_level];
  const rightPriority = priorities[right.urgency_level];
  if (leftPriority !== rightPriority) return leftPriority < rightPriority ? -1 : 1;
  const leftTime = arrivalTime(left.request_date);
  const rightTime = arrivalTime(right.request_date);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  if (left.request_id === right.request_id) return 0;
  return left.request_id < right.request_id ? -1 : 1;
}

function selectNextRequest(readyRequests, activeRequest = null) {
  // Active review ko nayi Emergency automatically replace nahi karegi.
  if (activeRequest) return activeRequest;
  if (!Array.isArray(readyRequests)) invalidData();
  let selected = null;
  for (const request of readyRequests) {
    compareRequests(request, request);
    if (!selected || compareRequests(request, selected) < 0) selected = request;
  }
  return selected;
}

function buildSchedule(requests, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  const threshold = options.longWaitThresholdSeconds ?? LONG_WAIT_THRESHOLD_SECONDS;
  if (!Array.isArray(requests) || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) ||
      !Number.isSafeInteger(threshold) || threshold < 1) invalidData();
  const seen = new Set();
  const pending = [];
  for (const request of requests) {
    if (!request || !positiveInt(request.request_id) || seen.has(request.request_id)) invalidData();
    seen.add(request.request_id);
    if (!['Pending', 'Processing', 'Fulfilled', 'Cancelled'].includes(request.status)) invalidData();
    if (['Fulfilled', 'Cancelled'].includes(request.status)) continue;
    const cityRequest = request.workflow_version === 2 && positiveInt(request.admission_hospital_id);
    if ((!cityRequest && !positiveInt(request.bank_id)) || !positiveInt(request.units_required) ||
        !Number.isInteger(request.remaining_units) || request.remaining_units < 0 ||
        request.remaining_units > request.units_required || !bloodGroups.includes(request.blood_group) ||
        !Object.hasOwn(priorities, request.urgency_level)) invalidData();
    if (request.remaining_units === 0) continue;
    const time = arrivalTime(request.request_date);
    const future = Number.isFinite(time) && time > now;
    const knownTime = Number.isFinite(time) && !future;
    const waiting = knownTime ? Math.floor((now - time) / 1000) : null;
    const displayDate = Number.isFinite(time) ? new Date(time).toISOString() : null;
    const warning = future ? 'Creation time is in the future; waiting time unavailable.' :
      knownTime ? null : 'Creation time unavailable.';
    const priority = priorities[request.urgency_level];
    pending.push({
      request_id: request.request_id, bank_id: request.bank_id, blood_group: request.blood_group,
      ...(cityRequest ? { workflow_version: 2, admission_hospital_id: request.admission_hospital_id,
        admission_hospital_name: request.admission_hospital_name, state: request.state, city: request.city } : {}),
      units_required: request.units_required, remaining_units: request.remaining_units,
      urgency_level: request.urgency_level, status: request.status,
      // Missing/future dates apni priority ke dated requests ke baad aayengi.
      request_date: knownTime ? displayDate : null, display_date: displayDate,
      priority, waiting_seconds: waiting, time_warning: warning,
      long_waiting_normal: request.urgency_level === 'Normal' && waiting !== null && waiting >= threshold,
      selection_reason: request.urgency_level + ' priority ' + priority + '. ' +
        (knownTime ? 'FCFS uses creation time; request ID breaks equal-time ties.' :
          'Usable creation time unavailable; dated requests of this priority come first, then request ID.'),
    });
  }
  const queue = [];
  // Har step par explicit selection: SQL order ya Array.sort par dependency nahi.
  while (pending.length) {
    const selected = selectNextRequest(pending);
    pending.splice(pending.indexOf(selected), 1);
    const { display_date, ...safe } = selected;
    queue.push({ ...safe, request_date: display_date, position: queue.length + 1 });
  }
  return { algorithm: 'Non-preemptive Priority + FCFS', generated_at: new Date(now).toISOString(),
    long_wait_threshold_seconds: threshold, queue };
}

module.exports = { compareRequests, selectNextRequest, buildSchedule, LONG_WAIT_THRESHOLD_SECONDS };
