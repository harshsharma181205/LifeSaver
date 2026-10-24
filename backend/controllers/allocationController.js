const { randomUUID } = require('crypto');
const { findMatchingDonors } = require('../services/donorMatchingService');
const { createNotification } = require('../services/notificationService');
const workflow = require('../services/fulfillmentService');

async function processRequest(req, res) {
  try {
    const requestId = /^\d+$/.test(req.params.request_id || '') ? Number(req.params.request_id) : null;
    const body = req.body === undefined ? {} : req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => key !== 'operation_key')) {
      workflow.fail(400, 'Send only an optional operation_key.');
    }
    if (body.operation_key !== undefined && !workflow.validKey(body.operation_key)) {
      workflow.fail(400, 'operation_key must be a UUID.');
    }
    const key = (body.operation_key || randomUUID()).toLowerCase();
    const result = await workflow.runProviderTransaction(req.user, requestId, async ({ connection, request, provider, progress }) => {
      const previous = await workflow.previousOperation(connection, requestId, key);
      if (previous) {
        if (previous.inventory_id == null) workflow.fail(409, 'This operation key was used for a different action.');
        return { message: 'Inventory allocation already recorded.', request_id: requestId, bank_id: provider.bank_id,
          source: 'blood_bank', allocated_units: previous.units_allocated, status: request.status, ...progress, donors: [] };
      }
      workflow.requireOpen(request, progress);
      const [stockRows] = await connection.execute(
        'SELECT inventory_id, bank_id, blood_group, units_available, version FROM blood_inventory WHERE bank_id = ? AND blood_group = ? FOR UPDATE',
        [provider.bank_id, request.blood_group]
      );
      const stock = stockRows[0];
      if (stockRows.length > 1 || (stock && (!workflow.positiveInt(stock.inventory_id) || stock.bank_id !== provider.bank_id || stock.blood_group !== request.blood_group || !Number.isInteger(stock.units_available) || stock.units_available < 0))) workflow.fail(409, 'Inventory contains inconsistent data.');
      const canUseStock = provider.organization_type === 'Blood Bank' && !req.matchOnly;
      const allocated = canUseStock ? Math.min(stock ? stock.units_available : 0, progress.remaining_units) : 0;
      if (allocated < 0 || !Number.isInteger(allocated)) workflow.fail(409, 'Inventory is inconsistent.');
      let current = { ...progress, status: request.status };
      if (allocated > 0) {
        const [deduction] = await connection.execute(
          'UPDATE blood_inventory SET units_available = units_available - ?, version = version + 1 WHERE inventory_id = ? AND units_available >= ?',
          [allocated, stock.inventory_id, allocated]
        );
        if (deduction.affectedRows !== 1) workflow.fail(409, 'Inventory changed. Please refresh.');
        await connection.execute(
          'INSERT INTO request_allocations (request_id, donation_id, inventory_id, units_allocated, operation_key) VALUES (?, NULL, ?, ?, ?)',
          [requestId, stock.inventory_id, allocated, key]
        );
        current = await workflow.updateStatus(connection, request);
        await workflow.notifyRecipient(connection, request, 'Request #' + requestId + ': ' + allocated +
          ' units fulfilled from inventory. ' + current.remaining_units + ' units remain.');
      }
      const donors = [];
      let notifiedCount = 0;
      if (current.remaining_units > 0) {
        await connection.execute(
          'UPDATE blood_requests SET donor_matching_started_at = COALESCE(donor_matching_started_at, CURRENT_TIMESTAMP) WHERE request_id = ?',
          [requestId]
        );
        const location = { state: request.state || provider.state, city: request.city || provider.city };
        const matches = await findMatchingDonors(request.blood_group, connection, location);
        const [responses] = await connection.execute('SELECT donor_id, response, screening_result FROM donor_responses WHERE request_id = ?', [requestId]);
        const responseMap = new Map(responses.map(row => [row.donor_id, row]));
        for (const donor of matches) {
          const decision = responseMap.get(donor.donor_id);
          if (decision?.response === 'Declined' || decision?.screening_result === 'Failed') continue;
          donors.push({ donor_id: donor.donor_id, name: donor.name, blood_group: donor.blood_group,
            location: donor.city, is_available: donor.is_available, donor_response: decision?.response || null });
          if (decision?.response === 'Accepted') continue;
          const message = 'Blood request #' + requestId + ' requires ' + request.blood_group +
            ' blood in your city. Please review and respond through the authorized organization.';
          const [sent] = await connection.execute(
            'SELECT notification_id FROM notifications WHERE donor_id = ? AND request_id = ? AND channel = ? AND message = ? LIMIT 1',
            [donor.donor_id, requestId, 'InApp', message]
          );
          if (!sent.length) {
            await createNotification({ donor_id: donor.donor_id, request_id: requestId, message },
              { executor: connection, sendSMS: false });
            notifiedCount++;
          }
        }
      }
      return { message: current.remaining_units === 0 ? 'Blood request fulfilled.' :
        (allocated ? 'Inventory partially fulfilled this request. Eligible local donors can supply the remaining units.' :
          'Matching checked. Donation must take place through the selected Hospital or Blood Bank.'),
        request_id: requestId, bank_id: provider.bank_id, source: allocated ? 'blood_bank' : 'individual_donors',
        allocated_units: allocated, ...current, donors, notified_count: notifiedCount };
    });
    return res.status(200).json(result);
  } catch (error) { return workflow.sendError(res, error, 'Unable to process blood request.'); }
}
function matchRequest(req, res) { req.matchOnly = true; return processRequest(req, res); }
module.exports = { processRequest, matchRequest };
