#ifndef FROGGY_GAME_GLSL
#define FROGGY_GAME_GLSL

// Shared board geometry and deterministic traffic.  The compute shader and the
// fragment shader both call fgCarX(), so collisions and drawing cannot disagree.
const float FG_CELL = 64.0;
const float FG_BOARD_X = 544.0;
const float FG_BOARD_Y = 132.0;
const float FG_BOARD_W = 832.0;
const float FG_BOARD_H = 832.0;
const float FG_CAR_LEN = 104.0;
const int FG_COLS = 13;
const int FG_ROWS = 13;
const int FG_GAME_FRAMES = 2700; // 45 seconds at the launcher's 60 Hz convention
const uint FG_ALL_PADS = 31u;

int fgLaneRow(int lane) { return lane < 5 ? lane + 1 : lane + 2; }

int fgRowLane(int row) {
    if (row >= 1 && row <= 5) return row - 1;
    if (row >= 7 && row <= 11) return row - 2;
    return -1;
}

bool fgIsRoad(int row) {
    return (row >= 1 && row <= 5) || (row >= 7 && row <= 11);
}

float fgCellLeft(int col) { return FG_BOARD_X + float(col) * FG_CELL; }
float fgCellTop(int row) { return FG_BOARD_Y + float(12 - row) * FG_CELL; }

bool fgPadCol(int col) { return col == 0 || col == 3 || col == 6 || col == 9 || col == 12; }
int fgPadIndex(int col) { return col / 3; }

float fgLanePhase(int lane) {
    if (lane == 0) return 0.0;
    if (lane == 1) return 340.0;
    if (lane == 2) return 120.0;
    if (lane == 3) return 620.0;
    if (lane == 4) return 250.0;
    if (lane == 5) return 760.0;
    if (lane == 6) return 90.0;
    if (lane == 7) return 420.0;
    if (lane == 8) return 640.0;
    return 180.0;
}

float fgLaneSpeed(int lane) {
    if (lane == 0) return 1.7;
    if (lane == 1) return 2.3;
    if (lane == 2) return 1.3;
    if (lane == 3) return 2.9;
    if (lane == 4) return 2.0;
    if (lane == 5) return 2.5;
    if (lane == 6) return 1.5;
    if (lane == 7) return 3.2;
    if (lane == 8) return 1.9;
    return 2.7;
}

int fgLaneDir(int lane) { return (lane % 2 == 0) ? 1 : -1; }

// Board-local pixels, 0 .. FG_BOARD_W.  Cars wrap around outside the board so
// they appear and disappear past the curbs instead of popping in lanes.
float fgCarX(int lane, int slot, uint tick) {
    float track = FG_BOARD_W + FG_CAR_LEN * 2.0;
    float spacing = track / 3.0;
    float pos = mod(fgLanePhase(lane) + float(slot) * spacing + float(tick) * fgLaneSpeed(lane), track);
    if (fgLaneDir(lane) > 0) return -FG_CAR_LEN + pos;
    return FG_BOARD_W + FG_CAR_LEN - pos;
}

#endif
