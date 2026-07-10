//------------------------------------------------------------------------------
//  sdf_shapes.glsl — the Stage 1 shape shader (annotated sokol-shdc GLSL).
//
//  One shader covers every Stage 1 primitive. Each quad carries its target
//  rounded rect (center + half-size, logical px) and a mode flag:
//
//    mode 0 — fill + border: signed distance to the rounded-rect boundary,
//             smoothstep AA half a device pixel wide; a border (drawn inside
//             the edge, CSS-style) is a mix toward border_color where the
//             distance is within border_width of the edge.
//    mode 1 — drop shadow: Evan Wallace's closed-form Gaussian rounded-rect
//             approximation ("Fast Rounded Rectangle Shadows", madebyevan.com):
//             exact 1D convolution along x via an erf approximation, four
//             Gaussian samples along y. The quad must be the target rect
//             expanded by 3*sigma.
//
//  Regenerate the checked-in .zig artifact with `zig build shaders`.
//------------------------------------------------------------------------------
@vs vs
layout(binding=0) uniform vs_params {
    vec2 fb_size;    // framebuffer size, device px
    float dpi_scale; // device px per logical px
};

in vec2 in_pos;          // quad corner, logical px
in vec4 in_rect;         // target rect: center.xy, half_size.xy, logical px
in vec2 in_uv;           // unused until the Stage 2 glyph atlas
in vec2 in_geom;         // x: corner radius; y: border width (mode 0) / sigma (mode 1)
in float in_mode;
in vec4 in_color;        // UBYTE4N in the vertex buffer
in vec4 in_border_color;

out vec2 pos;
out vec4 rect;
out vec2 uv;
out vec2 geom;
out float mode;
out vec4 color;
out vec4 border_color;

void main() {
    vec2 ndc = (in_pos * dpi_scale) / fb_size * 2.0 - 1.0;
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    pos = in_pos;
    rect = in_rect;
    uv = in_uv;
    geom = in_geom;
    mode = in_mode;
    color = in_color;
    border_color = in_border_color;
}
@end

@fs fs
in vec2 pos;
in vec4 rect;
in vec2 uv;
in vec2 geom;
in float mode;
in vec4 color;
in vec4 border_color;

out vec4 frag_color;

// Signed distance from p (rect-local) to a rounded rect of half-size b,
// corner radius r. Negative inside.
float sd_rounded_box(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Polynomial erf approximation (Abramowitz & Stegun 7.1.27 form), per the
// Wallace article. Named erf_approx because MSL has a builtin erf.
vec2 erf_approx(vec2 x) {
    vec2 s = sign(x), a = abs(x);
    x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
    x *= x;
    return s - s / (x * x);
}

float gaussian(float x, float sigma) {
    const float pi = 3.141592653589793;
    return exp(-(x * x) / (2.0 * sigma * sigma)) / (sqrt(2.0 * pi) * sigma);
}

// Exact 1D Gaussian convolution of one scanline of the rounded rect along x:
// the rect's half-width at height y shrinks across the corner circle.
float rounded_shadow_x(float x, float y, float sigma, float corner, vec2 half_size) {
    float delta = min(half_size.y - corner - abs(y), 0.0);
    float curved = half_size.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
    vec2 integral = 0.5 + 0.5 * erf_approx((x + vec2(-curved, curved)) * (sqrt(0.5) / sigma));
    return integral.y - integral.x;
}

// Blurred coverage of the rounded rect at rect-local point p: analytic along
// x, four-sample Gaussian quadrature along y over the +-3 sigma support.
float rounded_shadow(vec2 p, vec2 half_size, float sigma, float corner) {
    float low = p.y - half_size.y;
    float high = p.y + half_size.y;
    float start = clamp(-3.0 * sigma, low, high);
    float end = clamp(3.0 * sigma, low, high);
    float dy = (end - start) / 4.0;
    float y = start + dy * 0.5;
    float value = 0.0;
    for (int i = 0; i < 4; i++) {
        value += rounded_shadow_x(p.x, p.y - y, sigma, corner, half_size) * gaussian(y, sigma) * dy;
        y += dy;
    }
    return value;
}

void main() {
    vec2 p = pos - rect.xy;
    if (mode < 0.5) {
        float d = sd_rounded_box(p, rect.zw, geom.x);
        float aa = fwidth(d) * 0.5;
        vec4 c = color;
        float bw = geom.y;
        if (bw > 0.0) {
            c = mix(color, border_color, smoothstep(-bw - aa, -bw + aa, d));
        }
        float cover = 1.0 - smoothstep(-aa, aa, d);
        frag_color = vec4(c.rgb, c.a * cover);
    } else {
        frag_color = vec4(color.rgb, color.a * rounded_shadow(p, rect.zw, geom.y, geom.x));
    }
}
@end

@program sdf_shapes vs fs
