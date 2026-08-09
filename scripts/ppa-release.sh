#!/usr/bin/env bash
# Build and upload signed source packages to the PPA, one per Ubuntu series.
#
# Run from the repository root, after a release tag. Signing prompts for the
# GPG passphrase, so this script runs on the maintainer's machine, not in CI.
#
#   scripts/ppa-release.sh                  # noble, ppa:xmfcx/colcon
#   SERIES="noble jammy" scripts/ppa-release.sh
#   PPA=ppa:someone/else scripts/ppa-release.sh

set -euo pipefail

PPA=${PPA:-ppa:xmfcx/colcon}
SERIES=${SERIES:-noble}

version=$(python3 -c "import tomllib; print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")

restore() { git checkout --quiet debian/changelog; }
trap restore EXIT

for series in $SERIES; do
    deb_version="${version}ppa1~${series}1"
    cat > debian/changelog <<EOF
colcon-mission-control (${deb_version}) ${series}; urgency=medium

  * New upstream release.

 -- Mete Fatih Cırıt <mfc@autoware.org>  $(date -R)
EOF
    debuild -S -sa
    dput "$PPA" "../colcon-mission-control_${deb_version}_source.changes"
done
