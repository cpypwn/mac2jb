// Start with verbose summaries disabled; controller Y toggles the mode.
export const VERBOSE_LOGGING = false;

export function createFspIdentityConfig() {
  // -- Constants and configuration --------------------------------

  var SLOT_SIZE = 0x800;
  var WAVE_READ_SIZE = 0x10000;    // 64 KiB IStorage::Read per wave
  var DIRTY_FILE_SIZE = 0x800000;  // 8 MiB dirty write
  var MAX_CONTROL_WAVES = 20;      // user-capped per launch
  var MAX_COPY_ATTEMPTS = 30;      // per nulWrites step per batch
  var COPY_BATCHES = 3;
  var MAX_ADDRESS_CANDIDATES = 5;
  var MAX_POOL_REFINEMENT_READS = 16;
  var MAX_POOL_ANCHOR_CANDIDATES = 4;
  var MAX_METADATA_ANCHOR_CHECKS = 16;
  var MAX_METADATA_PAGE_PROBES = 16;
  var MAX_ROOT_LAYOUT_SCANS = 4;
  var CANARY_LENGTH = 0x5A0;
  var EXTENT_SIZE = 0x2440;
  var POSITIVE_FILL_SEGMENT = 200;
  var PINNING_ALLOCATION_BYTES = 6960;
  var HEAP_JITTER_BYTES = 192;
  var ALIAS_OFFSET = 0x1400000;    // 20 MiB — alias target
  var MARKER_OFFSET = 0x2340;      // byte offset into cache entry metadata
  var WINDOW_MINIMUM_CACHE_HELD = 0x2600; // reference receive-window floor
  // Extra reference guard applied uniformly to every field copy.
  var FIELD_MINIMUM_CACHE_HELD = 0x2810;
  var CACHE_READ_SIZE = 0x200000;  // 2 MiB widened read
  var CONTROL_SIZE = 0x4000;       // 16 KiB — one cache block
  var ROOT_CAPTURE_SIZE = 0x4D8000;
  var ROOT_CAPTURE_BACK = 0x500000;
  var ROOT_CAPTURE_GAP = 0x28000;
  var ROOT_CAPTURE_CHUNK = 0x28000;
  var ROOT_CAPTURE_CHUNKS = ROOT_CAPTURE_SIZE / ROOT_CAPTURE_CHUNK;
  var CACHE_ALIAS_PREFIX = [
      0x00, 0x00, 0x40, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
      0x01, 0x00
  ];

  // CivSwitchFS original SLEEP offsets in nanoseconds; the canary loop may
  // retune them from measured role spans, within a bounded drift.
  // 2026-11-14: tried the full Slapah/Kurumuz reference schedule for boots 7-8:
  // flip rate collapsed (70% windows, no flip in 12 attempts, retune stalled a
  // canary check for 79s and cleanup failed). Reverted to the hybrid schedule,
  // which lands flips on attempts 1-2.
  var roleDelays = [0, 300000, 350000, 450000, 550000, 650000,
                    1000000, 1200000, 1300000, 1700000];
  // Guard delays after groupReleased, in nanoseconds.
  // Slapah/Kurumuz reference: [0, 150000].
  var guardDelays = [150000, 300000];
  var roleLabels = ["commit", "bottleneck", "frag0", "frag1", "frag2", "frag3",
      "canary", "filler0", "filler1", "release", "guard0", "guard1", "trigger"];
  var roleShort = ["C", "B", "F0", "F1", "F2", "F3", "Y", "X0", "X1", "R",
      "G0", "G1", "T"];
  var throughRoles = ["commit", "frag0", "frag1", "frag2", "frag3"];
  var heldRoles = ["canary", "filler0", "filler1", "guard0", "guard1"];
  var overlapRoles = throughRoles.concat(heldRoles);
  return {
    SLOT_SIZE,
    WAVE_READ_SIZE,
    DIRTY_FILE_SIZE,
    MAX_CONTROL_WAVES,
    MAX_COPY_ATTEMPTS,
    COPY_BATCHES,
    MAX_ADDRESS_CANDIDATES,
    MAX_POOL_REFINEMENT_READS,
    MAX_POOL_ANCHOR_CANDIDATES,
    MAX_METADATA_ANCHOR_CHECKS,
    MAX_METADATA_PAGE_PROBES,
    MAX_ROOT_LAYOUT_SCANS,
    CANARY_LENGTH,
    EXTENT_SIZE,
    POSITIVE_FILL_SEGMENT,
    PINNING_ALLOCATION_BYTES,
    HEAP_JITTER_BYTES,
    ALIAS_OFFSET,
    MARKER_OFFSET,
    WINDOW_MINIMUM_CACHE_HELD,
    FIELD_MINIMUM_CACHE_HELD,
    CACHE_READ_SIZE,
    CONTROL_SIZE,
    ROOT_CAPTURE_SIZE,
    ROOT_CAPTURE_BACK,
    ROOT_CAPTURE_GAP,
    ROOT_CAPTURE_CHUNK,
    ROOT_CAPTURE_CHUNKS,
    CACHE_ALIAS_PREFIX,
    roleDelays,
    guardDelays,
    roleLabels,
    roleShort,
    throughRoles,
    heldRoles,
    overlapRoles
  };
}
