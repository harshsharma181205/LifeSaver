import { Link } from 'react-router-dom';
import '../styles/footer.css';

function Footer() {
  return (
    <footer className="lifesaver-footer">
      <div className="lifesaver-footer-inner">
        <div className="lifesaver-footer-brand">
          <Link to="/" aria-label="LifeSaver home">LifeSaver</Link>
          <p className="lifesaver-footer-subtitle">Blood Donation Management System</p>
          <p>Connecting eligible donors, recipients, hospitals and blood banks for faster and safer blood coordination.</p>
        </div>
        <section className="lifesaver-footer-links" aria-labelledby="footer-platform-title">
          <h2 id="footer-platform-title">Platform</h2>
          <ul>
            <li><Link to="/">Home</Link></li>
            <li><Link to="/#how-it-works">How It Works</Link></li>
            <li><Link to="/login">Login</Link></li>
            <li><Link to="/register">Register</Link></li>
          </ul>
        </section>
        <section className="lifesaver-footer-links" aria-labelledby="footer-users-title">
          <h2 id="footer-users-title">For Users</h2>
          <ul>
            <li><Link to="/register?type=donor">Donors</Link></li>
            <li><Link to="/register?type=recipient">Recipients</Link></li>
            <li><Link to="/register?type=organization">Organizations</Link></li>
          </ul>
        </section>
      </div>
      <div className="lifesaver-footer-bottom">&copy; 2026 LifeSaver. All rights reserved.</div>
    </footer>
  );
}
export default Footer;
