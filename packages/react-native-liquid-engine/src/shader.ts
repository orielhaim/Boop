export const glassShader = `
uniform shader backdrop;
uniform float4 shapeRect[8];
uniform float4 shapeRadii[8];
uniform float4 shapeTransform[8];
uniform int shapeCount;
uniform float mergeRadius;
uniform float4 optics;
uniform float4 colorControls;
uniform float4 lighting;
uniform float4 finish;
uniform float4 extras;
uniform float4 tint;
uniform float4 fallback;
uniform int refractContent;
uniform float3 lightA;
uniform float3 lightB;
uniform int usesShapeMaterials;
uniform float4 shapeMaterials[48];

float contour(float2 p, float4 rect, float4 radii, float4 transform) {
  float2 delta = p - rect.xy;
  float2 q = float2(delta.x * transform.x + delta.y * transform.y,
                    delta.y * transform.x - delta.x * transform.y);
  if (transform.z == 1.0) {
    float2 axes = max(rect.zw, float2(0.01));
    float2 v = q / axes;
    float ellipse = length(v);
    return (ellipse - 1.0) * ellipse / max(length(v / axes), 0.0001)
           - (1.0 - step(0.0001, ellipse)) * min(axes.x, axes.y);
  }
  float2 d = abs(q);
  float radius = q.x < 0.0 ? (q.y < 0.0 ? radii.x : radii.w)
                           : (q.y < 0.0 ? radii.y : radii.z);
  d -= rect.zw - radius;
  float2 corner = max(d, 0.0);
  float edge = length(corner);
  if (transform.z == 2.0) {
    float2 squared = corner * corner;
    edge = sqrt(sqrt(dot(squared, squared)));
  }
  return edge + min(max(d.x, d.y), 0.0) - radius;
}

float2 field(float2 p) {
  float d = contour(p, shapeRect[0], shapeRadii[0], shapeTransform[0]);
  float2 center = shapeRect[0].xy;
  for (int i = 1; i < 8; ++i) {
    if (i >= shapeCount) break;
    float next = contour(p, shapeRect[i], shapeRadii[i], shapeTransform[i]);
    if (mergeRadius <= 0.0) {
      if (next < d) {
        d = next;
        center = shapeRect[i].xy;
      }
    } else {
      float mixRatio = clamp(0.5 + (next - d) * 0.5 / mergeRadius, 0.0, 1.0);
      d = mix(next, d, mixRatio) - mergeRadius * mixRatio * (1.0 - mixRatio);
      center = mix(shapeRect[i].xy, center, mixRatio);
    }
  }
  return float2(d, length(p - center));
}

struct Material {
  float4 optics;
  float4 colorControls;
  float4 lighting;
  float4 finish;
  float4 extras;
  float4 tint;
};

Material materialAt(float2 p) {
  if (usesShapeMaterials == 0) return Material(optics, colorControls, lighting, finish, extras, tint);
  Material m = Material(shapeMaterials[0], shapeMaterials[1], shapeMaterials[2],
                        shapeMaterials[3], shapeMaterials[4], shapeMaterials[5]);
  float sd = contour(p, shapeRect[0], shapeRadii[0], shapeTransform[0]);
  for (int i = 1; i < 8; ++i) {
    if (i >= shapeCount) break;
    float next = contour(p, shapeRect[i], shapeRadii[i], shapeTransform[i]);
    float weight = next < sd ? 1.0 : 0.0;
    if (mergeRadius > 0.0) {
      weight = clamp(0.5 + (sd - next) * 0.5 / mergeRadius, 0.0, 1.0);
      sd = mix(sd, next, weight) - mergeRadius * weight * (1.0 - weight);
    } else {
      sd = min(sd, next);
    }
    m = Material(mix(m.optics, shapeMaterials[i * 6], weight),
                 mix(m.colorControls, shapeMaterials[i * 6 + 1], weight),
                 mix(m.lighting, shapeMaterials[i * 6 + 2], weight),
                 mix(m.finish, shapeMaterials[i * 6 + 3], weight),
                 mix(m.extras, shapeMaterials[i * 6 + 4], weight),
                 mix(m.tint, shapeMaterials[i * 6 + 5], weight));
  }
  return m;
}

half3 sampleBackdrop(float2 p) {
  half4 source = backdrop.eval(p);
  return source.rgb + half3(fallback.rgb) * (1.0 - source.a);
}

half3 frost(float2 p, float radius) {
  if (radius <= 0.01) return sampleBackdrop(p);
  float2 x = float2(radius * 0.56, 0.0);
  float2 y = x.yx;
  return sampleBackdrop(p) * 0.28 + (sampleBackdrop(p + x) + sampleBackdrop(p - x)
       + sampleBackdrop(p + y) + sampleBackdrop(p - y)) * 0.12
       + (sampleBackdrop(p + x + y) + sampleBackdrop(p - x + y)
       + sampleBackdrop(p + x - y) + sampleBackdrop(p - x - y)) * 0.06;
}

float diffuse(float2 n, float2 p, float3 light) {
  float2 ray = light.xy - p;
  return max(dot(n, ray / max(length(ray), 0.001)), 0.0) * light.z;
}

half4 main(float2 p) {
  if (shapeCount == 0) return refractContent != 0 ? backdrop.eval(p) : half4(0.0);
  float2 sd = field(p);
  Material m = materialAt(p);
  float coverage = 1.0 - smoothstep(-extras.y, extras.y, sd.x);
  if (coverage <= 0.0) {
    if (refractContent != 0) return backdrop.eval(p);
    float shadow = max(0.0, 1.0 - sd.x / max(extras.z, 0.001));
    return half4(0.0, 0.0, 0.0, m.finish.y * shadow * shadow);
  }

  float2 gradient = float2(field(p + float2(extras.y, 0.0)).x - field(p - float2(extras.y, 0.0)).x,
                           field(p + float2(0.0, extras.y)).x - field(p - float2(0.0, extras.y)).x);
  float2 normal = gradient / max(length(gradient), 0.0001);
  float depth = clamp(-sd.x / max(m.optics.z, 0.001), 0.0, 1.0);
  float slope = (1.0 - depth) * (1.0 - depth);
  float bend = m.optics.y * m.optics.w * slope;
  float magnify = m.extras.x * min(sd.y, m.optics.z) * (1.0 - slope);
  float2 samplePoint = p - normal * (bend + magnify);
  float2 spread = normal * bend * m.finish.w;
  if (refractContent != 0) {
    half4 original = backdrop.eval(p);
    half4 green = backdrop.eval(samplePoint);
    if (m.finish.w <= 0.0 || abs(bend) <= 0.01) {
      return mix(original, green, coverage * m.extras.w);
    }
    half4 red = backdrop.eval(samplePoint + spread);
    half4 blue = backdrop.eval(samplePoint - spread);
    half3 channelAlpha = half3(red.a, green.a, blue.a);
    half alpha = max(red.a, max(green.a, blue.a));
    // Fill only the missing channel coverage with the surface's matte color.
    half3 rgb = half3(red.r, green.g, blue.b) + half3(fallback.rgb) * (alpha - channelAlpha);
    return mix(original, half4(rgb, alpha), coverage * m.extras.w);
  }
  half3 rgb = frost(samplePoint, m.optics.x);
  if (m.finish.w > 0.0 && abs(bend) > 0.01) {
    rgb.r += sampleBackdrop(samplePoint + spread).r - sampleBackdrop(samplePoint).r;
    rgb.b += sampleBackdrop(samplePoint - spread).b - sampleBackdrop(samplePoint).b;
  }

  float gray = dot(float3(rgb), float3(0.2126, 0.7152, 0.0722));
  float chroma = max(rgb.r, max(rgb.g, rgb.b)) - min(rgb.r, min(rgb.g, rgb.b));
  rgb = half3(mix(float3(gray), float3(rgb), m.colorControls.x + m.colorControls.w * (1.0 - chroma)));
  rgb = (rgb - 0.5) * m.colorControls.y + 0.5;
  rgb *= m.colorControls.z;
  rgb = mix(rgb, half3(m.tint.rgb), m.tint.a);

  float lit = diffuse(normal, p, lightA) + diffuse(normal, p, lightB);
  float rim = 1.0 - smoothstep(0.0, max(m.lighting.z, 0.001), abs(sd.x));
  float reflection = m.lighting.x * rim * (m.lighting.w + 0.38 * lit);
  float glint = m.lighting.y * pow(min(lit, 1.0), 8.0) * slope * 0.48;
  float grain = (fract(sin(dot(floor(p / extras.y), float2(12.9898, 78.233))) * 43758.5453) - 0.5) * m.finish.z;
  rgb *= 1.0 - m.finish.x * slope * (1.0 - min(lit, 1.0)) * 0.42;
  rgb += half3(reflection + glint + grain);
  float alpha = coverage * m.extras.w;
  return half4(clamp(rgb, 0.0, 1.0) * alpha, alpha);
}
`;
