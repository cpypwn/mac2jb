# Console storage policy

Maintenance and research for this fork must never write persistent console storage: NAND/eMMC/UFS, SD, firmware, boot areas, licenses, saves or temporary filesystems. Volatile RAM changes are permitted only when they cannot cause persistent writes. Review side effects before any console operation; continue with local dumps when those effects are unknown. Store all captures and logs on the PC. Preserve the ability to install normal console updates; do not disable UFS firmware updates or change persistent reference-clock settings.

The inherited ns2jb bootstrap/acquisition uses temporary console save files. Packaging the source and testing it offline does not authorize starting that flow. OunceCake attaches to an already held run. A reboot clears volatile patches but does not undo persistent storage changes.
