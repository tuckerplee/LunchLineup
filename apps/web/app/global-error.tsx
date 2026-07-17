'use client';

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main style={{ margin: '0 auto', maxWidth: 680, padding: '64px 24px' }}>
          <section role="alert" aria-labelledby="global-error-title">
            <p>LunchLineup</p>
            <h1 id="global-error-title">The application could not finish loading</h1>
            <p>Your data was not changed. Retry now, or return to sign in.</p>
            <p>
              <button type="button" onClick={reset}>Try again</button>{' '}
              <a href="/auth/login">Sign in</a>
            </p>
          </section>
        </main>
      </body>
    </html>
  );
}
