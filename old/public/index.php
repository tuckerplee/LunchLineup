<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LunchLineup</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css" rel="stylesheet">
    <link rel="stylesheet" href="assets/css/nav.css">
    <link rel="stylesheet" href="assets/css/base.css">
    <link rel="preconnect" href="https://images.unsplash.com" crossorigin>
    <link
        rel="preload"
        as="image"
        href="https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1650&q=80"
        crossorigin
    >
    <link rel="stylesheet" href="assets/css/landing.css">
</head>
<body>
    <nav class="navbar navbar-dark navbar-expand-md" style="background-color: var(--accent);">
        <div class="container">
            <a class="navbar-brand d-flex align-items-center" href="https://lunchlineup.com"><i class="bi bi-calendar-check me-2"></i>LunchLineup</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#mainNav" aria-controls="mainNav" aria-expanded="false" aria-label="Toggle navigation">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div id="mainNav" class="collapse navbar-collapse">
                <ul class="navbar-nav me-auto">
                    <li class="nav-item"><a class="nav-link" href="#features">Features</a></li>
                    <li class="nav-item"><a class="nav-link" href="#metrics">Metrics</a></li>
                    <li class="nav-item"><a class="nav-link" href="#faq">FAQ</a></li>
                </ul>
                <div class="d-flex gap-2">
                    <a class="top-nav-btn" href="login.php">Log In</a>
                    <a class="btn btn-outline-light" href="login.php#register">Get Started</a>
                </div>
            </div>
        </div>
    </nav>
    <header class="hero-header text-white text-center py-5" style="background:url('https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1650&q=80') center/cover no-repeat;">
        <div class="container">
            <h1 class="display-4">Simplify your staff scheduling</h1>
            <p class="lead">Create, manage and share schedules effortlessly.</p>
            <a class="btn btn-primary btn-lg d-inline-flex align-items-center" href="login.php#register"><i class="bi bi-calendar-check me-2"></i>Get Started</a>
        </div>
    </header>
    <section id="features" class="py-5 bg-light scroll-section">
        <div class="container">
            <div class="row text-center">
                <div class="col-md-4 mb-4">
                    <div class="feature-card p-4 h-100">
                        <i class="bi bi-calendar-check display-5 text-primary"></i>
                        <h3 class="mt-3">Intuitive Interface</h3>
                        <p>Drag-and-drop scheduling with real-time updates.</p>
                    </div>
                </div>
                <div class="col-md-4 mb-4">
                    <div class="feature-card p-4 h-100">
                        <i class="bi bi-cpu display-5 text-primary"></i>
                        <h3 class="mt-3">Smart Automation</h3>
                        <p>Automatic break handling and shift conflict detection.</p>
                    </div>
                </div>
                <div class="col-md-4 mb-4">
                    <div class="feature-card p-4 h-100">
                        <i class="bi bi-shield-lock display-5 text-primary"></i>
                        <h3 class="mt-3">Data Security</h3>
                        <p>JWT-based authentication keeps your data safe.</p>
                    </div>
                </div>
            </div>
        </div>
    </section>
    <section class="py-5 scroll-section">
        <div class="container">
            <div class="row align-items-center">
                <div class="col-md-6">
                    <h2>Stay organized from anywhere</h2>
                    <p>Access schedules on any device and keep your team on track.</p>
                    <ul class="list-unstyled">
                        <li class="mb-2"><i class="bi bi-phone me-2 text-primary"></i>Mobile-friendly responsive design</li>
                        <li class="mb-2"><i class="bi bi-cloud-arrow-up me-2 text-primary"></i>Cloud storage for reliable access</li>
                        <li class="mb-2"><i class="bi bi-people me-2 text-primary"></i>Share with staff in seconds</li>
                    </ul>
                </div>
                <div class="col-md-6">
                    <img class="img-fluid rounded shadow" src="https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=1350&q=80" alt="Scheduling screenshot">
                </div>
            </div>
        </div>
    </section>
    <section id="metrics" class="py-5 bg-light text-center scroll-section">
        <div class="container">
            <div class="row">
                <div class="col-md-4 mb-4">
                    <div class="metric-card p-4">
                        <span class="counter d-block" data-target="40">0</span>
                        <p class="mt-2">Hours saved per week</p>
                    </div>
                </div>
                <div class="col-md-4 mb-4">
                    <div class="metric-card p-4">
                        <span class="counter d-block" data-target="40">0</span>
                        <p class="mt-2">Tasks automated</p>
                    </div>
                </div>
                <div class="col-md-4 mb-4">
                    <div class="metric-card p-4">
                        <span class="counter d-block" data-target="40">0</span>
                        <p class="mt-2">Teams onboarded</p>
                    </div>
                </div>
            </div>
        </div>
    </section>
    <section id="faq" class="py-5 scroll-section">
        <div class="container">
            <h2 class="text-center mb-4">Frequently Asked Questions</h2>
            <div class="accordion" id="faqAccordion">
                <div class="accordion-item">
                    <h2 class="accordion-header" id="faqHeadingOne">
                        <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#faqCollapseOne" aria-expanded="false" aria-controls="faqCollapseOne">
                            How do I invite staff members?
                        </button>
                    </h2>
                    <div id="faqCollapseOne" class="accordion-collapse collapse" aria-labelledby="faqHeadingOne" data-bs-parent="#faqAccordion">
                        <div class="accordion-body">
                            Send invitations from the Staff page and your team can join with a single click.
                        </div>
                    </div>
                </div>
                <div class="accordion-item">
                    <h2 class="accordion-header" id="faqHeadingTwo">
                        <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#faqCollapseTwo" aria-expanded="false" aria-controls="faqCollapseTwo">
                            Can I export schedules?
                        </button>
                    </h2>
                    <div id="faqCollapseTwo" class="accordion-collapse collapse" aria-labelledby="faqHeadingTwo" data-bs-parent="#faqAccordion">
                        <div class="accordion-body">
                            Yes, schedules can be printed or exported to share with your team.
                        </div>
                    </div>
                </div>
                <div class="accordion-item">
                    <h2 class="accordion-header" id="faqHeadingThree">
                        <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#faqCollapseThree" aria-expanded="false" aria-controls="faqCollapseThree">
                            Is my data secure?
                        </button>
                    </h2>
                    <div id="faqCollapseThree" class="accordion-collapse collapse" aria-labelledby="faqHeadingThree" data-bs-parent="#faqAccordion">
                        <div class="accordion-body">
                            We use JWT-based authentication and cloud backups to protect your information.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>
    <section class="py-5 bg-light scroll-section">
        <div class="container">
            <h2 class="text-center mb-5">What users say</h2>
            <div class="row">
                <div class="col-md-4 text-center">
                    <img class="rounded-circle mb-3" src="https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80" alt="User 1">
                    <p class="fst-italic">"LunchLineup made coordinating shifts a breeze."</p>
                    <small class="d-block">Alex P.</small>
                </div>
                <div class="col-md-4 text-center">
                    <img class="rounded-circle mb-3" src="https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=100&h=100&q=80" alt="User 2">
                    <p class="fst-italic">"Our team loves the simplicity and powerful features."</p>
                    <small class="d-block">Jamie L.</small>
                </div>
                <div class="col-md-4 text-center">
                    <img class="rounded-circle mb-3" src="https://images.unsplash.com/photo-1544723795-3fb6469f5b39?auto=format&fit=crop&w=100&h=100&q=80" alt="User 3">
                    <p class="fst-italic">"Scheduling has never been easier for our business."</p>
                    <small class="d-block">Morgan K.</small>
                </div>
            </div>
        </div>
    </section>
    <section class="py-5 text-center scroll-section">
        <div class="container">
            <h2>Ready to streamline your scheduling?</h2>
            <a class="btn btn-primary btn-lg d-inline-flex align-items-center" href="login.php"><i class="bi bi-calendar-check me-2"></i>Log in now</a>
        </div>
    </section>
    <footer class="bg-light text-center py-3">
        <div class="container">
            <div class="footer-links">
                <a href="#">Terms</a>
                <a href="#">Privacy</a>
                <a href="#">Contact</a>
                <span>&copy; <?php echo date('Y'); ?> LunchLineup</span>
            </div>
        </div>
    </footer>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    <script src="assets/js/landing.js"></script>
</body>
</html>
