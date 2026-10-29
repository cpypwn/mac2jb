#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "abi.glsl"

const uint DIGITS[10] = uint[10](63u, 6u, 91u, 79u, 102u, 109u, 125u, 7u, 127u, 111u);
const uint POWERS[10] = uint[10](1u, 10u, 100u, 1000u, 10000u, 100000u, 1000000u, 10000000u, 100000000u, 1000000000u);

float box(vec2 p, vec2 center, vec2 halfSize, float radius) {
    vec2 q = abs(p - center) - halfSize + radius;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}

float fill(float distance) {
    return 1.0 - smoothstep(-1.0, 1.0, distance);
}

float segment(vec2 p, vec2 center, vec2 halfSize) {
    return 1.0 - smoothstep(-0.012, 0.012, box(p, center, halfSize, 0.04));
}

float seven(vec2 pixel, vec2 origin, vec2 size, uint mask) {
    vec2 p = (pixel - origin) / size;
    if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, vec2(1.0)))) return 0.0;
    float value = 0.0;
    if ((mask & 1u) != 0u) value = max(value, segment(p, vec2(0.5, 0.08), vec2(0.32, 0.045)));
    if ((mask & 2u) != 0u) value = max(value, segment(p, vec2(0.86, 0.29), vec2(0.055, 0.18)));
    if ((mask & 4u) != 0u) value = max(value, segment(p, vec2(0.86, 0.71), vec2(0.055, 0.18)));
    if ((mask & 8u) != 0u) value = max(value, segment(p, vec2(0.5, 0.92), vec2(0.32, 0.045)));
    if ((mask & 16u) != 0u) value = max(value, segment(p, vec2(0.14, 0.71), vec2(0.055, 0.18)));
    if ((mask & 32u) != 0u) value = max(value, segment(p, vec2(0.14, 0.29), vec2(0.055, 0.18)));
    if ((mask & 64u) != 0u) value = max(value, segment(p, vec2(0.5, 0.5), vec2(0.32, 0.045)));
    return value;
}

float number(vec2 p, vec2 origin, vec2 size, float step, int count, uint value) {
    if (p.y < origin.y || p.y > origin.y + size.y) return 0.0;
    int index = int(floor((p.x - origin.x) / step));
    if (index < 0 || index >= count) return 0.0;
    uint digit = (value / POWERS[count - index - 1]) % 10u;
    return seven(p, origin + vec2(float(index) * step, 0.0), size, DIGITS[digit]);
}

void main() {
    vec2 p = gl_FragCoord.xy;
    bool ready = c.game.z == 31250000u && (c.game.x != 0u || c.game.y != 0u);
    vec3 mint = ready ? vec3(0.48, 0.97, 0.73) : vec3(1.0, 0.38, 0.33);
    vec3 color = mix(vec3(0.015, 0.07, 0.064), vec3(0.035, 0.12, 0.105), p.y / 1080.0);
    float panel = fill(box(p, vec2(960.0, 540.0), vec2(760.0, 420.0), 30.0));
    color = mix(color, vec3(0.055, 0.16, 0.135), panel);
    float inner = fill(box(p, vec2(960.0, 570.0), vec2(640.0, 142.0), 20.0));
    color = mix(color, vec3(0.022, 0.092, 0.079), inner);

    float cpu = seven(p, vec2(370.0, 815.0), vec2(48.0, 75.0), 57u);
    cpu = max(cpu, seven(p, vec2(427.0, 815.0), vec2(48.0, 75.0), 115u));
    cpu = max(cpu, seven(p, vec2(484.0, 815.0), vec2(48.0, 75.0), 62u));
    float gpu = seven(p, vec2(1370.0, 815.0), vec2(48.0, 75.0), 61u);
    gpu = max(gpu, seven(p, vec2(1427.0, 815.0), vec2(48.0, 75.0), 115u));
    gpu = max(gpu, seven(p, vec2(1484.0, 815.0), vec2(48.0, 75.0), 62u));
    color = mix(color, mint, max(cpu, gpu));
    float arrow = fill(box(p, vec2(960.0, 854.0), vec2(210.0, 6.0), 3.0));
    float head = 1.0 - smoothstep(0.0, 3.0, abs(p.y - 854.0) - (p.x - 1120.0) * 0.34);
    head *= smoothstep(1118.0, 1130.0, p.x) * (1.0 - smoothstep(1175.0, 1188.0, p.x));
    color = mix(color, mint * 0.65, max(arrow, head));

    float counter = number(p, vec2(410.0, 510.0), vec2(82.0, 125.0), 115.0, 10, c.game.x);
    color = mix(color, mint, counter);
    uint phase = ready ? c.game.x % c.game.z : 0u;
    float progress = ready ? float(phase) / float(c.game.z) : 0.0;
    float track = fill(box(p, vec2(960.0, 400.0), vec2(580.0, 14.0), 7.0));
    float barFill = fill(box(p, vec2(380.0 + 580.0 * progress, 400.0), vec2(580.0 * progress, 14.0), 7.0));
    color = mix(color, vec3(0.10, 0.26, 0.22), track);
    color = mix(color, mint, barFill);
    float frequency = number(p, vec2(490.0, 260.0), vec2(48.0, 74.0), 90.0, 8, c.game.z);
    float frames = number(p, vec2(490.0, 160.0), vec2(48.0, 74.0), 90.0, 8, c.game.w);
    color = mix(color, mint * 0.75, max(frequency, frames));
    outColor = vec4(color * (1.0 - c.transition.x), 1.0);
}
