"""Read GlobalSettings UnitScaleFactor from binary or ASCII FBX (cm per unit; 100 = meters)."""
import re
import struct
import sys


def unit_scale_factor(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if data.startswith(b"Kaydara FBX Binary"):
        i = data.find(b"UnitScaleFactor")
        if i < 0:
            return 1.0
        j = i + len(b"UnitScaleFactor")
        for _ in range(3):  # "double", "Number", ""
            if data[j:j + 1] != b"S":
                break
            n = struct.unpack("<I", data[j + 1:j + 5])[0]
            j += 5 + n
        if data[j:j + 1] == b"D":
            return struct.unpack("<d", data[j + 1:j + 9])[0]
        return 1.0
    m = re.search(rb'"UnitScaleFactor",\s*"double",\s*"Number",\s*"[^"]*",\s*([-\d.eE+]+)', data)
    return float(m.group(1)) if m else 1.0


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(unit_scale_factor(p), p)
