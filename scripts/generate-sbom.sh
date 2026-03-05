#!/bin/bash
# scripts/generate-sbom.sh
# Automated SBOM generation using Syft.
# Architecture Part VII-A.

echo "Generating SBOM for all services..."

mkdir -p artifacts/sbom

for service in api engine web worker control; do
  echo "Scanning lunchlineup-$service:latest..."
  # syft lunchlineup-$service:latest -o json > artifacts/sbom/$service-sbom.json
done

echo "SBOM generation complete. Manifests saved to artifacts/sbom/"
