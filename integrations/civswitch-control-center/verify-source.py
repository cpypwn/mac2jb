import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / "vendor" / "CivSwitch-ControlCenter"
PROVENANCE = Path(__file__).with_name("provenance.json")


def verify():
    provenance = json.loads(PROVENANCE.read_text())
    assert provenance["upstream"] == "https://github.com/MatthewKuKanich/CivSwitch-ControlCenter"
    assert provenance["commit"] == "259cbe5e66f2e649a79a16f06db4cdb012017daa"
    assert provenance["version"] == "1.0.0"
    assert provenance["license"] == "MIT"
    listing = (UPSTREAM / "SHA256SUMS").read_bytes()
    assert hashlib.sha256(listing).hexdigest() == provenance["sha256sumsSha256"]
    expected = provenance["files"]
    assert len(expected) == 9
    actual = {path.relative_to(UPSTREAM).as_posix() for path in UPSTREAM.rglob("*") if path.is_file()}
    assert actual == set(expected) | {"SHA256SUMS"}
    for name, digest in expected.items():
        path = UPSTREAM / name
        assert path.is_file() and not path.is_symlink()
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    recorded = {}
    for line in listing.decode().splitlines():
        digest, name = line.split("  ./", 1)
        assert name not in recorded
        recorded[name] = digest
    assert recorded == expected


if __name__ == "__main__":
    verify()
    print("CivSwitch Control Center v1.0.0 source verified")
