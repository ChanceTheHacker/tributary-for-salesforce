#!/usr/bin/env bash
# Deploys force-app to an org and runs Tributary's Apex tests.
#
# The source is written for the trib package: the Flow_Tooling_API named and
# external credentials point at login.salesforce.com, a placeholder the Setup
# page's "Point it at this org" replaces in a subscriber org, and both
# permission sets name the credential's principal with the trib__ prefix. A
# private temporary copy gets the target org's My Domain and namespace instead,
# and no project namespace, so the same source deploys to tributary-dev, trib-ns
# or any other test org ready to use.
#
# Extra arguments go to sf project deploy start, e.g. --dry-run.
#
# Usage: scripts/deploy-to.sh <org-alias> [deploy options...]
set -euo pipefail
org="${1:?org alias}"
shift
from_url="https://login.salesforce.com"
from_ns="trib"
tests=(
    FlowCompareControllerTest
    FlowCompareSetupControllerTest
    FlowGovernanceControllerTest
    FlowGovernanceServiceTest
    FlowGovernanceOperationTest
    FlowToolingClientTest
)

here="$(cd "$(dirname "$0")/.." && pwd)"
# Prints one value from sf's JSON result, given a path like records.0.Name.
# sf may print a warning before the JSON.
result() {
    python3 -c '
import json, sys
text = sys.stdin.read()
value = json.loads(text[text.index("{"):])["result"]
for key in sys.argv[1].split("."):
    value = value[int(key)] if isinstance(value, list) else value[key]
print(value or "")' "$1"
}
url="$(sf org display --target-org "$org" --json | result instanceUrl)"
ns="$(sf data query --target-org "$org" --query "SELECT NamespacePrefix FROM Organization" --json | result records.0.NamespacePrefix)"
principal="${ns:+${ns}__}Flow_Tooling_API-AppIdentity"
echo "Deploying to $org ($url, namespace ${ns:-none})"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r "$here/sfdx-project.json" "$here/.forceignore" "$here/force-app" "$work/"
sed -i 's|"namespace": *"[^"]*"|"namespace": ""|' "$work/sfdx-project.json"
cd "$work/force-app/main/default"
sed -i "s|$from_url|$url|" \
    namedCredentials/Flow_Tooling_API.namedCredential-meta.xml \
    externalCredentials/Flow_Tooling_API.externalCredential-meta.xml
sed -i "s|${from_ns}__Flow_Tooling_API-AppIdentity|$principal|" \
    permissionsets/Flow_Compare_Admin.permissionset-meta.xml \
    permissionsets/Flow_Compare_User.permissionset-meta.xml
cd "$work"
sf project deploy start --source-dir force-app --target-org "$org" \
    --test-level RunSpecifiedTests --tests "${tests[@]}" --wait 30 "$@"
