import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import '../styles/header.css';

function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { session, isAuthenticated } = useAuth();
  const dashboardPaths = { donor: '/donor/dashboard', recipient: '/recipient/dashboard', blood_bank: '/blood-bank/dashboard', organization: '/organization/dashboard' };
  const dashboardPath = isAuthenticated ? dashboardPaths[session?.user?.user_type] : null;

  useEffect(() => {
    setMenuOpen(false);
    // Hash link se Home ke section par jayenge; doosre pages top se khulenge.
    if (location.hash) {
      const section = document.getElementById(location.hash.slice(1));
      if (section) {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
        section.focus({ preventScroll: true });
      }
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
  }, [location]);

  function closeMenu() {
    setMenuOpen(false);
  }

  function handleMenuKeyDown(event) {
    if (menuOpen && event.key === 'Escape') {
      closeMenu();
      document.getElementById('navigation-toggle').focus();
    }
  }

  return (
    <header className="site-header public-header" onKeyDown={handleMenuKeyDown}>
      <div className="header-container">
        <Link className="brand" to="/" aria-label="LifeSaver home" onClick={closeMenu}>
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 28" fill="none">
              <path d="M12 2C9 6 3 13 3 18a9 9 0 0 0 18 0c0-5-6-12-9-16Z" fill="currentColor" />
            </svg>
          </span>
          <span>LifeSaver</span>
        </Link>

        <button
          id="navigation-toggle"
          className="navigation-toggle"
          type="button"
          aria-controls="site-navigation"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span>Menu</span>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {menuOpen
              ? <path d="m6 6 12 12M6 18 18 6" />
              : <path d="M4 6h16M4 12h16M4 18h16" />}
          </svg>
        </button>

        <nav
          id="site-navigation"
          className={`site-navigation ${menuOpen ? 'is-open' : ''}`}
          aria-label="Main navigation"
        >
          <Link className="navigation-link" to="/" aria-current={location.pathname === '/' && !location.hash ? 'page' : undefined} onClick={closeMenu}>Home</Link>
          <Link className="navigation-link" to="/#about" aria-current={location.pathname === '/' && location.hash === '#about' ? 'location' : undefined} onClick={closeMenu}>About</Link>
          <Link className="navigation-link" to="/#how-it-works" aria-current={location.pathname === '/' && location.hash === '#how-it-works' ? 'location' : undefined} onClick={closeMenu}>How It Works</Link>
          <div className="navigation-account-links">
            {dashboardPath ? (
              <><Link className="navigation-register" to={dashboardPath} aria-current={location.pathname === dashboardPath ? 'page' : undefined} onClick={closeMenu}>Dashboard</Link>{session?.user?.user_type === 'blood_bank' && <Link className="navigation-link" to="/organization/dashboard" onClick={closeMenu}>Organization profile</Link>}</>
            ) : (
              <>
                <Link className="navigation-link navigation-login" to="/login" aria-current={location.pathname === '/login' ? 'page' : undefined} onClick={closeMenu}>Login</Link>
                <Link className="navigation-register" to="/register" aria-current={location.pathname === '/register' ? 'page' : undefined} onClick={closeMenu}>Register</Link>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}

export default Header;
