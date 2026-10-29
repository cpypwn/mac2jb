#version 450
#extension GL_GOOGLE_include_directive : require
layout(location = 0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "abi.glsl"
#include "game.glsl"
#include "text.glsl"
#include "draw.glsl"

const vec3 FG_BG = vec3(0.022, 0.032, 0.075);
const vec3 FG_PANEL = vec3(0.040, 0.058, 0.120);
const vec3 FG_PANEL_EDGE = vec3(0.10, 0.20, 0.28);
const vec3 FG_GRASS = vec3(0.10, 0.36, 0.15);
const vec3 FG_GRASS_L = vec3(0.15, 0.48, 0.20);
const vec3 FG_HEDGE = vec3(0.035, 0.16, 0.065);
const vec3 FG_ROAD_A = vec3(0.125, 0.125, 0.155);
const vec3 FG_ROAD_B = vec3(0.095, 0.095, 0.125);
const vec3 FG_LINE = vec3(0.84, 0.80, 0.55);
const vec3 FG_CYAN = vec3(0.25, 0.82, 0.92);
const vec3 FG_FROG = vec3(0.30, 0.86, 0.30);
const vec3 FG_FROG_L = vec3(0.58, 0.98, 0.44);
const vec3 FG_FROG_D = vec3(0.055, 0.30, 0.10);
const vec3 FG_EYE = vec3(0.96, 0.99, 0.88);
const vec3 FG_PUPIL = vec3(0.02, 0.03, 0.06);
const vec3 FG_YELLOW = vec3(1.0, 0.90, 0.35);
const vec3 FG_LABEL = vec3(0.52, 0.80, 0.95);

float fgBlock(vec2 p, vec2 a, vec2 b) {
    vec2 s = step(a, p) * step(p, b);
    return s.x * s.y;
}

float fgHash(vec2 q) {
    return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 fgCarColor(int lane) {
    if (lane == 0) return vec3(0.90, 0.22, 0.20);
    if (lane == 1) return vec3(0.20, 0.55, 0.95);
    if (lane == 2) return vec3(0.95, 0.75, 0.18);
    if (lane == 3) return vec3(0.70, 0.30, 0.85);
    if (lane == 4) return vec3(0.18, 0.78, 0.70);
    if (lane == 5) return vec3(0.95, 0.45, 0.20);
    if (lane == 6) return vec3(0.35, 0.85, 0.35);
    if (lane == 7) return vec3(0.92, 0.35, 0.65);
    if (lane == 8) return vec3(0.35, 0.55, 0.95);
    return vec3(0.90, 0.85, 0.35);
}

ivec4 fgDigitRect(int d) {
    if (d == 0) return TEXT_D0;
    if (d == 1) return TEXT_D1;
    if (d == 2) return TEXT_D2;
    if (d == 3) return TEXT_D3;
    if (d == 4) return TEXT_D4;
    if (d == 5) return TEXT_D5;
    if (d == 6) return TEXT_D6;
    if (d == 7) return TEXT_D7;
    if (d == 8) return TEXT_D8;
    return TEXT_D9;
}

void fgNumber(vec2 p, vec2 pos, int value, int digits, vec3 tint, inout vec3 color) {
    int divisor = 1;
    for (int i = 1; i < 8; i++) {
        if (i >= digits) break;
        divisor *= 10;
    }
    float x = pos.x;
    for (int i = 0; i < 8; i++) {
        if (i >= digits) break;
        int d = (value / divisor) % 10;
        ivec4 r = fgDigitRect(d);
        color = mix(color, tint, text(p, vec2(x, pos.y), r));
        x += float(r.z) + 4.0;
        divisor /= 10;
        if (divisor < 1) divisor = 1;
    }
}

void fgNumberCentered(vec2 p, float cx, float y, int value, int digits, vec3 tint, inout vec3 color) {
    float width = float(digits) * float(TEXT_D0.z + 4) - 4.0;
    fgNumber(p, vec2(cx - width * 0.5, y), value, digits, tint, color);
}

void fgMiniFrog(vec2 p, vec2 o, float s, bool filled, inout vec3 color) {
    vec3 body = filled ? FG_FROG : vec3(0.08, 0.13, 0.10);
    vec3 dark = filled ? FG_FROG_D : vec3(0.035, 0.065, 0.045);
    vec3 eye = filled ? FG_EYE : vec3(0.18, 0.22, 0.19);
    color = mix(color, dark, fgBlock(p, o + vec2(0.18, 0.28) * s, o + vec2(0.82, 0.92) * s));
    color = mix(color, body, fgBlock(p, o + vec2(0.26, 0.36) * s, o + vec2(0.74, 0.86) * s));
    color = mix(color, body, fgBlock(p, o + vec2(0.16, 0.14) * s, o + vec2(0.42, 0.42) * s));
    color = mix(color, body, fgBlock(p, o + vec2(0.58, 0.14) * s, o + vec2(0.84, 0.42) * s));
    color = mix(color, eye, fgBlock(p, o + vec2(0.21, 0.19) * s, o + vec2(0.37, 0.35) * s));
    color = mix(color, eye, fgBlock(p, o + vec2(0.63, 0.19) * s, o + vec2(0.79, 0.35) * s));
    if (filled) {
        color = mix(color, FG_PUPIL, fgBlock(p, o + vec2(0.26, 0.24) * s, o + vec2(0.32, 0.31) * s));
        color = mix(color, FG_PUPIL, fgBlock(p, o + vec2(0.68, 0.24) * s, o + vec2(0.74, 0.31) * s));
    }
}

void fgDrawCar(vec2 p, vec2 o, int lane, inout vec3 color) {
    // Most screen pixels are outside any given car.  Reject those early so the
    // 10-lane traffic loop stays cheap on the console GPU.
    if (p.x < o.x - 8.0 || p.x > o.x + FG_CAR_LEN + 8.0 ||
        p.y < o.y - 8.0 || p.y > o.y + 48.0) return;

    // Draw into a temporary colour, then clip the whole sprite to the board.
    // The cars keep moving outside the curbs, but their overhang never paints
    // on top of the side panels.
    vec3 carColor = color;
    vec2 a = o;
    vec2 b = o + vec2(FG_CAR_LEN, 40.0);
    vec3 tire = vec3(0.015, 0.018, 0.025);
    carColor = mix(carColor, vec3(0.010, 0.012, 0.020), fgBlock(p, a + vec2(4, 6), b + vec2(4, 6)));
    carColor = mix(carColor, vec3(0.015, 0.020, 0.030), fgBlock(p, a, b));
    carColor = mix(carColor, fgCarColor(lane), fgBlock(p, a + vec2(3, 3), b - vec2(3, 3)));
    carColor = mix(carColor, vec3(0.055, 0.085, 0.130), fgBlock(p, a + vec2(26, 8), b - vec2(26, 8)));
    carColor = mix(carColor, vec3(0.32, 0.52, 0.68), fgBlock(p, a + vec2(30, 11), a + vec2(50, 18)));
    carColor = mix(carColor, vec3(0.32, 0.52, 0.68), fgBlock(p, a + vec2(54, 11), a + vec2(74, 18)));
    carColor = mix(carColor, vec3(0.94, 0.96, 0.86), fgBlock(p, a + vec2(10, 4), b - vec2(10, 35)));
    carColor = mix(carColor, tire, fgBlock(p, a + vec2(14, -3), a + vec2(30, 3)));
    carColor = mix(carColor, tire, fgBlock(p, a + vec2(74, -3), a + vec2(90, 3)));
    carColor = mix(carColor, tire, fgBlock(p, a + vec2(14, 37), a + vec2(30, 43)));
    carColor = mix(carColor, tire, fgBlock(p, a + vec2(74, 37), a + vec2(90, 43)));

    bool right = fgLaneDir(lane) > 0;
    vec2 front = right ? vec2(b.x - 8.0, a.y + 6.0) : vec2(a.x + 2.0, a.y + 6.0);
    vec2 back = right ? vec2(a.x + 2.0, a.y + 6.0) : vec2(b.x - 8.0, a.y + 6.0);
    carColor = mix(carColor, vec3(1.0, 0.96, 0.56), fgBlock(p, front, front + vec2(6, 8)));
    carColor = mix(carColor, vec3(1.0, 0.96, 0.56), fgBlock(p, front + vec2(0, 20), front + vec2(6, 28)));
    carColor = mix(carColor, vec3(0.82, 0.08, 0.08), fgBlock(p, back, back + vec2(6, 8)));
    carColor = mix(carColor, vec3(0.82, 0.08, 0.08), fgBlock(p, back + vec2(0, 20), back + vec2(6, 28)));
    carColor = mix(carColor, vec3(0.98, 0.98, 0.88), fgBlock(p, a + vec2(20, 20), b - vec2(20, 18)));
    float boardClip = fgBlock(p, vec2(FG_BOARD_X, FG_BOARD_Y),
                              vec2(FG_BOARD_X + FG_BOARD_W, FG_BOARD_Y + FG_BOARD_H));
    color = mix(color, carColor, boardClip);
}

void fgDrawHedge(vec2 p, vec2 o, int col, inout vec3 color) {
    color = mix(color, FG_HEDGE, fgBlock(p, o, o + vec2(64)));
    vec2 g = floor((p - o) / 8.0);
    float h = fgHash(g + vec2(float(col) * 3.1, 11.0));
    color = mix(color, vec3(0.065, 0.28, 0.10), fgBlock(p, o, o + vec2(64)) * step(0.58, h));
    color = mix(color, vec3(0.020, 0.090, 0.040), fgBlock(p, o, o + vec2(64, 5)));
    color = mix(color, vec3(0.020, 0.090, 0.040), fgBlock(p, o + vec2(0, 59), o + vec2(64)));
    // A few chunky leaves.
    color = mix(color, vec3(0.10, 0.40, 0.14), fgBlock(p, o + vec2(10, 12), o + vec2(22, 22)));
    color = mix(color, vec3(0.08, 0.34, 0.12), fgBlock(p, o + vec2(38, 30), o + vec2(52, 42)));
    color = mix(color, vec3(0.12, 0.46, 0.16), fgBlock(p, o + vec2(20, 44), o + vec2(30, 52)));
}

void fgDrawPad(vec2 p, vec2 o, bool filled, uint tick, inout vec3 color) {
    color = mix(color, vec3(0.025, 0.10, 0.10), fgBlock(p, o + vec2(5, 5), o + vec2(59, 59)));
    color = mix(color, filled ? vec3(0.95, 0.83, 0.22) : FG_CYAN,
                fgBlock(p, o + vec2(9, 9), o + vec2(55, 55)));
    color = mix(color, filled ? vec3(0.22, 0.72, 0.24) : vec3(0.055, 0.30, 0.40),
                fgBlock(p, o + vec2(13, 13), o + vec2(51, 51)));
    if (filled) {
        fgMiniFrog(p, o + vec2(16, 16), 32.0, true, color);
    } else {
        // Lily-pad notch and a pulsing centre pixel.
        color = mix(color, vec3(0.025, 0.10, 0.10), fgBlock(p, o + vec2(30, 13), o + vec2(34, 26)));
        float pulse = step(0.5, fract(float(tick) / 70.0));
        color = mix(color, pulse > 0.5 ? vec3(0.55, 0.95, 0.85) : vec3(0.20, 0.62, 0.70),
                    fgBlock(p, o + vec2(28, 40), o + vec2(36, 48)));
    }
}

void fgDrawFrog(vec2 p, int col, int row, bool dying, uint tick, inout vec3 color) {
    vec2 o = vec2(fgCellLeft(col), fgCellTop(row));
    color = mix(color, vec3(0.015, 0.035, 0.018), fgBlock(p, o + vec2(10, 50), o + vec2(54, 56)));
    if (dying) {
        float flash = step(0.5, fract(float(tick) / 12.0));
        vec3 body = flash > 0.5 ? vec3(0.70, 0.20, 0.15) : FG_FROG_D;
        color = mix(color, body, fgBlock(p, o + vec2(9, 38), o + vec2(55, 52)));
        color = mix(color, vec3(0.92, 0.50, 0.22), fgBlock(p, o + vec2(14, 40), o + vec2(50, 48)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(18, 18), o + vec2(22, 22)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(26, 18), o + vec2(30, 22)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(18, 26), o + vec2(22, 30)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(26, 26), o + vec2(30, 30)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(38, 18), o + vec2(42, 22)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(46, 18), o + vec2(50, 22)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(38, 26), o + vec2(42, 30)));
        color = mix(color, FG_YELLOW, fgBlock(p, o + vec2(46, 26), o + vec2(50, 30)));
        return;
    }

    // Back legs, body, head, eyes, belly and front feet.  Every edge is a hard
    // pixel edge; no filtering or anti-aliasing is used.
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(8, 38), o + vec2(18, 56)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(46, 38), o + vec2(56, 56)));
    color = mix(color, FG_FROG, fgBlock(p, o + vec2(12, 42), o + vec2(20, 54)));
    color = mix(color, FG_FROG, fgBlock(p, o + vec2(44, 42), o + vec2(52, 54)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(14, 20), o + vec2(50, 50)));
    color = mix(color, FG_FROG, fgBlock(p, o + vec2(17, 23), o + vec2(47, 47)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(14, 10), o + vec2(50, 30)));
    color = mix(color, FG_FROG, fgBlock(p, o + vec2(17, 13), o + vec2(47, 28)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(12, 8), o + vec2(28, 24)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(36, 8), o + vec2(52, 24)));
    color = mix(color, FG_FROG, fgBlock(p, o + vec2(15, 11), o + vec2(25, 21)));
    color = mix(color, FG_FROG, fgBlock(p, o + vec2(39, 11), o + vec2(49, 21)));
    color = mix(color, FG_EYE, fgBlock(p, o + vec2(17, 13), o + vec2(24, 20)));
    color = mix(color, FG_EYE, fgBlock(p, o + vec2(40, 13), o + vec2(47, 20)));
    color = mix(color, FG_PUPIL, fgBlock(p, o + vec2(19, 15), o + vec2(23, 19)));
    color = mix(color, FG_PUPIL, fgBlock(p, o + vec2(42, 15), o + vec2(46, 19)));
    color = mix(color, FG_FROG_L, fgBlock(p, o + vec2(26, 32), o + vec2(38, 44)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(24, 27), o + vec2(40, 29)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(12, 46), o + vec2(24, 54)));
    color = mix(color, FG_FROG_D, fgBlock(p, o + vec2(40, 46), o + vec2(52, 54)));
}

void fgDrawMiniPad(vec2 p, vec2 o, float s, bool filled, inout vec3 color) {
    color = mix(color, vec3(0.02, 0.09, 0.10), fgBlock(p, o, o + vec2(s)));
    color = mix(color, filled ? FG_YELLOW : vec3(0.10, 0.35, 0.45),
                fgBlock(p, o + vec2(3, 3), o + vec2(s - 3.0)));
    if (filled) fgMiniFrog(p, o + vec2(6, 6), s - 12.0, true, color);
}

void main() {
    vec2 p = gl_FragCoord.xy;
    uint mode = c.game.x;
    uint lives = c.game.y;
    uint timer = c.game.z;
    uint pads = c.game.w;
    ivec4 frog = c.piece;
    uint tick = c.stats.y;

    // Dark sky with a chunky checker and a few square stars.
    vec3 color = FG_BG;
    float sky = mod(floor(p.x / 32.0) + floor(p.y / 32.0), 2.0);
    color = mix(color, vec3(0.035, 0.050, 0.110), sky * 0.45);
    float star = step(0.992, fgHash(floor(p / 24.0)));
    color = mix(color, vec3(0.32, 0.52, 0.72), star * 0.55);

    // Side panels.
    color = mix(color, FG_PANEL, fgBlock(p, vec2(40, 140), vec2(500, 980)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(40, 140), vec2(500, 146)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(40, 974), vec2(500, 980)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(40, 140), vec2(46, 980)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(494, 140), vec2(500, 980)));
    color = mix(color, FG_PANEL, fgBlock(p, vec2(1420, 140), vec2(1880, 980)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(1420, 140), vec2(1880, 146)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(1420, 974), vec2(1880, 980)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(1420, 140), vec2(1426, 980)));
    color = mix(color, FG_PANEL_EDGE, fgBlock(p, vec2(1874, 140), vec2(1880, 980)));

    // Board shadow, frame and grass.
    color = mix(color, vec3(0.008, 0.015, 0.035), fgBlock(p, vec2(552, 140), vec2(1384, 972)));
    color = mix(color, vec3(0.045, 0.115, 0.170), fgBlock(p, vec2(534, 122), vec2(1386, 974)));
    color = mix(color, FG_CYAN, fgBlock(p, vec2(540, 128), vec2(1380, 968)));
    color = mix(color, FG_GRASS, fgBlock(p, vec2(544, 132), vec2(1376, 964)));
    color = mix(color, FG_GRASS_L, fgBlock(p, vec2(544, 132), vec2(1376, 964)) *
                step(0.76, fgHash(floor(p / 8.0))));

    // Asphalt.  Each lane gets its own shade so the rows read as separate lanes.
    for (int lane = 0; lane < 10; lane++) {
        int row = fgLaneRow(lane);
        float y = fgCellTop(row);
        vec3 asphalt = (lane % 2 == 0) ? FG_ROAD_A : FG_ROAD_B;
        color = mix(color, asphalt, fgBlock(p, vec2(544, y), vec2(1376, y + 64)));
        color = mix(color, asphalt * 0.82, fgBlock(p, vec2(544, y), vec2(1376, y + 5)));
    }

    // Dashed lane dividers.
    for (int lane = 0; lane < 10; lane++) {
        if (lane < 4 || (lane >= 5 && lane < 9)) {
            float y = fgCellTop(fgLaneRow(lane));
            float dash = step(mod(p.x, 48.0), 24.0);
            color = mix(color, FG_LINE, fgBlock(p, vec2(544, y - 2), vec2(1376, y + 2)) * dash);
        }
    }

    // Curbs at the four road edges.
    color = mix(color, FG_LINE, fgBlock(p, vec2(544, 193), vec2(1376, 199)));
    color = mix(color, FG_LINE, fgBlock(p, vec2(544, 513), vec2(1376, 519)));
    color = mix(color, FG_LINE, fgBlock(p, vec2(544, 577), vec2(1376, 583)));
    color = mix(color, FG_LINE, fgBlock(p, vec2(544, 897), vec2(1376, 903)));
    color = mix(color, vec3(0.72, 0.68, 0.45), fgBlock(p, vec2(544, 196), vec2(550, 516)));
    color = mix(color, vec3(0.72, 0.68, 0.45), fgBlock(p, vec2(1370, 196), vec2(1376, 516)));
    color = mix(color, vec3(0.72, 0.68, 0.45), fgBlock(p, vec2(544, 580), vec2(550, 900)));
    color = mix(color, vec3(0.72, 0.68, 0.45), fgBlock(p, vec2(1370, 580), vec2(1376, 900)));

    // Median grass tufts and flowers.
    for (int col = 0; col < 13; col++) {
        vec2 o = vec2(fgCellLeft(col), fgCellTop(6));
        float h = fgHash(vec2(float(col), 6.0));
        if (h > 0.50) {
            color = mix(color, vec3(0.18, 0.55, 0.22), fgBlock(p, o + vec2(18, 20), o + vec2(24, 28)));
            color = mix(color, vec3(0.18, 0.55, 0.22), fgBlock(p, o + vec2(22, 16), o + vec2(28, 24)));
        }
        if (h > 0.72) {
            color = mix(color, vec3(0.98, 0.82, 0.30), fgBlock(p, o + vec2(40, 34), o + vec2(46, 40)));
            color = mix(color, vec3(0.95, 0.55, 0.65), fgBlock(p, o + vec2(44, 30), o + vec2(48, 34)));
        }
    }

    // Start pad.
    vec2 start = vec2(fgCellLeft(6), fgCellTop(0));
    color = mix(color, vec3(0.025, 0.12, 0.08), fgBlock(p, start + vec2(4, 4), start + vec2(60, 60)));
    color = mix(color, vec3(0.20, 0.60, 0.35), fgBlock(p, start + vec2(8, 8), start + vec2(56, 56)));
    color = mix(color, vec3(0.95, 0.95, 0.75), text(p, start + vec2(3, 44), TEXT_START));

    // Goal row: pads and hedges.
    for (int col = 0; col < 13; col++) {
        vec2 o = vec2(fgCellLeft(col), fgCellTop(12));
        if (fgPadCol(col)) {
            int pad = fgPadIndex(col);
            fgDrawPad(p, o, (pads & (1u << pad)) != 0u, tick, color);
        } else {
            fgDrawHedge(p, o, col, color);
        }
    }

    // Cars.
    for (int lane = 0; lane < 10; lane++) {
        float y = fgCellTop(fgLaneRow(lane)) + 12.0;
        for (int slot = 0; slot < 3; slot++) {
            float x = fgCarX(lane, slot, tick) + FG_BOARD_X;
            if (x + FG_CAR_LEN > FG_BOARD_X && x < FG_BOARD_X + FG_BOARD_W) {
                fgDrawCar(p, vec2(x, y), lane, color);
            }
        }
    }

    // Frog.
    if (mode == 0u || mode == 3u) {
        fgDrawFrog(p, frog.x, frog.y, mode == 3u, tick, color);
    }

    // Title.
    float titleX = 960.0 - float(TEXT_TITLE.z) * 0.5;
    color = mix(color, vec3(0.035, 0.08, 0.10), text(p, vec2(titleX + 4, 28), TEXT_TITLE));
    color = mix(color, FG_YELLOW, text(p, vec2(titleX, 24), TEXT_TITLE));
    fgMiniFrog(p, vec2(titleX - 42, 26), 36.0, true, color);
    fgMiniFrog(p, vec2(titleX + float(TEXT_TITLE.z) + 8, 26), 36.0, true, color);

    // Left HUD.
    color = mix(color, FG_LABEL, text(p, vec2(70, 160), TEXT_SCORE));
    fgNumber(p, vec2(70, 196), int(c.stats.x), 6, FG_YELLOW, color);
    color = mix(color, FG_LABEL, text(p, vec2(70, 290), TEXT_BEST));
    fgNumber(p, vec2(70, 326), int(c.stats.w), 6, vec3(0.62, 0.94, 1.0), color);
    color = mix(color, FG_LABEL, text(p, vec2(70, 460), TEXT_TIME));
    int seconds = (int(timer) + 59) / 60;
    vec3 timeColor = (timer < 600u) ? vec3(1.0, 0.28, 0.22) : vec3(0.94, 0.97, 1.0);
    fgNumber(p, vec2(70, 496), seconds, 2, timeColor, color);
    color = mix(color, FG_LABEL, text(p, vec2(70, 630), TEXT_LIVES));
    for (int i = 0; i < 3; i++) {
        fgMiniFrog(p, vec2(70.0 + float(i) * 46.0, 672), 32.0, i < int(lives), color);
    }
    color = mix(color, FG_LABEL, text(p, vec2(70, 790), TEXT_PADS));
    for (int i = 0; i < 5; i++) {
        fgDrawMiniPad(p, vec2(70.0 + float(i) * 40.0, 830), 32.0, (pads & (1u << i)) != 0u, color);
    }

    // Right HUD.
    color = mix(color, FG_LABEL, text(p, vec2(1460, 160), TEXT_MOVE));
    color = mix(color, vec3(0.70, 0.88, 0.95), text(p, vec2(1460, 204), TEXT_DPAD));
    color = mix(color, vec3(1.0, 0.78, 0.30), text(p, vec2(1460, 280), TEXT_EXIT));
    color = mix(color, FG_LABEL, text(p, vec2(1460, 400), TEXT_FILL));
    color = mix(color, vec3(0.70, 0.94, 0.78), text(p, vec2(1460, 440), TEXT_WIN));
    // Five mini pads under the goal text.
    for (int i = 0; i < 5; i++) {
        fgDrawMiniPad(p, vec2(1460.0 + float(i) * 42.0, 510), 34.0, (pads & (1u << i)) != 0u, color);
    }

    // Dying flash and message.
    if (mode == 3u) {
        float edge = smoothstep(560.0, 1030.0, length(p - vec2(960, 540)));
        color = mix(color, vec3(0.62, 0.025, 0.020), edge * 0.30);
        float flash = step(0.5, fract(float(tick) / 12.0));
        color = mix(color, vec3(0.75, 0.08, 0.06), flash * 0.045);
        float ouchX = 960.0 - float(TEXT_OUCH.z) * 0.5;
        color = mix(color, vec3(0.35, 0.02, 0.02), text(p, vec2(ouchX + 3, 503), TEXT_OUCH));
        color = mix(color, vec3(1.0, 0.72, 0.24), text(p, vec2(ouchX, 500), TEXT_OUCH));
    }

    // Win / game-over panel.
    if (mode == 1u || mode == 2u) {
        color = mix(color, vec3(0.005, 0.010, 0.025), 0.58);
        vec2 a = vec2(280, 330);
        vec2 b = vec2(1640, 780);
        color = mix(color, vec3(0.005, 0.010, 0.025), fgBlock(p, a + vec2(8, 8), b + vec2(8, 8)));
        color = mix(color, mode == 1u ? FG_CYAN : vec3(0.92, 0.28, 0.22), fgBlock(p, a, b));
        color = mix(color, vec3(0.030, 0.050, 0.090), fgBlock(p, a + vec2(8, 8), b - vec2(8, 8)));
        color = mix(color, vec3(0.10, 0.18, 0.26), fgBlock(p, a + vec2(16, 16), a + vec2(18, b.y - a.y - 16)));
        color = mix(color, vec3(0.10, 0.18, 0.26), fgBlock(p, b - vec2(18, b.y - a.y - 16), b - vec2(16, 16)));

        if (mode == 1u) {
            float x = 960.0 - float(TEXT_YOU_WIN.z) * 0.5;
            color = mix(color, vec3(1.0, 0.86, 0.30), text(p, vec2(x, 388), TEXT_YOU_WIN));
        } else {
            float x = 960.0 - float(TEXT_GAME_OVER.z) * 0.5;
            color = mix(color, vec3(1.0, 0.36, 0.28), text(p, vec2(x, 388), TEXT_GAME_OVER));
        }
        float labelX = 960.0 - float(TEXT_OVER_SCORE.z) * 0.5;
        color = mix(color, FG_LABEL, text(p, vec2(labelX, 480), TEXT_OVER_SCORE));
        fgNumberCentered(p, 960.0, 516, int(c.stats.x), 6, FG_YELLOW, color);

        float blink = step(0.5, fract(float(tick) / 60.0));
        vec3 againColor = mix(vec3(0.48, 0.62, 0.68), vec3(0.95, 1.0, 0.86), blink);
        float againX = 960.0 - float(TEXT_PLAY_AGAIN.z) * 0.5;
        color = mix(color, againColor, text(p, vec2(againX, 592), TEXT_PLAY_AGAIN));
        float exitX = 960.0 - float(TEXT_EXIT_BIG.z) * 0.5;
        color = mix(color, vec3(0.78, 0.86, 0.90), text(p, vec2(exitX, 652), TEXT_EXIT_BIG));
    }

    // CRT scanlines and a mild vignette keep the 8-bit arcade feel.
    if (mod(floor(p.y), 4.0) < 1.0) color *= 0.972;
    color *= 1.0 - 0.16 * smoothstep(700.0, 1120.0, distance(p, vec2(960, 540)));

    outColor = vec4(color * (1.0 - c.transition.x), 1.0);
}
