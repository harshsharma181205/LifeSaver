import { Route, Routes } from 'react-router-dom';
import BloodBankDashboard from './pages/BloodBankDashboard.jsx';
import Header from './components/Header.jsx';
import Footer from './components/Footer.jsx';
import OrganizationDashboard from './pages/OrganizationDashboard.jsx';
import DonorDashboard from './pages/DonorDashboard.jsx';
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import RecipientDashboard from './pages/RecipientDashboard.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import CreateBloodRequest from './pages/CreateBloodRequest.jsx';
import RecipientRequestDetails from './pages/RecipientRequestDetails.jsx';

function App() {
  return (
    <div className="app">
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/recipient/dashboard"
          element={
            <ProtectedRoute allowedUserType="recipient">
              <RecipientDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/recipient/requests/create"
          element={
            <ProtectedRoute allowedUserType="recipient">
              <CreateBloodRequest />
            </ProtectedRoute>
          }
        />
        <Route
          path="/recipient/requests/:requestId"
          element={
            <ProtectedRoute allowedUserType="recipient">
              <RecipientRequestDetails />
            </ProtectedRoute>
          }
        />
        <Route path="/organization/dashboard" element={<ProtectedRoute allowedUserTypes={['organization', 'blood_bank']}><OrganizationDashboard /></ProtectedRoute>} />
        <Route path="/blood-bank/dashboard" element={<ProtectedRoute allowedUserType="blood_bank"><BloodBankDashboard /></ProtectedRoute>} />
        <Route path="/donor/dashboard" element={<ProtectedRoute allowedUserType="donor"><DonorDashboard /></ProtectedRoute>} />
      </Routes>
      <Footer />
    </div>
  );
}

export default App;
