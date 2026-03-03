# Developer Onboarding

Welcome to LunchLineup! Before contributing, please:

1. Read the root [README](../README.md) for project setup and workflow.
2. Review the [User and Staff Architecture](user_staff_architecture.md) document to understand
   how repositories and services interact. Following this design keeps user and staff
   behaviour consistent.
3. Run `php -l $(git ls-files '*.php')` and `node --check $(git ls-files '*.js')`
   before committing any changes.

Keeping these steps in mind helps prevent architectural drift and eases code reviews.
