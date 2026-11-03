#!/usr/bin/env bash
# Deploys the connected app behind the Flow_Tooling_API named credential to
# a development org.
#
# The consumer key and secret live in ~/.config/tributary/dev-oauth.env
# (mode 0600) and are substituted into a private temporary copy of
# config/dev-auth, so they never reach the repository, the command line or logs.
#
# The app signs in with the OAuth client credentials flow, running as the
# org user given here (it needs API access and permission to manage flows).
#
# Usage: scripts/dev-auth-deploy.sh <org-alias> <contact-email> <run-as-username>
set -euo pipefail
org="${1:?org alias}"
export CONTACT_EMAIL="${2:?contact email}"
export RUN_AS_USER="${3:?run-as username}"
secrets="${SECRETS_FILE:-$HOME/.config/tributary/dev-oauth.env}"

here="$(cd "$(dirname "$0")/.." && pwd)"
ORG_URL="$(sf org display --target-org "$org" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["instanceUrl"])')"
export ORG_URL

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r "$here/config/dev-auth/." "$work/"

set -a
# shellcheck disable=SC1090
. "$secrets"
set +a
python3 - "$work" <<'PY'
import os, pathlib, string, sys
for path in pathlib.Path(sys.argv[1]).rglob("*"):
    if path.is_file():
        path.write_text(string.Template(path.read_text()).substitute(os.environ))
PY

sf project deploy start --metadata-dir "$work" --target-org "$org" --wait 10
