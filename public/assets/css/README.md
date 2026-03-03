# CSS Assets

- **base.css** – Core variables, body styles and shared components (panels, buttons, notifications, modals).
- **nav.css** – Compact navigation button styling for a consistent top menu; includes default accent fallback.
- **landing.css** – Styles for the homepage hero header and scroll animations.
- **scheduler.css** – Schedule table layout, task helpers and timeline visuals.
- **print.css** – Print-specific rules and helpers, including `.no-print`/`.print-only` toggles. Default print size is A4 landscape with no margins (0 mm); the page auto-scales to fit a single sheet.
- **bootstrap_print_subset.css** – Minimal Bootstrap utilities and card/table styles bundled for Dompdf so PDF exports do not depend on the CDN.
- Bootstrap 5 is loaded from a CDN to enhance modal and form styling.
- Tailwind CSS is loaded from a CDN for utility classes.

All styles are loaded directly by `../index.php` with no build step required.
