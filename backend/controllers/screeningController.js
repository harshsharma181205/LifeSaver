const workflow = require('../services/fulfillmentService');
async function recordScreening(req, res) {
  try {
    const id = /^\d+$/.test(req.params.request_id || '') ? Number(req.params.request_id) : null;
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['donor_id', 'result'].includes(key)) ||
        !workflow.positiveInt(body.donor_id) || !['Passed', 'Failed'].includes(body.result)) {
      workflow.fail(400, 'Send donor_id and result as Passed or Failed.');
    }
    const result = await workflow.runProviderTransaction(req.user, id, async ({ connection, request, provider, progress }) => {
      workflow.requireOpen(request, progress);
      const [rows] = await connection.execute(
        'SELECT response, screening_result FROM donor_responses WHERE request_id = ? AND donor_id = ? FOR UPDATE',
        [id, body.donor_id]
      );
      if (!rows.length || rows[0].response !== 'Accepted') workflow.fail(409, 'Only an accepted donor can be screened.');
      if (rows[0].screening_result) {
        if (rows[0].screening_result !== body.result) workflow.fail(409, 'Screening is already recorded.');
        return { message: 'Screening already recorded.', request_id: id, donor_id: body.donor_id, screening_result: body.result };
      }
      if (!provider.organization_id) workflow.fail(409, 'Complete organization account setup first.');
      await connection.execute(
        'UPDATE donor_responses SET screening_result = ?, screened_at = CURRENT_TIMESTAMP, screened_by_organization_id = ? WHERE request_id = ? AND donor_id = ?',
        [body.result, provider.organization_id, id, body.donor_id]
      );
      const message = 'Request #' + id + ': screening ' + body.result.toLowerCase() +
        '. Screening alone does not record a donation.';
      await workflow.notifyRecipient(connection, request, message);
      await workflow.notifyDonor(connection, request, body.donor_id, message);
      return { message, request_id: id, donor_id: body.donor_id, screening_result: body.result,
        status: request.status, ...progress };
    });
    return res.status(200).json(result);
  } catch (error) { return workflow.sendError(res, error, 'Unable to record screening.'); }
}
module.exports = { recordScreening };
