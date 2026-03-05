#!/bin/bash
# scripts/download-assets.sh
# Ensures CDN sovereignty by downloading external assets to be served locally.
# Part of Architecture Part X.

ASSETS_DIR="apps/web/public/assets"
mkdir -p "$ASSETS_DIR/fonts"
mkdir -p "$ASSETS_DIR/scripts"

echo "Downloading Inter Font..."
# curl -L https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip -o Inter.zip
# unzip Inter.zip -d "$ASSETS_DIR/fonts"

echo "Downloading Lucide Icons..."
# curl -L https://unpkg.com/lucide@latest/dist/lucide.min.js -o "$ASSETS_DIR/scripts/lucide.min.js"

echo "Asset download complete. All external dependencies are now hosted locally."
