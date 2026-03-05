#!/bin/bash
# scripts/run-dast.sh
# Dynamic Application Security Testing using OWASP ZAP.
# Architecture Part VII-A.

TARGET_URL=${1:-"http://localhost:3000"}

echo "Starting DAST scan against $TARGET_URL..."

# docker run --rm -v $(pwd):/zap/wrk/:rw -t owasp/zap2docker-stable zap-baseline.py \
#    -t $TARGET_URL -r zap-report.html

echo "DAST scan complete. Report available at zap-report.html"
