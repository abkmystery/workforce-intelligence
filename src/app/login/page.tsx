import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-art" aria-label="Workforce Intelligence">
        <div className="brand"><span className="brand-mark">WI</span><span className="brand-text"><strong>Workforce</strong><small>Intelligence</small></span></div>
        <div><h1>Find the next role for your people.</h1><p>Connect people needing a role with teams needing their skills.</p></div>
        <span style={{ color: "#afcbb9", fontSize: 11 }}>Secure enterprise access</span>
      </section>
      <section className="login-form-side">
        <div className="login-card">
          <div className="eyebrow">Welcome</div>
          <h2>Sign in to your workspace</h2>
          <p>Continue with your organization’s Microsoft Entra account.</p>
          <Link className="btn primary" href="/api/auth/login">Continue with Microsoft Entra <span aria-hidden="true">→</span></Link>
          <div className="login-foot">Access is controlled by your organization. Contact your administrator if you need an account.</div>
        </div>
      </section>
    </main>
  );
}
