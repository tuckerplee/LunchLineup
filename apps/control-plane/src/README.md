# Control Plane Source

TypeScript entrypoint for the control-plane service.

## Files

- `README.md`: this folder guide.
- `main.ts`: Express control-plane server with loopback-safe defaults, separate admin and metrics bearer-token protection, opt-in Docker-backed status, health, security headers, and fixed-classification error handling that never emits exception details.
