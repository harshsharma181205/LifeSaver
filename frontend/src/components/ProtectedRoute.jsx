import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { normalizeAuthSession } from '../utils/authStorage.js';

function ProtectedRoute({ allowedUserType, allowedUserTypes, children }) {
  const { session, isAuthenticated } = useAuth();
  // Expiry aur role check honge; storage/context ko yahan change nahi karenge.
  const currentSession = normalizeAuthSession(session);

  const roles = allowedUserTypes ?? (Array.isArray(allowedUserType) ? allowedUserType : [allowedUserType]);
  if (!isAuthenticated || !currentSession || !roles.includes(currentSession.user.user_type)) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

export default ProtectedRoute;
