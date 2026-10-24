const workflow = require('../services/fulfillmentService');
async function confirmDonation(req, res) {
  try {
    const id = /^\d+$/.test(req.params.request_id || '') ? Number(req.params.request_id) : null;
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['donor_id', 'units_donated', 'operation_key'].includes(key)) ||
        !workflow.positiveInt(body.donor_id) || !workflow.positiveInt(body.units_donated) || !workflow.validKey(body.operation_key)) {
      workflow.fail(400, 'Send donor_id, positive units_donated, and a UUID operation_key.');
    }
    const result = await workflow.runProviderTransaction(req.user, id, async ({ connection, request, provider, progress }) => {
      const key = body.operation_key.toLowerCase();
      const previous = await workflow.previousOperation(connection, id, key);
      if (previous) {
        if (!previous.donation_id || previous.donor_id !== body.donor_id || previous.units_allocated !== body.units_donated) {
          workflow.fail(409, 'This operation key was used for different donation details.');
        }
        return { message: 'Donation already recorded.', donation_id: previous.donation_id,
          request_id: id, status: request.status, ...progress };
      }
      workflow.requireOpen(request, progress);
      if (body.units_donated > progress.remaining_units) workflow.fail(409, 'Donation exceeds the remaining requested units.');
      const [donors] = await connection.execute('SELECT donor_id, blood_group FROM donors WHERE donor_id = ? FOR UPDATE', [body.donor_id]);
      if (!donors.length || donors[0].blood_group !== request.blood_group) workflow.fail(409, 'Donor blood group does not match this request.');
      const [responses] = await connection.execute(
        'SELECT response, screening_result, screened_by_organization_id FROM donor_responses WHERE request_id = ? AND donor_id = ? FOR UPDATE',
        [id, body.donor_id]
      );
      if (!responses.length || responses[0].response !== 'Accepted' || responses[0].screening_result !== 'Passed' ||
          responses[0].screened_by_organization_id !== provider.organization_id) {
        workflow.fail(409, 'The accepted donor must pass screening at this organization first.');
      }
      // Actual confirmed donation seedha request ko contribute karegi; inventory double-count nahi hogi.
      const [donation] = await connection.execute(
        'INSERT INTO donations (donor_id, bank_id, blood_group, units_donated) VALUES (?, ?, ?, ?)',
        [body.donor_id, provider.bank_id, request.blood_group, body.units_donated]
      );
      await connection.execute(
        'INSERT INTO request_allocations (request_id, donation_id, inventory_id, units_allocated, operation_key) VALUES (?, ?, NULL, ?, ?)',
        [id, donation.insertId, body.units_donated, key]
      );
      await connection.execute('UPDATE donors SET last_donation = CURRENT_DATE WHERE donor_id = ?', [body.donor_id]);
      const current = await workflow.updateStatus(connection, request);
      const message = 'Request #' + id + ': ' + body.units_donated + ' donated units confirmed by the organization. ' +
        (current.remaining_units ? current.remaining_units + ' units remain.' : 'Request fulfilled.');
      await workflow.notifyRecipient(connection, request, message);
      await workflow.notifyDonor(connection, request, body.donor_id, message);
      return { message, request_id: id, donation_id: donation.insertId, ...current };
    });
    return res.status(200).json(result);
  } catch (error) { return workflow.sendError(res, error, 'Unable to confirm donation.'); }
}
module.exports = { confirmDonation };
