'use client';

export default function AppError({ reset }: { reset: () => void }) {
  return (
    <main className="public-doc status-page">
      <article className="public-doc__main">
        <section className="public-doc__section" role="alert" aria-labelledby="app-error-title">
          <div className="public-doc__intro">
            <p className="public-home__eyebrow">Request interrupted</p>
            <h1 id="app-error-title">This page could not finish loading</h1>
            <p>Your session is unchanged. Retry the page, or return to the dashboard.</p>
            <div className="public-home__actions">
              <button className="btn btn-primary" type="button" onClick={reset}>Try again</button>
              <a className="btn btn-secondary" href="/dashboard">Dashboard</a>
            </div>
          </div>
        </section>
      </article>
    </main>
  );
}