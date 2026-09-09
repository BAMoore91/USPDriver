#!/usr/bin/env python3
"""Driver metadata checks that XML well-formedness does not cover.

PackageDriver schema-validates the XML but never looks at the script, so a
function whose export does not exist only fails on hardware. And a variable
that is well-formed can still be useless in Integration Designer if it shows
as a generic numbered row instead of the output the installer configured.
"""
import re
import sys
import xml.etree.ElementTree as ET

failures = []


def check(name, cond, detail=""):
    if cond:
        print("  ok   - " + name)
    else:
        failures.append(name)
        print("  FAIL - " + name + ("  [" + detail + "]" if detail else ""))


script = open("USP_Driver.js", encoding="utf-8").read()
defined = set(re.findall(r"^function\s+([A-Za-z_$][\w$]*)\s*\(", script, re.M))

# 1. Every function Integration Designer can call must exist in the script.
funcs = ET.parse("SystemFunctions.xml").getroot()
missing = []
total = 0
for fn in funcs.iter("function"):
    total += 1
    export = fn.get("export", "").split(":")[0]
    if export not in defined:
        missing.append(fn.get("name") + " -> " + export)
check("every SystemFunctions export exists in USP_Driver.js (%d functions)" % total,
      not missing, "; ".join(missing))

# 2. Hidden parameters must come last, or Integration Designer leaves disabled
#    gaps mid-list, and an export's arg order stops matching the script.
bad_order = []
for fn in funcs.iter("function"):
    seen_hidden = False
    for prm in fn.findall("parameter"):
        hidden = (prm.get("hidden", "").lower() == "true")
        if seen_hidden and not hidden:
            bad_order.append(fn.get("name"))
            break
        seen_hidden = seen_hidden or hidden
check("hidden parameters come last in every function", not bad_order, "; ".join(bad_order))

# 3. Per-output / per-source variables must be named from the config slot and
#    hidden past the configured count, so the list matches the real system.
variables = ET.parse("SystemVariables.xml").getroot()
by_sysvar = {v.get("sysvar"): v for v in variables.iter("variable")}


def check_slot_named(prefix, slot, suffix, count_var, n):
    bad = []
    for i in range(1, n + 1):
        v = by_sysvar.get("%s%d" % (prefix, i))
        if v is None:
            bad.append("%s%d missing" % (prefix, i))
            continue
        want_name = "%%%%%s%d%%%% %s" % (slot, i, suffix)
        want_cond = "$%s >= %d" % (count_var, i)
        if v.get("name") != want_name:
            bad.append("%s%d name=%r" % (prefix, i, v.get("name")))
        if v.get("condition") != want_cond:
            bad.append("%s%d condition=%r" % (prefix, i, v.get("condition")))
    check("%s1..%d named from %s slots and conditioned on %s"
          % (prefix, n, slot, count_var), not bad, "; ".join(bad[:4]))


check_slot_named("OutSrc", "O", "Source", "OutputCount", 64)
check_slot_named("SrcSel", "I", "Selected", "InputCount", 64)

# 4. Config slots the script reads must actually be declared.
settings = {s.get("variable") for s in ET.parse("ConfigSettings.xml").getroot().iter("setting")}
for slot in ("O64", "I64", "C16", "L32", "MX16", "VW16", "WL16", "PL16", "IPAddress", "USPPort"):
    check("config slot %s declared" % slot, slot in settings)

print("")
if failures:
    print("%d METADATA FAILURE(S)" % len(failures))
    sys.exit(1)
print("All metadata checks passed.")
