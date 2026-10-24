import { useEffect, useState } from 'react';
import axios from 'axios';
import { fetchWorkflowConfig } from '../services/workflowV2Api.js';

export default function useWorkflowConfig(session) {
  const [config, setConfig] = useState({ enabled: false, loading: true, error: false });
  useEffect(() => {
    const controller = new AbortController();
    setConfig({ enabled: false, loading: true, error: false });
    fetchWorkflowConfig(session, controller.signal).then(data => {
      if (!controller.signal.aborted) setConfig({ enabled: data.workflow_v2_enabled, loading: false, error: false });
    }).catch(error => {
      if (!controller.signal.aborted && !axios.isCancel(error)) setConfig({ enabled: false, loading: false, error: true });
    });
    return () => controller.abort();
  }, [session?.token]);
  return config;
}
