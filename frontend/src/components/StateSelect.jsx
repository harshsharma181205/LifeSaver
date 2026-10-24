import { useState } from 'react';
import { indiaStates } from '../data/indiaStates.js';
import '../styles/stateSelect.css';

function StateSelect({ id, name = 'state', value, onChange, disabled = false, required = false, searchable = true }) {
  const [search, setSearch] = useState('');
  const filtered = indiaStates.filter(state => !searchable || state.toLowerCase().includes(search.trim().toLowerCase()));
  // Keep the selected value present while searching without selecting another state.
  const options = value && !filtered.includes(value) && indiaStates.includes(value)
    ? [value, ...filtered] : filtered;
  return (
    <div className="state-select">
      {searchable && <input id={id + '-search'} type="search" value={search} disabled={disabled}
        aria-label="Search states and union territories" placeholder="Search states or union territories"
        onChange={event => setSearch(event.target.value)} />}
      <select id={id} name={name} value={value} onChange={onChange} disabled={disabled} required={required}>
        <option value="">Select state or union territory</option>
        {options.map(state => <option value={state} key={state}>{state}</option>)}
      </select>
      {filtered.length === 0 && <small role="status">No states match your search.</small>}
    </div>
  );
}
export default StateSelect;
