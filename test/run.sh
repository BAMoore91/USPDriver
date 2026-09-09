#!/usr/bin/env bash
# Dev verification for the USP-CBOX driver. Not part of the shipped package.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== JS syntax =="
node --check USP_Driver.js

echo "== Behavioral harness =="
node test/run.js

echo "== Driver metadata =="
python3 test/metadata.py

echo "== XML well-formedness =="
if command -v xmllint >/dev/null 2>&1; then
  xmllint --noout ConfigSettings.xml SystemVariables.xml SystemFunctions.xml DeviceDescription.xml DriverManifest.xml
  echo "  xmllint: ok"
else
  python3 - <<'PY'
import xml.dom.minidom, glob
for f in sorted(glob.glob("*.xml")):
    xml.dom.minidom.parse(f)
    print("  ok -", f)
PY
fi
echo "All checks passed."
