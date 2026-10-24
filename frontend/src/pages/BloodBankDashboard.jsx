import useWorkflowConfig from '../hooks/useWorkflowConfig.js';
import WorkflowNotice from '../components/WorkflowNotice.jsx';
import WorkflowNotifications from '../components/WorkflowNotifications.jsx';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext.jsx';
import { bankError, bloodGroups, fetchBankInventory, fetchBankProfile, fetchBankRequests,
  formatRequestDate, maximumUnits, processBankRequest, updateBankInventory,
  recordDonorScreening, recordActualDonation, findRequestDonors } from '../services/bloodBankDashboardApi.js';
import { newOperationKey } from '../services/lifecycleFields.js';
import ProviderRequestQueue from '../components/ProviderRequestQueue.jsx';
import '../styles/bloodBankDashboard.css';

function BankDashboardContent({ session, logout, provider }) {
  const workflow = useWorkflowConfig(session);
  const navigate=useNavigate();
  const [profile,setProfile]=useState(provider ?? null);
  const [inventory,setInventory]=useState([]);
  const [requests,setRequests]=useState([]);
  const [states,setStates]=useState({profile:'loading',inventory:'loading',requests:'loading'});
  const [errors,setErrors]=useState({});
  const [filter,setFilter]=useState('All');
  const [editing,setEditing]=useState(null);
  const [units,setUnits]=useState('');
  const [editVersion,setEditVersion]=useState(0);
  const [donationUnits,setDonationUnits]=useState({});
  const [accountingPaths,setAccountingPaths]=useState({});
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [actionError,setActionError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [requestGeneration,setRequestGeneration]=useState(-1);
  const actionLock=useRef(false);
  const actionController=useRef(null);
  const operationKeys=useRef(new Map());
  const queueFocus=useRef(null);
  const organizationType=provider?.organization_type ?? 'Blood Bank';
  const hasInventory=organizationType==='Blood Bank';
  const clinical=['Hospital','Blood Bank'].includes(organizationType);
  function expire(){logout();navigate('/login',{replace:true});}
  useEffect(()=>()=>actionController.current?.abort(),[]);
  useEffect(()=>{
    const controller=new AbortController();
    setStates({profile:provider?'success':'loading',inventory:hasInventory?'loading':'success',requests:clinical?'loading':'success'});
    setErrors({});
    const loaders={};
    if(provider)setProfile(provider);else loaders.profile=()=>fetchBankProfile(session,controller.signal);
    if(hasInventory)loaders.inventory=()=>fetchBankInventory(session,controller.signal,provider);
    if(clinical)loaders.requests=()=>fetchBankRequests(session,controller.signal,provider);
    const setters={profile:setProfile,inventory:setInventory,requests:setRequests};
    for(const section of Object.keys(loaders))loaders[section]().then(value=>{
      if(controller.signal.aborted)return;
      setters[section](value);if(section==='requests')setRequestGeneration(refresh);setStates(current=>({...current,[section]:'success'}));
    }).catch(error=>{
      if(controller.signal.aborted||axios.isCancel(error))return;
      if(error.response?.status===401){logout();navigate('/login',{replace:true});}
      else{setErrors(current=>({...current,[section]:bankError(error)}));setStates(current=>({...current,[section]:'error'}));}
    });
    return()=>controller.abort();
  },[session,logout,navigate,refresh,provider,hasInventory,clinical]);
  useEffect(()=>{
    if(states.requests!=='success'||requestGeneration!==refresh||filter!=='All'||queueFocus.current===null)return;
    const card=document.getElementById('provider-request-'+queueFocus.current);
    if(card){card.scrollIntoView({block:'start'});card.focus({preventScroll:true});queueFocus.current=null;}
  },[requests,states.requests,filter,requestGeneration,refresh]);
  function openQueueRequest(id){queueFocus.current=id;setFilter('All');setRefresh(value=>value+1);}
  async function runAction(key,operation,message){
    if(actionLock.current)return false;
    actionLock.current=true;
    const controller=new AbortController();actionController.current=controller;
    setBusy(key);setActionError('');setNotice('');
    try{
      const result=await operation(controller.signal);
      if(controller.signal.aborted)return false;
      setNotice(message(result));setEditing(null);setRefresh(value=>value+1);return true;
    }catch(error){
      if(controller.signal.aborted||axios.isCancel(error))return false;
      if(error.response?.status===401)expire();else setActionError(bankError(error,'complete this operation'));
      return false;
    }finally{
      if(!controller.signal.aborted){actionController.current=null;actionLock.current=false;setBusy('');}
    }
  }
  function operationKey(key){
    if(!operationKeys.current.has(key))operationKeys.current.set(key,newOperationKey());
    return operationKeys.current.get(key);
  }
  function saveStock(group){
    const value=Number(units);
    if(!units.trim()||!Number.isInteger(value)||value<0||value>maximumUnits){setActionError('Enter a whole number from 0 to 2147483647 units.');return;}
    runAction('stock-'+group,signal=>updateBankInventory(session,group,value,signal,editVersion,provider),()=>group+' inventory updated to '+value+' units.');
  }
  async function allocateStock(request){
    const key='inventory-'+request.request_id;
    let uuid;try{uuid=operationKey(key);}catch{setActionError('Unable to prepare this operation. Please reload and try again.');return;}
    const success=await runAction(key,signal=>processBankRequest(session,request.request_id,signal,uuid,provider),
      result=>'Request #'+request.request_id+': '+result.allocated_units+' inventory units allocated. '+result.fulfilled_units+'/'+request.units_required+' fulfilled; '+result.remaining_units+' remaining.');
    if(success)operationKeys.current.delete(key);
  }
  function matchDonors(request){
    runAction('match-'+request.request_id,signal=>findRequestDonors(session,request.request_id,signal,provider),
      result=>request.workflow_version===2 ? result.notified_count+' eligible donors checked for invitations. Existing notifications are deduplicated.' : result.notified_count+' eligible donors newly notified for request #'+request.request_id+'.');
  }
  function screen(request,donor,result){
    runAction('screen-'+request.request_id+'-'+donor.donor_id,signal=>recordDonorScreening(session,request.request_id,donor.donor_id,result,signal,provider),
      ()=>donor.name+': screening '+result.toLowerCase()+'. Only a confirmed donation contributes fulfilled units.');
  }
  async function donate(request,donor){
    const field=request.request_id+'-'+donor.donor_id;
    const amount=Number(donationUnits[field]);
    if(!String(donationUnits[field]??'').trim()||!Number.isInteger(amount)||amount<1||(accountingPaths[field]!=='Inventory'&&amount>request.remaining_units)){setActionError('Enter a positive whole number no greater than the remaining '+request.remaining_units+' units.');return;}
    const path=request.workflow_version===2 ? accountingPaths[field] || 'DirectRequest' : undefined;
    const key='donation-'+field+'-'+amount+(path?'-'+path:'');
    let uuid;try{uuid=operationKey(key);}catch{setActionError('Unable to prepare this donation. Please reload and try again.');return;}
    const success=await runAction(key,signal=>recordActualDonation(session,request.request_id,donor.donor_id,amount,uuid,signal,provider,path),
      result=>path==='Inventory' ? 'Actual donation recorded into your inventory. This did not fulfill request units.' : 'Actual donation recorded: '+amount+' units. Request #'+request.request_id+' is '+result.status+'; '+result.fulfilled_units+'/'+request.units_required+' fulfilled, '+result.remaining_units+' remaining.');
    if(success){operationKeys.current.delete(key);setDonationUnits(current=>({...current,[field]:''}));}
  }
  function sectionState(section){
    if(states[section]==='loading')return <p className="bank-state" role="status">Loading {section}...</p>;
    if(states[section]==='error')return <div className="bank-error" role="alert"><p>{errors[section]}</p><button type="button" disabled={Boolean(busy)} onClick={()=>setRefresh(value=>value+1)}>Try again</button></div>;
    return null;
  }
  const inventoryReady=states.inventory==='success';
  const visibleRequests=requests.filter(row=>filter==='All'||row.status===filter);
  return <main className="bank-dashboard"><div className="bank-container">
    <div className="bank-toolbar"><nav aria-label="Organization navigation"><a href="#bank-overview">Dashboard</a>{hasInventory&&<a href="#bank-inventory">Inventory</a>}{clinical&&<a href="#bank-requests">Blood Requests</a>}<a href="#bank-profile">Profile</a></nav><button className="bank-logout" type="button" onClick={expire}>Logout</button></div>
    <header className="bank-welcome" id="bank-overview"><div><p className="bank-kicker">LifeSaver {organizationType.toLowerCase()} workspace</p><h1>{profile?.name||profile?.bank_name||organizationType+' Dashboard'}</h1><p>Coordinate safe donation and track requests assigned to your organization.</p></div><button className="bank-secondary bank-refresh" type="button" disabled={Boolean(busy)} onClick={()=>setRefresh(value=>value+1)}>Refresh</button></header>
    {clinical&&<div className="bank-stats" aria-label="Organization summary">
      {hasInventory&&<div><span>Available units</span><strong>{inventoryReady?inventory.reduce((total,row)=>total+row.units_available,0):'\u2014'}</strong><small>Across your blood stock</small></div>}
      <div><span>Pending requests</span><strong>{states.requests==='success'?requests.filter(row=>row.status==='Pending').length:'\u2014'}</strong><small>Awaiting processing</small></div>
      <div><span>Processing requests</span><strong>{states.requests==='success'?requests.filter(row=>row.status==='Processing').length:'\u2014'}</strong><small>Donor or fulfillment activity</small></div>
      <div><span>Fulfilled requests</span><strong>{states.requests==='success'?requests.filter(row=>row.status==='Fulfilled').length:'\u2014'}</strong><small>From your request history</small></div>
    </div>}
    <WorkflowNotice config={workflow} />
    <WorkflowNotifications session={session} enabled={workflow.enabled} refreshKey={refresh} onUnauthorized={expire} />
    {notice&&<p className="bank-notice" role="status">{notice}</p>}{actionError&&<p className="bank-error bank-action-error" role="alert">{actionError}</p>}
    <section className="bank-section bank-profile" id="bank-profile"><div className="bank-section-heading"><div><p className="bank-kicker">Your account</p><h2>{organizationType} Profile</h2></div><span className="bank-profile-role">{organizationType}</span></div>{sectionState('profile')}
      {states.profile==='success'&&profile&&<dl className="bank-profile-fields"><div><dt>Organization Name</dt><dd>{profile.name||profile.bank_name}</dd></div><div><dt>Location</dt><dd>{[profile.city,profile.state].filter(Boolean).join(', ')||'Not provided'}</dd></div><div><dt>Address</dt><dd>{profile.address||'Not provided'}</dd></div><div><dt>Phone</dt><dd>{profile.phone||'Not provided'}</dd></div><div><dt>Email</dt><dd>{profile.email||'Not provided'}</dd></div></dl>}
      {states.profile==='success'&&(!profile?.state||!profile?.city)&&<p className="bank-help"><Link to="/organization/dashboard">Complete your organization location</Link> to enable local donor matching.</p>}
    </section>
    {hasInventory&&<section className="bank-section bank-inventory" id="bank-inventory"><div className="bank-section-heading"><div><p className="bank-kicker">Your blood stock</p><h2>Inventory Overview</h2></div><span>All 8 blood groups</span></div><p className="bank-help">Check actual stock before editing. If stock changes while you edit, refresh before saving again.</p>{sectionState('inventory')}
      {inventoryReady&&<div className="bank-inventory-grid">{bloodGroups.map(group=>{
        const row=inventory.find(item=>item.blood_group===group);
        return <article className="bank-stock-card" key={group}><div className="bank-stock-heading"><h3>{group}</h3><span className={row?.units_available>0?'bank-stock-present':'bank-stock-empty'}>{row?.units_available>0?'In stock':'No stock'}</span></div><p className="bank-stock-units"><strong>{row?.units_available??0}</strong> units</p><p className="bank-stock-date">Last updated<br/>{row?formatRequestDate(row.updated_at):'Not yet updated'}</p>
          {editing===group?<form noValidate onSubmit={event=>{event.preventDefault();saveStock(group);}}><label htmlFor={'bank-units-'+group}>Units available for {group}</label><input id={'bank-units-'+group} className="bank-units-input" type="number" min="0" max={maximumUnits} step="1" value={units} onChange={event=>setUnits(event.target.value)} disabled={Boolean(busy)} autoFocus/><div className="bank-stock-actions"><button className="bank-primary" type="submit" disabled={Boolean(busy)}>{busy==='stock-'+group?'Saving...':'Save'}</button><button className="bank-secondary" type="button" disabled={Boolean(busy)} onClick={()=>setEditing(null)}>Cancel</button></div></form>
            :<button className="bank-secondary bank-edit-stock" type="button" disabled={Boolean(busy)} onClick={()=>{setEditing(group);setUnits(String(row?.units_available??0));setEditVersion(row?.version??0);setActionError('');}}>Update {group}</button>}
        </article>;
      })}</div>}
    </section>}
    {clinical&&profile&&<ProviderRequestQueue session={session} provider={provider??profile} refreshKey={refresh} busy={busy} onUnauthorized={expire} onOpen={openQueueRequest}/>}
    {clinical&&<section className="bank-section bank-requests" id="bank-requests"><div className="bank-section-heading"><div><p className="bank-kicker">Assigned to your organization</p><h2>Blood Requests</h2></div><div className="bank-filter"><label htmlFor="bank-request-filter">Status</label><select id="bank-request-filter" value={filter} onChange={event=>setFilter(event.target.value)}>{['All','Pending','Processing','Fulfilled','Cancelled'].map(status=><option key={status}>{status}</option>)}</select></div></div><p className="bank-help">Emergency requests appear first. Screening and donation are recorded separately through an authorized medical process.</p>{sectionState('requests')}
      {states.requests==='success'&&(visibleRequests.length===0?<p className="bank-empty">{requests.length===0?'No blood requests are currently assigned to your organization.':'No requests match this status.'}</p>:<ul className="bank-request-list">{visibleRequests.map(request=>{
        const open=['Pending','Processing'].includes(request.status)&&request.remaining_units>0;
        const canAct=request.workflow_version!==2||(workflow.enabled&&hasInventory&&request.can_supply!==false);
        const clinicalOpen=open&&canAct;
        const canViewDonors=request.workflow_version!==2||hasInventory;
        return <li className="bank-request-card" id={'provider-request-'+request.request_id} tabIndex={-1} key={request.request_id}><div className="bank-request-heading"><h3>Request #{request.request_id}</h3><div className="bank-badges"><span className={'bank-badge bank-urgency-'+request.urgency_level.toLowerCase()}>{request.urgency_level}</span><span className={'bank-badge bank-status-'+request.status.toLowerCase()}>{request.status}</span></div></div><dl className="bank-request-fields"><div><dt>Blood Group</dt><dd>{request.blood_group}</dd></div><div><dt>Required</dt><dd>{request.units_required} units</dd></div><div><dt>Fulfilled</dt><dd>{request.fulfilled_units} units</dd></div><div><dt>Remaining</dt><dd>{request.remaining_units} units</dd></div>{request.workflow_version===2&&<div><dt>Admission Hospital</dt><dd>{request.admission_hospital_name}</dd></div>}<div><dt>Location</dt><dd>{[request.city,request.state].filter(Boolean).join(', ')||'Not provided'}</dd></div><div><dt>Created</dt><dd>{formatRequestDate(request.request_date)}</dd></div></dl>
          {request.workflow_version===2&&<div className="workflow-v2-context"><p>{!open ? request.status==='Cancelled'?'Request cancelled. New screening and donation confirmation are unavailable. Existing history is preserved.':'Request fulfilled or no units remain. New screening and donation confirmation are unavailable.' : hasInventory&&request.can_supply===false?'Current location is not eligible for inventory supply or new matching. Screening and actual collection remain available only for donors already assigned to this Blood Bank.':hasInventory?'City-wide request. Allocate only your own stock; only your designated donors can be screened and collected here.':'Admission/status view only. Eligible Blood Banks coordinate collection and fulfillment.'}</p><h4>Blood Bank contributions</h4>{request.contributions.length ? <ul className="workflow-contributions">{request.contributions.map((item,index)=><li key={index}>{item.bank_name}: {item.source} - {item.units_allocated} units</li>)}</ul>:<p>No fulfilled contributions yet.</p>}</div>}
          {request.history_available?<p className="bank-help">Inventory: {request.inventory_units} units &middot; Donation: {request.donation_units} units</p>:<p className="bank-help">Historical fulfillment source details are unavailable.</p>}
          {clinicalOpen&&<div className="bank-request-actions"><button className="bank-secondary" type="button" disabled={Boolean(busy)} onClick={()=>matchDonors(request)}>Find matching donors</button>{hasInventory&&<button className="bank-primary bank-process" type="button" disabled={Boolean(busy)} onClick={()=>allocateStock(request)}>{busy==='inventory-'+request.request_id?'Allocating...':'Allocate available stock'}</button>}</div>}
          {canViewDonors&&request.accepted_donors.length>0&&<section className="bank-screening" aria-label={'Accepted donors for request '+request.request_id}><h4>Accepted donors</h4><p>Acceptance and screening do not fulfill units. Confirm only an actual donation made through your organization.</p>{request.accepted_donors.map(donor=>{
            const field=request.request_id+'-'+donor.donor_id;
            const ownBankId=session.user.user_type==='blood_bank'?session.user.user_id:(provider??profile)?.bank_id;
            const donorClinicalOpen=request.workflow_version===2
              ?open&&workflow.enabled&&hasInventory&&donor.collecting_bank_id===ownBankId:clinicalOpen;
            return <div className="bank-donor-card" key={donor.donor_id}><strong>{donor.name} &middot; {donor.blood_group||request.blood_group}</strong>{donor.phone&&<p>Phone: {donor.phone}</p>}{donor.email&&<p>Email: {donor.email}</p>}<p>Screening: {donor.screening_result||(open?'Awaiting screening':'Not recorded (request closed)')}{donor.screened_at?' - '+formatRequestDate(donor.screened_at):''}</p>
              {donorClinicalOpen&&!donor.screening_result&&<div className="bank-request-actions"><button className="bank-secondary" type="button" disabled={Boolean(busy)} onClick={()=>screen(request,donor,'Passed')}>Screening passed</button><button className="bank-secondary" type="button" disabled={Boolean(busy)} onClick={()=>screen(request,donor,'Failed')}>Screening failed</button></div>}
              {donor.collection_id&&<p className="workflow-collected" role="status">Actual collection recorded: {donor.units_collected} units. {donor.accounting_path==='Inventory'?'Added to own inventory only; this did not directly fulfill request units.':'Contributed directly to this request.'}</p>}
              {donor.screening_result==='Failed'&&<p>Donation cannot be recorded for this screening. Continue with another eligible donor.</p>}
              {donorClinicalOpen&&donor.screening_result==='Passed'&&!donor.collection_id&&<form className="bank-donation-form" onSubmit={event=>{event.preventDefault();donate(request,donor);}}><label htmlFor={'donation-units-'+field}>Actual donated units for {donor.name}</label><input id={'donation-units-'+field} type="number" inputMode="numeric" min="1" max={accountingPaths[field]==='Inventory'?maximumUnits:request.remaining_units} step="1" value={donationUnits[field]??''} onChange={event=>setDonationUnits(current=>({...current,[field]:event.target.value}))} disabled={Boolean(busy)} required/>{request.workflow_version===2&&<><label htmlFor={'accounting-path-'+field}>Record actual donation to</label><select id={'accounting-path-'+field} value={accountingPaths[field]||'DirectRequest'} onChange={event=>setAccountingPaths(current=>({...current,[field]:event.target.value}))} disabled={Boolean(busy)}><option value="DirectRequest">This request directly</option><option value="Inventory">Own inventory only</option></select><p>Confirm only actual blood collected through your Blood Bank. Inventory-only recording does not fulfill this request; allocate stock separately when appropriate.</p></>}<button className="bank-primary" type="submit" disabled={Boolean(busy)}>Record actual donation</button></form>}
            </div>;
          })}</section>}
        </li>;
      })}</ul>)}
    </section>}
  </div></main>;
}
function BloodBankDashboard({provider}){
  const {session,logout}=useAuth();
  return <BankDashboardContent key={session.token} session={session} logout={logout} provider={provider}/>;
}
export default BloodBankDashboard;
