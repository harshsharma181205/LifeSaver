import '../styles/lifecycle.css';
import '../styles/workflowV2.css';
import { formatRequestDate } from '../services/recipientDashboardApi.js';

export default function RequestFulfillment({ request }) {
  return <section className="request-fulfillment" aria-label={'Fulfillment for request '+request.request_id}>
    <div className="fulfillment-heading"><strong>{request.fulfilled_units} / {request.units_required} units fulfilled</strong><span>{request.remaining_units} remaining</span></div>
    <progress value={request.fulfilled_units} max={request.units_required} aria-label="Units fulfilled" />
    {request.history_available ? <p className="fulfillment-sources">Inventory: {request.inventory_units} units &middot; Donation: {request.donation_units} units</p>
      : <p className="fulfillment-sources">Historical fulfillment source details are unavailable.</p>}
    {request.workflow_version === 2 && <div className="workflow-v2-context"><strong>Admission Hospital: {request.admission_hospital_name}</strong><p>{[request.city, request.state].filter(Boolean).join(', ')}</p>
      <h3>Blood Bank contributions</h3>{request.contributions.length ? <ul className="workflow-contributions">{request.contributions.map((item, index) => <li key={index}><strong>{item.bank_name}</strong><p>{item.source}: {item.units_allocated} units</p><small>{formatRequestDate(item.allocated_at)}</small></li>)}</ul> : <p>No fulfilled contributions yet. Acceptance and screening do not count as donated units.</p>}</div>}
    {request.accepted_donors.length>0 && <div className="accepted-donor-list"><h3>Accepted donors</h3><p>{request.workflow_version === 2 ? "Coordinate collection through the designated Blood Bank. The admission Hospital is the patient treatment location." : 'Coordinate through the selected hospital or blood bank. Blood donation requires the authorized medical process.'}</p>
      {request.accepted_donors.map(donor=><article className="accepted-donor" key={donor.donor_id}><strong>{donor.name}{donor.blood_group?' ? '+donor.blood_group:''}</strong>
        {donor.phone&&<p>Phone: {donor.phone}</p>}{donor.email&&<p>Email: {donor.email}</p>}
        <p>Screening: {donor.screening_result||'Awaiting screening'}{donor.screened_at?' - '+formatRequestDate(donor.screened_at):''}</p>
        {donor.collection_id&&<p>Recorded collection: {donor.units_collected} units. {donor.accounting_path==='Inventory'?'Added to Bank inventory; fulfillment requires a separate allocation.':'Direct request contribution.'}</p>}
        {donor.screening_result==='Failed'&&<p>Screening failed. Another eligible donor can continue the process.</p>}
      </article>)}
    </div>}
  </section>;
}
