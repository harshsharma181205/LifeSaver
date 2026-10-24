const config = require('./workflowV2Config');
const workflow = require('./fulfillmentService');
const { ensureFallback } = require('./cityWideDonorFallback');

async function reconcileOpenRequests(pool) {
  if (!config.isEnabled()) return { checked: 0, failed: 0 };
  await config.assertReady(pool);
  let cursor = 0, checked = 0, failed = 0;
  while (true) {
    const [candidates] = await pool.execute(
      "SELECT request_id FROM blood_requests WHERE workflow_version = 2 AND status IN ('Pending', 'Processing') AND request_id > ? ORDER BY request_id LIMIT 50", [cursor]);
    if (!candidates.length) break;
    for (const candidate of candidates) {
      cursor = candidate.request_id;
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        const [rows] = await connection.execute('SELECT * FROM blood_requests WHERE request_id = ? FOR UPDATE', [cursor]);
        if (rows.length && rows[0].workflow_version === 2) {
          const progress = await workflow.readProgress(connection, rows[0], true);
          await ensureFallback(connection, rows[0], progress);
        }
        await connection.commit(); checked++;
      } catch {
        failed++;
        if (connection) {
          try { await connection.rollback(); }
          catch { connection.destroy(); connection = null; }
        }
      } finally { if (connection) connection.release(); }
    }
  }
  return { checked, failed };
}

function startFallbackReconciliation(pool) {
  if (!config.isEnabled()) return null;
  let running = false;
  async function refresh() {
    if (running || !config.isEnabled()) return;
    running = true;
    try {
      const result = await reconcileOpenRequests(pool);
      if (result.failed) console.error('Some city-wide donor fallback checks could not complete; they will retry.');
    } catch { console.error('City-wide donor fallback refresh is temporarily unavailable.'); }
    finally { running = false; }
  }
  // Purane stuck V2 requests bhi recover honge; V1 history touch nahi hogi.
  refresh();
  const timer = setInterval(refresh, 30000);
  timer.unref();
  return timer;
}

module.exports = { reconcileOpenRequests, startFallbackReconciliation };
