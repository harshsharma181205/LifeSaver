import { Link } from 'react-router-dom';
import '../styles/home.css';

const steps = [
  { title: 'Request', text: 'Recipient creates a blood request.' },
  { title: 'Check', text: 'System checks blood-bank availability first.' },
  { title: 'Match', text: 'If required blood is unavailable, potential donors are searched.' },
  { title: 'Notify', text: 'Suitable donors can receive notifications.' },
  { title: 'Fulfill', text: 'The request is fulfilled after blood is successfully arranged.' },
];

const features = [
  { title: 'Smart Blood Matching', text: 'Blood group, availability and location-based donor discovery.' },
  { title: 'Blood Bank First', text: 'Check available blood-bank inventory before individual donors.' },
  { title: 'Priority Requests', text: 'Emergency requests receive higher processing priority.' },
  { title: 'Request Tracking', text: 'Track requests through their processing status.' },
  { title: 'Donor Notifications', text: 'Keep suitable donors informed about relevant requests.' },
  { title: 'Reports & Insights', text: 'Help administrators monitor requests, donors, inventory and donations.' },
];

const audiences = [
  { title: 'Donors', text: 'Share your availability and help someone in need.' },
  { title: 'Recipients', text: 'Create and track blood requests.' },
  { title: 'Blood Banks', text: 'Manage blood inventory and support fulfillment.' },
  { title: 'Administrators', text: 'Monitor the platform through reports and dashboards.' },
];

function Home() {
  return (
    <main className="public-home">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-container hero-layout">
          <div className="hero-copy">
            <p className="home-kicker">Blood access, made simpler</p>
            <h1 id="home-title">Connecting people to the blood they need, <span>when it matters most.</span></h1>
            <p className="hero-description">LifeSaver connects blood requests, donors and blood-bank availability through one simple platform.</p>
            <div className="hero-actions">
              <Link className="home-button home-button-primary" to="/login">Find Blood <span aria-hidden="true">&#8594;</span></Link>
              <Link className="home-button home-button-secondary" to="/register">Become a Donor</Link>
            </div>
          </div>

          <div className="hero-visual" role="img" aria-label="LifeSaver connects blood requests, blood banks and donors">
            <div className="visual-caption">
              <span className="visual-caption-mark" aria-hidden="true" />
              One connected platform
            </div>
            <div className="connection-map">
              <svg className="connection-lines" viewBox="0 0 400 320" preserveAspectRatio="none" aria-hidden="true">
                <path d="M200 72v100M200 172v52H94v24M200 224h106v24" />
                <circle cx="200" cy="224" r="4" />
              </svg>
              <div className="connection-node request-node">
                <span className="node-label">Start with a need</span>
                <strong>Blood requests</strong>
              </div>
              <div className="connection-center">
                <span className="connection-logo" aria-hidden="true">
                  <svg viewBox="0 0 24 28" fill="none">
                    <path d="M12 2C9 6 3 13 3 18a9 9 0 0 0 18 0c0-5-6-12-9-16Z" fill="currentColor" />
                  </svg>
                </span>
                <strong>LifeSaver</strong>
              </div>
              <div className="connection-node bank-node">
                <strong>Blood banks</strong>
                <span className="node-label">Inventory first</span>
              </div>
              <div className="connection-node donor-node">
                <strong>Donors</strong>
                <span className="node-label">Community support</span>
              </div>
            </div>
            <p className="visual-note">A simpler path from request to support.</p>
          </div>
        </div>
      </section>

      <section id="about" className="home-section home-about" aria-labelledby="about-title" tabIndex={-1}>
        <div className="home-container">
          <p className="home-kicker">About LifeSaver</p>
          <h2 id="about-title">Built to simplify blood access.</h2>
          <p className="about-description">LifeSaver brings blood requests, donor discovery and blood-bank availability into one connected platform. It helps people manage blood requirements while giving donors a simple way to become part of the solution.</p>
          <ul className="about-highlights">
            <li>Donor Discovery</li>
            <li>Blood Bank Availability</li>
            <li>Request Management</li>
          </ul>
        </div>
      </section>

      <section id="how-it-works" className="home-section home-workflow" aria-labelledby="workflow-title" tabIndex={-1}>
        <div className="home-container">
          <div className="home-section-heading">
            <p className="home-kicker">From need to fulfillment</p>
            <h2 id="workflow-title">How It Works</h2>
          </div>
          <ol className="workflow-grid">
            {steps.map((step, index) => (
              <li className="workflow-step" key={step.title}>
                <span className="workflow-number">{String(index + 1).padStart(2, '0')}</span>
                <div className="workflow-copy">
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="workflow-note">Matching considers blood group, self-reported donor availability and city/area-level location.</p>
        </div>
      </section>

      <section className="home-section home-features" aria-labelledby="features-title">
        <div className="home-container">
          <div className="home-section-heading">
            <p className="home-kicker">Designed to work together</p>
            <h2 id="features-title">Everything in one place</h2>
          </div>
          <div className="features-grid">
            {features.map((feature) => (
              <article className="feature-card" key={feature.title}>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="home-section home-audiences" aria-labelledby="audiences-title">
        <div className="home-container">
          <div className="home-section-heading">
            <p className="home-kicker">A shared effort</p>
            <h2 id="audiences-title">Built for everyone involved</h2>
          </div>
          <div className="audiences-grid">
            {audiences.map((audience) => (
              <article className="audience-card" key={audience.title}>
                <h3>{audience.title}</h3>
                <p>{audience.text}</p>
              </article>
            ))}
          </div>
          <p className="medical-note">Donor availability shown by LifeSaver is self-reported. Final donor eligibility and medical screening are determined by the blood bank or qualified medical professionals.</p>
        </div>
      </section>


    </main>
  );
}

export default Home;
