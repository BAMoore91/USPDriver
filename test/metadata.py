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
for slot in ("O64", "I64", "C16", "L32", "MX16", "VW16", "WL16", "PL16", "IPAddress",
             "USPPort", "LabelSep"):
    check("config slot %s declared" % slot, slot in settings)

# 5. Autoprogramming tags. The scheme is non-standard, so it is pinned here and
#    documented in README/Help; a silent rename would break tagged templates.
manifest = ET.parse("DriverManifest.xml").getroot().find("driver")
apex = manifest.get("minimumApexVersion")
check("manifest declares minimumApexVersion >= 10.0 (autoprogramming is off without it)",
      apex is not None and tuple(int(x) for x in apex.split(".")) >= (10, 0), repr(apex))

fn_tags = {}          # tag -> what carries it, for commands
for fn in funcs.iter("function"):
    if fn.get("buttontag"):
        fn_tags.setdefault(fn.get("buttontag"), []).append(fn.get("name"))
    for prm in fn.findall("parameter"):
        for ch in prm.findall("choice"):
            if ch.get("buttontag"):
                fn_tags.setdefault(ch.get("buttontag"), []).append(
                    "%s / %s" % (fn.get("name"), ch.get("value")))

var_tags = {}
for v in variables.iter("variable"):
    if v.get("buttontag"):
        var_tags.setdefault(v.get("buttontag"), []).append(v.get("sysvar"))

def check_series(tag_fmt, n, in_commands=True, reversed_var=None):
    label = tag_fmt % 1 + ".." + tag_fmt % n
    missing = [tag_fmt % i for i in range(1, n + 1)
               if (tag_fmt % i) not in (fn_tags if in_commands else var_tags)]
    check("%s tagged on %s" % (label, "commands" if in_commands else "variables"),
          not missing, "missing " + ", ".join(missing[:4]))
    if reversed_var:
        bad = []
        for i in range(1, n + 1):
            v = by_sysvar.get("%s%d" % (reversed_var, i))
            if v is None or v.get("buttontag") != tag_fmt % i:
                bad.append("%s%d buttontag=%r" % (reversed_var, i, v and v.get("buttontag")))
            elif v.get("tagtype") != "reversed":
                bad.append("%s%d tagtype=%r" % (reversed_var, i, v.get("tagtype")))
        check("%s drives %s Reversed state" % (label, reversed_var), not bad, "; ".join(bad[:4]))

def check_text_series(tag_fmt, sysvar, n):
    """String variables carrying a buttontag attach to the tagged button's
    text. tagtype is boolean-only, so it must NOT be set on these."""
    label = tag_fmt % 1 + ".." + tag_fmt % n
    bad = []
    for i in range(1, n + 1):
        v = by_sysvar.get("%s%d" % (sysvar, i))
        if v is None or v.get("buttontag") != tag_fmt % i:
            bad.append("%s%d buttontag=%r" % (sysvar, i, v and v.get("buttontag")))
        elif v.get("type") != "string":
            bad.append("%s%d type=%r" % (sysvar, i, v.get("type")))
        elif v.get("tagtype"):
            bad.append("%s%d has tagtype=%r (boolean-only)" % (sysvar, i, v.get("tagtype")))
    check("%s supplies %s button text" % (label, sysvar), not bad, "; ".join(bad[:4]))


check_text_series("InputName%d", "InName", 64)      # input name on the button
check_text_series("DisplayName%d", "OutName", 64)   # the display itself
check_text_series("SourceName%d", "OutSrc", 64)     # what that display is subscribed to
check_text_series("RouteToDisplay%d", "OutLabel", 64)  # name + source on the command tag

check_text_series("MVIDWinSource%d", "WinSrc", 16)   # source in each multiview window


def check_text_single(tag, sysvar):
    v = by_sysvar.get(sysvar)
    ok = (v is not None and v.get("buttontag") == tag
          and v.get("type") == "string" and not v.get("tagtype"))
    check("%s supplies %s button text" % (tag, sysvar), ok,
          repr(v is not None and (v.get("buttontag"), v.get("type"), v.get("tagtype"))))


check_text_single("SelectedInputName", "LiveSource")
check_text_single("SelectedDisplayName", "LiveDisplay")
check_text_single("SelectedDisplaySource", "LiveDisplaySource")

check_series("SelectInput%d", 64, reversed_var="SrcSel")     # arm a matrix source
check_series("RouteToDisplay%d", 64)                         # route it to a destination
check_series("MVIDInput%d", 64)                              # route into the armed window
check_series("SelectWinID%d", 16, reversed_var="WinSel")     # arm a multiview window

# A command tag must resolve to exactly one command, or autoprogramming is
# ambiguous. Variables may share a tag with a command (that is how a Reversed
# state attaches), so the two namespaces are checked separately.
dupe_fn = {t: w for t, w in fn_tags.items() if len(w) > 1}
check("each command tag maps to exactly one command", not dupe_fn,
      "; ".join("%s -> %s" % (t, w) for t, w in list(dupe_fn.items())[:3]))
dupe_var = {t: w for t, w in var_tags.items() if len(w) > 1}
check("each variable tag maps to exactly one variable", not dupe_var,
      "; ".join("%s -> %s" % (t, w) for t, w in list(dupe_var.items())[:3]))

print("")
if failures:
    print("%d METADATA FAILURE(S)" % len(failures))
    sys.exit(1)
print("All metadata checks passed.")
