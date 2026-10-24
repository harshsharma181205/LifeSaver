export default function WorkflowNotice({ config }) {
  if (config.loading) return <p className="workflow-notice" role="status">Checking request workflow...</p>;
  if (config.enabled) return null;
  return <p className="workflow-notice" role="status">V2 city-wide workflow is not activated. Existing provider-assigned requests remain available.
    {config.error && ' Configuration could not be verified. New V2 actions are disabled.'}</p>;
}
