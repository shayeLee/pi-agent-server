#!/usr/bin/env sh
# Same env-file loading and shared storage resolver as dev:real.
# Existing databases are verified without writes; bootstrap is empty-target only.
set -eu

exec tsx --env-file-if-exists=.env.local scripts/dev-real-init.ts
